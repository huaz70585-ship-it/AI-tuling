import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { queryAll, queryOne, run } from '../db.js'
import { ok, err } from '../utils/response.js'
import { authMiddleware } from '../utils/auth.js'
import { chatOnce, extractJson, aiReady } from '../utils/ai.js'
import { recalcTripBudget } from '../utils/tripStore.js'

const router = Router()

// 交通衔接都要登录
router.use(authMiddleware)

/** 前端能识别的交通方式（其余一律归 unknown） */
const MODES = new Set(['walk', 'bus', 'metro', 'taxi', 'bike', 'coach'])

/**
 * 「整项就是一个抽象词」的行程项，没有任何可定位的地名，估不了交通。
 * 注意只匹配【清洗后整体等于】这些词的情况：
 * 「返程」→ 命中；「抵达虹桥 · 酒店寄存」→ 不命中（含真实地名虹桥）。
 *
 * 命中的项默认整段跳过。唯一的例外是「完全没有任何地点线索的收尾项」
 * （见 BARE_CLOSING）：它虽然没有地名，但语义明确 —— 一定是去当地的火车站/机场，
 * 能按占位符交给 AI 估。
 */
const ABSTRACT_ONLY =
  /^(返程|回程|回家|出发|结束|离开|退房|入住|寄存|收拾行李|自由活动|休息|待定|早餐|午餐|晚餐|夜宵)$/

/** 去掉价格括号（「灵隐寺（45）」→「灵隐寺」）与装饰性分隔符 */
function placeName(title) {
  return String(title)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[·・]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isAbstract(title) {
  const compact = placeName(title).replace(/[\s,，、。.]/g, '')
  if (compact.length < 2) return true
  return ABSTRACT_ONLY.test(compact)
}

/**
 * 喂给 AI 的「返程占位符」。
 *
 * 背景：AI 生成的返程项就是「返程（免费）」这种纯抽象词 —— 没有地名，AI 不知道
 * 该往哪估，所以过去整段被跳过，时间轴上「最后一站 → 返程」没有任何交通提示。
 * 但这一段的语义是确定的：去当地的火车站或机场。所以这里把它改写成一个
 * 可解释的占位串交给模型（实测 200-500ms 能给出合理时长，见下）。
 * 不落库：占位符只出现在发给 AI 的输入里，返回给前端的是原始 title + kind 标记。
 */
const RETURN_PLACEHOLDER = '返程：前往当地的火车站或机场'

/**
 * 这一项是不是「完全没有任何地点线索的收尾项」—— 只有这些才需要换成占位符。
 *
 * 判据是【清洗后整体等于】下面某个词。踩过的坑：一开始想复用 isAbstract() 来判，
 * 但 ABSTRACT_ONLY 里根本没有「送机」「散团」—— 于是这些标题被当成普通地点原样
 * 交给 AI，占位符永远不生效（单测 15 条里 4 条不符）。独立词表才准。
 *
 * 正例：返程 / 回程 / 回家 / 离程 / 送机 / 送站 / 去机场 / 散团（都零线索，套占位符）
 * 反例：虹桥站返程 / 送机到浦东机场（标题已写明去哪，原样交给 AI 更好）
 * 反例：退房 / 自由活动（是抽象词但不是收尾动作，照旧整段跳过）
 *
 * 与 tripBoundary.js 的 CLOSING_ITEM 分工不同、词表也不完全重合，别合并：
 *   那边判「这一项挂的位置是不是越界了」，需要尽量宽（含「返邕」「行程结束」等）；
 *   这边判「要不要把它替换成占位符再发出去」，需要尽量严（只有零线索的才替换）。
 */
const BARE_CLOSING =
  /^(返程|回程|返家|回家|离程|送机|送站|去机场|去火车站|去高铁站|散团|结束|结束行程|行程结束|离开|出发)$/

function isBareClosing(title) {
  return BARE_CLOSING.test(placeName(title).replace(/[\s,，、。.]/g, ''))
}

/**
 * 兜底清洗：prompt 里明令禁止输出线路编号，但模型不保证 100% 听话。
 * 实测收紧 prompt 后泄漏为 0，这一层是防回归用的。
 */
function scrubRouteNo(text) {
  return String(text)
    .replace(/\d{1,3}\s*号线/g, '地铁')
    .replace(/(?<![\dA-Za-z])\d{1,3}\s*路(?![线])/g, '公交')
    .replace(/(地铁){2,}/g, '地铁')
    .replace(/(公交){2,}/g, '公交')
    .replace(/^地铁乘/g, '乘地铁')
    .replace(/\s+/g, ' ')
    .trim()
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/**
 * system prompt —— 这版是实测收敛过的：
 * 初版只说"不要编造线路号"，模型照样输出「11号线转2号线」；
 * 改成"铁律 · 违反即失败"并给出正反例后，13 段泄漏为 0。
 */
const HOP_SYSTEM = `你是旅行行程的「交通衔接」助手。用户会给你某一天按时间排序的地点序列，你只需判断【相邻两个地点之间】用什么交通方式最合理。

严格要求：
1. 只输出 JSON，不要任何解释、不要 markdown 代码块以外的文字。
2. 输出格式：{"hops":[{"from":"起点名","to":"终点名","mode":"walk|bus|metro|taxi|bike|coach","duration_min":数字,"cost":数字,"tip":"不超过15字的一句提醒","steps":[{"icon":"walk|metro|bus|taxi|bike|coach|exit|transfer","text":"..."}],"alts":[{"mode":"...","duration_min":数字,"cost":数字,"steps":[{"icon":"...","text":"..."}]}]}]}
3. hops 数量必须等于「地点数 - 1」，顺序与输入顺序严格一致。
4. duration_min 是不含等待的纯在途时间，填整数分钟；cost 是【每人】预估花费（元，整数，免费填 0）。
5. 【铁律 · 违反即失败】你没有实时地图数据，具体线路可能不准，但**用户明确要看「几号线到几号、哪站下、哪个口出」**：
   - steps 里可以写具体线路/站点/出口（如「乘地铁2号线坐5站」「人民广场换乘10号线」「南京东路站3号口出步行3分钟」），但拿不准的用「地铁」「公交」泛称，不要编造离谱站名。
   - tip 里不要写线路编号，也【不要写具体金额】（如"打车约35元"）——费用模型估不准，写死会让用户现场对不上账；tip 只写时长或一句注意事项（如"打车约15分钟"）。
   - 距离近、在同一景区内的景点（寺庙群、园林群），正确答案通常是 walk，不要强行推荐地铁或公交。
   - 【文案粒度--不许偷懒只写""乘公交前往XX""】：
     · 公交/地铁：写清「乘X路公交 / 地铁X号线，XX站上车→XX站下车，哪个口出」；站名拿不准可用泛称，但线路号必须给；
     · 步行：写清朝向和大致时长（如「沿民族大道向东步行约10分钟」）；
     · 打车：tip 只保留「约X分钟」，不写金额。
   - 拿不准时长就按常识给合理区间中值，不要给 0。
6. 若某个地点写成「返程：前往当地的火车站或机场」，说明这一段是行程末尾前往车站/机场
   （用户可能坐高铁也可能坐飞机）：按市内交通给合理时长，不确定就按打车估；
   tip 里提一句预留取票安检时间。不要反问，也不要输出具体车次/航班号。
7. alts 是这段路除主选 mode 外用户也可以选的 2~3 个备选交通方式：同样填 mode/duration_min/cost
   和 steps（与主选同规则）。按「对普通人而言的性价比/体验」排序；不要包含与主选相同的方式，
   拿不准备选的时长/费用就按常识给合理值，不要给 0。
8. steps 是这条路的**详细分步走法**，3~6 步，每步是一个对象 {"icon":"动作","text":"一句话"}，按先后顺序：
   - icon 只允许这 8 个值：walk(步行) / metro(乘地铁) / bus(乘公交) / taxi(打车) / bike(骑行) / coach(城际巴士) / exit(出站口) / transfer(换乘)。
   - text 不超过 20 字，写清这一段的线路/站点/出口，例如：
     {"icon":"walk","text":"步行500米到朝阳广场站"}、{"icon":"metro","text":"乘1号线坐5站"}、
     {"icon":"transfer","text":"金湖广场站换乘3号线"}、{"icon":"exit","text":"青秀站D口出站"}。
   - 乘车段用对应交通 icon，换乘单独用 transfer，出站单独用 exit，进站前的步行用 walk。
   - 纯步行/骑行可简化成 1~2 步（icon 用 walk / bike）。拿不准站名用「地铁某站」泛称，别编造离谱站名。`

/** 同一对项并发只算一次（多人同时打开同一行程时，避免重复烧 token） */
const inflight = new Map()

/** 步骤动作图标的合法值（前端据此匹配 SVG 图标） */
const STEP_ICONS = new Set(['walk', 'metro', 'bus', 'taxi', 'bike', 'coach', 'exit', 'transfer'])

/**
 * 分步走法归一化：统一成 [{"icon":"动作","text":"一句话"}]。
 * - icon 只留 STEP_ICONS 里的值，其余归 walk；
 * - text 压缩空白、限长 20 字、去空；
 * - 最多 6 步。
 * 兼容纯字符串数组（本功能早期版本的结构：`["乘地铁2号线坐5站", ...]`）：
 * 字符串当作 text、icon 归 walk。读侧也要过这一层 —— 老缓存就是字符串数组。
 * 注意：与 tip 不同，text 允许出现线路/站点/出口（用户明确要看「几号线/哪站下/哪个口」），
 * 所以这里不做 scrubRouteNo 的线路号清除。
 */
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return []
  const out = []
  for (const s of steps) {
    // 老数据是纯字符串：转换成 { icon: 'walk', text } 兼容
    if (typeof s === 'string') {
      const t = String(s).replace(/\s+/g, ' ').trim().slice(0, 20)
      if (t) out.push({ icon: 'walk', text: t })
      continue
    }
    const text = String(s?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
    if (!text) continue
    const icon = STEP_ICONS.has(String(s?.icon)) ? String(s.icon) : 'walk'
    out.push({ icon, text })
  }
  return out.slice(0, 6)
}

/** 落库用：归一化后序列化成 JSON 字符串 */
function sanitizeSteps(steps) {
  return JSON.stringify(normalizeSteps(steps))
}

/**
 * 这段缓存的分步走法是否「过期」—— 需要删掉重算。
 * 过期 = 空数组 / 坏 JSON / 还是旧的纯字符串结构（没有 icon，前端渲染不出图标动线）。
 * 之所以不能放着不管：saveHop 是 ON CONFLICT DO NOTHING，
 * 老行不删就永远不会被新结果覆盖，用户会一直看到没有图标的分步或干脆没有分步。
 */
function stepsStale(raw) {
  if (!raw) return true
  let arr
  try {
    arr = JSON.parse(raw)
  } catch {
    return true
  }
  if (!Array.isArray(arr) || !arr.length) return true
  // 任何一项不是 { icon, text } 结构（比如旧字符串数组）都算过期
  return arr.some((s) => typeof s !== 'object' || s === null || !s.text)
}

/**
 * 备选交通清洗：只留合法 mode、数值取整容错、剔除与主选重复的方式、去重、最多 3 项。
 * 每个备选带「怎么走」的 steps（同主推规则清洗）。
 * 返回 JSON 字符串落库；输入不合法时回退空数组。
 */
function sanitizeAlts(alts, mainMode) {
  if (!Array.isArray(alts)) return '[]'
  const seen = new Set()
  const out = []
  for (const a of alts) {
    const mode = MODES.has(String(a?.mode)) ? String(a.mode) : null
    if (!mode || mode === mainMode || seen.has(mode)) continue
    seen.add(mode)
    out.push({
      mode,
      duration_min: clampInt(a?.duration_min, 0, 1440),
      cost_ref: clampInt(a?.cost, 0, 9999),
      steps: normalizeSteps(a?.steps),
    })
  }
  return JSON.stringify(out.slice(0, 3))
}

/** alts 列 → 数组；空 / 坏 JSON 一律回退空数组 */
function parseAlts(raw) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 把模型返回的一段结果落库。UPSERT：老缓存结构过期时原地升级，不留残行 */
function saveHop(tripId, fromId, toId, h) {
  const mode = MODES.has(String(h?.mode)) ? String(h.mode) : 'unknown'
  run(
    `INSERT INTO trip_hops
       (id, trip_id, from_item_id, to_item_id, mode, duration_min, cost_ref, tip, alts, steps, source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'ai', ?)
     ON CONFLICT(from_item_id, to_item_id) DO UPDATE SET
       mode = excluded.mode,
       duration_min = excluded.duration_min,
       cost_ref = excluded.cost_ref,
       tip = excluded.tip,
       alts = excluded.alts,
       steps = excluded.steps,
       source = 'ai',
       created_at = excluded.created_at`,
    [
      randomUUID(),
      tripId,
      fromId,
      toId,
      mode,
      clampInt(h?.duration_min, 0, 1440),
      clampInt(h?.cost, 0, 9999),
      scrubRouteNo(h?.tip || '').slice(0, 40),
      sanitizeAlts(h?.alts, mode),
      sanitizeSteps(h?.steps),
      new Date().toISOString(),
    ],
  )
}

/** 为缺失的段落调一次 AI 并落库 */
async function fetchMissing(tripId, hint, dayIndex, pairs) {
  const seq = pairs
    .map((p, i) => {
      // 收尾段没有真实地名，用占位符告诉模型「这里是去当地车站/机场」
      const to = p.toIsReturn ? RETURN_PLACEHOLDER : placeName(p.to.title)
      return `${i + 1}. ${placeName(p.from.title)} → ${to}（${p.from.start_time} 出发）`
    })
    .join('\n')
  const content = await chatOnce([
    { role: 'system', content: HOP_SYSTEM },
    {
      role: 'user',
      content: `行程参考：${hint}\n第 ${dayIndex} 天，相邻地点序列：\n${seq}\n\n请输出与上述 ${pairs.length} 段一一对应的 hops JSON。`,
    },
  ])
  const parsed = extractJson(content)
  const list = Array.isArray(parsed?.hops) ? parsed.hops : []
  pairs.forEach((p, i) => {
    if (list[i]) saveHop(tripId, p.from.id, p.to.id, list[i])
  })
  return list.length
}

/**
 * GET /trip/:id/hops?day=1
 * 返回某天相邻行程项之间的交通衔接。缓存优先，未命中才调 AI（一次调用算完当天所有缺失段）。
 * AI 不可用时返回 hops 全空 + ai_error，前端静默不展示，不影响主流程。
 */
router.get('/trip/:id/hops', async (req, res) => {
  const tripId = req.params.id
  const trip = queryOne('SELECT id, user_id, title FROM trips WHERE id = ?', [tripId])
  if (!trip) return err(res, '行程不存在', 404)
  if (trip.user_id !== req.user.id) return err(res, '无权访问该行程', 403)

  const dayIndex = Number(req.query.day)
  if (!Number.isInteger(dayIndex) || dayIndex < 1) return err(res, 'day 参数必须是正整数')

  const day = queryOne('SELECT id FROM trip_days WHERE trip_id = ? AND day_index = ?', [tripId, dayIndex])
  if (!day) return err(res, '该天不存在', 404)

  const items = queryAll(
    'SELECT id, sort_order, type, title, start_time FROM trip_items WHERE trip_day_id = ? ORDER BY sort_order',
    [day.id],
  )

  // 相邻配对。起点必须是可定位的地点；终点默认也是 —— 唯一的例外是行程末尾的
  // 「返程」这类收尾项：它没有地名，但语义明确（去当地车站/机场），
  // 按占位符交给 AI 估，见 RETURN_PLACEHOLDER。
  const pairs = []
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i]
    const b = items[i + 1]
    if (isAbstract(a.title)) continue
    const toIsReturn = isBareClosing(b.title)
    if (isAbstract(b.title) && !toIsReturn) continue
    pairs.push({ from: a, to: b, toIsReturn })
  }

  let aiError = null
  if (pairs.length) {
    // 结构过期的老缓存（早期版本没这列，或只存了纯文本步骤）当作「未缓存」重算，
    // 由 saveHop 的 UPSERT 原地升级。不删行是刻意的：AI 失败时旧数据还留着，
    // 用户至少还能看到原本的 tip，而不是交通条整片消失。
    const existing = new Set(
      queryAll('SELECT from_item_id, to_item_id, steps FROM trip_hops WHERE trip_id = ?', [tripId])
        .filter((r) => !stepsStale(r.steps))
        .map((r) => `${r.from_item_id}|${r.to_item_id}`),
    )
    const missing = pairs.filter((p) => !existing.has(`${p.from.id}|${p.to.id}`))

    if (missing.length) {
      if (!aiReady()) {
        aiError = 'AI 未配置'
      } else {
        // 并发去重的 key 必须带上「这一批要算哪些相邻对」。
        // 只用 tripId|dayIndex 的话，移动项之后立刻重发的请求会复用上一个还在飞的
        // 任务（那批 missing 是旧顺序的），新顺序的段会全部返回 mode:null —— 200 无错、
        // 但前端交通条整片消失。实测复现：R1 在飞时改顺序，R2 返回 3 段全 null。
        const key = `${tripId}|${dayIndex}|${missing.map((p) => `${p.from.id}>${p.to.id}`).join(',')}`
        let task = inflight.get(key)
        if (!task) {
          task = fetchMissing(tripId, trip.title || '', dayIndex, missing)
            .finally(() => inflight.delete(key))
          inflight.set(key, task)
        }
        try {
          await task
          // 新落库的交通段带 cost_ref，写进后顺手重算一次总预算（原来只算门票）
          recalcTripBudget(tripId)
        } catch (e) {
          aiError = 'AI 暂时不可用'
          console.error('[hop] AI 生成失败:', e.message)
        }
      }
    }
  }

  // 写完重读一次，保证返回的是库里的最终值（并发下也一致）
  const saved = new Map(
    queryAll('SELECT * FROM trip_hops WHERE trip_id = ?', [tripId])
      .map((r) => [`${r.from_item_id}|${r.to_item_id}`, r]),
  )

  const hops = pairs.map((p) => {
    const r = saved.get(`${p.from.id}|${p.to.id}`)
    return {
      from_item_id: p.from.id,
      to_item_id: p.to.id,
      from_title: placeName(p.from.title),
      to_title: placeName(p.to.title),
      mode: r?.mode || null,
      duration_min: r?.duration_min ?? null,
      cost_ref: r?.cost_ref ?? null,
      tip: r?.tip || '',
      alts: parseAlts(r?.alts).map((a) => ({ ...a, steps: normalizeSteps(a?.steps) })),
      /** 详细分步走法（坐几号线/换乘/哪站下/哪个口），空数组前端退回单句 tip */
      steps: normalizeSteps(parseAlts(r?.steps)),
      source: r?.source || null,
      /**
       * 'return' = 这一段是「最后一站 → 返程」，终点没有真实地名（用占位符估的），
       * 前端据此把目标写成「车站 / 机场」而不是复述「返程」两个字。
       * 不落库：它由 item 标题推导，标题没变结论就不会变。
       */
      kind: p.toIsReturn ? 'return' : null,
    }
  })

  ok(res, {
    trip_id: tripId,
    day: dayIndex,
    hops,
    /** 当日交通合计（仅展示用，不计入 trips.budget_total —— 那是行程项消费口径） */
    total_cost: hops.reduce((s, h) => s + (h.cost_ref || 0), 0),
    total_min: hops.reduce((s, h) => s + (h.duration_min || 0), 0),
    ai_error: aiError,
  })
})

export default router
