import { Router } from 'express'
import { getTripListRows, getTripDetail, run, queryOne, queryAll, transaction } from '../db.js'
import { ok, err } from '../utils/response.js'
import { authMiddleware } from '../utils/auth.js'
import { rateLimit } from '../utils/rateLimit.js'
import { chatOnce, extractJson, aiReady } from '../utils/ai.js'
import { buildAppendDaysMessages, buildRefillDayMessages, buildOptimizeTripMessages } from '../utils/tripPrompt.js'
import { removeStaleBoundaryItems, syncTitleDayCount } from '../utils/tripBoundary.js'
import { resolveCityFromTitle } from '../utils/city.js'
import { todayIso } from '../utils/date.js'
// 边界项（抵达/返程）位置约束：移动接口要拦下把它们挤离首/末的交换
import { boundaryMoveError } from '../utils/boundary.js'
// 人均价解析 / 一天计划落库 / 预算重算 —— 与 agent 的 optimize_trip 工具共用同一套口径
import { createDayItems, writeDayPlan, recalcTripBudget, isPlaceholderTitle } from '../utils/tripStore.js'
// 消息通知（全站唯一写 messages 表的地方）
import { notifyTrip, notifyWeatherAlert, notifyDisclaimer } from '../utils/notify.js'
// 行程天气（保存后 fire-and-forget 查预警用）
import { fetchTripWeather } from '../utils/forecast.js'

const router = Router()

/** 行程天数上限（防止日历里拉出跨年区间，把 trip_days 撑爆） */
const MAX_TRIP_DAYS = 60

/**
 * 单次让 AI 补排的天数上限。
 * 一次要的天越多，输出越长越容易被截断（截断后那些天就只剩空壳），
 * 所以按批切；批与批之间把上一批的结果补进「已有安排」，避免重复景点。
 */
const APPEND_BATCH = 5

const DAY_MS = 86_400_000

/** 两个 YYYY-MM-DD 相差的整天数（取 UTC 正午做锚点，规避时区/夏令时偏移） */
function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS)
}

/** YYYY-MM-DD 加 n 天 */
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 允许的最远出发日：两年后。再远基本是模型算错了（或用户乱说） */
const MAX_START_AHEAD_DAYS = 730

/**
 * 收敛 AI 给的出发日期。
 *
 * 模型的日期是「生成的」，不能直接信：可能缺失、格式错、写成过去，
 * 甚至把「25号」理解成去年的 25 号。这里一律兜到合法值：
 * - 缺失 / 格式不对 / 不是真日期 → 今天
 * - 早于今天 → 今天（否则行程一建出来就是「已结束」，行中模式永远不会触发）
 * - 超过两年 → 今天（异常值，别让日历拉出跨年区间）
 *
 * 注意「早于今天一律收到今天」是刻意的：宁可让用户看到从今天开始，
 * 也不要生成一条过去时间的行程 —— 后者比日期不准更让人困惑。
 */
function normalizeStartDate(raw) {
  const today = todayIso()
  const s = String(raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return today
  // 正则只保证形状，还要挡掉 2026-02-31 这种不存在的日子
  if (Number.isNaN(Date.parse(`${s}T12:00:00Z`))) return today
  if (s < today) return today
  if (s > addDays(today, MAX_START_AHEAD_DAYS)) return today
  return s
}

// 行程相关接口都需要登录
router.use(authMiddleware)

/** POST /v1/trips  从 AI 生成的行程创建（title + start_date + days 摘要数组） */
router.post('/trips', (req, res) => {
  const { title, days } = req.body || {}
  if (!title || !Array.isArray(days) || !days.length) return err(res, '标题与天数必填')
  if (days.length > MAX_TRIP_DAYS) return err(res, `行程最长 ${MAX_TRIP_DAYS} 天`)
  if (String(title).length > 100) return err(res, '标题过长')

  const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6)
  const now = new Date().toISOString()
  // 出发日期由 AI 按用户说的推算（见 chat.js 的 prompt），这里只做兜底校验。
  // 全部日期运算走 addDays(iso, n)（UTC 正午锚点），不再用 new Date() + toISOString ——
  // 后者是 UTC，东八区凌晨会整体偏一天。
  const startIso = normalizeStartDate(req.body?.start_date)
  // 目的地城市：从标题解析出【内置城市】则写入 destination_id，
  // 让天气定位（weather.js）在步骤 1 直接命中，不靠标题匹配 —— 更稳。
  // 标题不在内置 4 城时 destination_id 留空，靠步骤 2/3 的名字匹配兜底。
  const dest = resolveCityFromTitle(title)
  const destinationId = dest?.row ? dest.row.id : null
  // 全部项目的人均价累计（× 计费人数就是总预算）
  let personTotal = 0

  // 一次创建 = 1 条 trips + N 条 trip_days + M 条 trip_items + 1 次预算回写。
  // 不用事务的话，中途抛错会留下半截行程（有天数没项目、或预算没落库）且无法收拾。
  transaction(() => {
    run(
      'INSERT INTO trips (id, user_id, title, destination_id, start_date, end_date, day_count, status, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, req.user.id, title, destinationId, startIso, addDays(startIso, days.length - 1), days.length, 'ready', 'ai', now],
    )

    days.forEach((d, i) => {
      const dId = id + '-d' + (i + 1)
      // trip_days.title 存当天概览，trip_items 存拆分后的各景点/活动
      run('INSERT INTO trip_days (id, trip_id, day_index, date, title) VALUES (?,?,?,?,?)', [dId, id, i + 1, addDays(startIso, i), String(d)])
      // 拆分与人均价解析统一走 createDayItems（与「日期变长后补排」同一套口径）
      personTotal += createDayItems(id, dId, String(d))
    })

    // 总预算 = 全部项目人均价之和 × 计费人数。新建行程默认 1 位成人（权重 1），
    // 之后在详情页改人数时，PATCH /trip/:id 会按新权重等比重算。
    run('UPDATE trips SET budget_total = ? WHERE id = ?', [Math.round(personTotal * 1), id])
  })

  // 通知：保存成功 → 行程消息；该用户第一条行程再补一条 AI 免责声明。
  notifyTrip(req.user.id, { title, preview: `共 ${days.length} 天行程，可随时查看或继续调整` })
  if (!queryAll('SELECT id FROM trips WHERE user_id = ?', [req.user.id]).length) {
    notifyDisclaimer(req.user.id)
  }

  // 天气预警：查 Open-Meteo 要走网络（最长 8s），fire-and-forget —— 保存响应不等它。
  // 行程期间有雨/雪/雷/雾就弹一条系统消息；查不到或没异常天气就静默。
  fetchTripWeather({ title, destination_id: destinationId, start_date: startIso, end_date: addDays(startIso, days.length - 1) })
    .then((w) => {
      if (!w.days.length) return
      const hit = w.days.find((d) => ['rain', 'snow', 'thunder', 'fog'].includes(d.icon))
      if (!hit) return
      const dayNum = diffDays(startIso, hit.date) + 1
      notifyWeatherAlert(req.user.id, title, `D${dayNum}`, hit.text)
    })
    .catch(() => { /* 天气拿不到就不提醒 */ })

  ok(res, { id, title, day_count: days.length })
})

/** GET /v1/trips  行程列表 */
router.get('/trips', (req, res) => {
  const rows = getTripListRows(req.user.id)
  ok(res, rows)
})

/** GET /v1/trip/:id  行程详情全量 */
router.get('/trip/:id', (req, res) => {
  const detail = getTripDetail(req.params.id)
  if (!detail) return err(res, '行程不存在', 404)
  // 仅返回本人行程
  if (detail.user_id !== req.user.id) return err(res, '无权访问', 403)
  ok(res, detail)
})

/** DELETE /v1/trip/:id  删除行程（trip_days/trip_items ON DELETE CASCADE 自动清） */
router.delete('/trip/:id', (req, res) => {
  const detail = getTripDetail(req.params.id)
  if (!detail) return err(res, '行程不存在', 404)
  if (detail.user_id !== req.user.id) return err(res, '无权访问', 403)
  run('DELETE FROM trips WHERE id = ?', [req.params.id])
  ok(res, { id: req.params.id })
})

/** DELETE /v1/trip/:id/item/:itemId  删除单个行程项 */
router.delete('/trip/:id/item/:itemId', (req, res) => {
  const detail = getTripDetail(req.params.id)
  if (!detail) return err(res, '行程不存在', 404)
  if (detail.user_id !== req.user.id) return err(res, '无权访问', 403)
  const item = queryOne('SELECT * FROM trip_items WHERE id = ? AND trip_id = ?', [req.params.itemId, req.params.id])
  if (!item) return err(res, '行程项不存在', 404)
  // 删项 + 重算总预算必须原子：只删不重算，前端底部「本次行程总预算」会停在旧值
  const budget_total = transaction(() => {
    run('DELETE FROM trip_items WHERE id = ?', [req.params.itemId])
    // 涉及被删项的交通衔接一并清掉，否则留下指不到任何行程项的孤立行
    run('DELETE FROM trip_hops WHERE from_item_id = ? OR to_item_id = ?', [
      req.params.itemId,
      req.params.itemId,
    ])
    return recalcTripBudget(req.params.id)
  })
  ok(res, { id: req.params.itemId, budget_total })
})

/** 剥掉结尾的价格括号：「万象城闲逛（免费）」→「万象城闲逛」 */
const bareTitle = (t) => String(t || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim()

/**
 * 让 AI 为指定的几天排行程并落库（内容生成，不含日期/天数的同步）。
 *
 * 分批（每批 ≤ APPEND_BATCH 天）：一次要的天越多，模型输出越容易截断，
 * 截断后那些天就只剩空壳。批与批之间把上一批的结果补进「已有安排」，
 * 避免第二批又把第一批的景点排一遍。
 * 每批独立错误处理 —— 第二批失败不该把第一批已经写好的内容也丢掉。
 *
 * temperature 用 0.7（而不是 ai.js 默认的 0）：补排属于内容生成，
 * 用户对某天不满意点重试时应该拿到不一样的一版；用 0 每次都是同一份。
 *
 * @returns {Promise<{filled:number[], error:string|null}>}
 */
async function planDays({ tripId, title, totalDays, targets, knownDays }) {
  const filled = []
  const known = [...knownDays]

  for (let i = 0; i < targets.length; i += APPEND_BATCH) {
    const batch = targets.slice(i, i + APPEND_BATCH)
    let content = ''
    try {
      content = await chatOnce(
        buildAppendDaysMessages({ title, totalDays, existingDays: known, targets: batch }),
        { temperature: 0.7, timeoutMs: 30_000 },
      )
    } catch (e) {
      console.error('[trip] 补排上游调用失败:', e)
      return { filled, error: partialMessage(filled) || 'AI 补排失败，请稍后重试' }
    }

    const list = extractJson(content)?.days
    if (!Array.isArray(list)) {
      return { filled, error: partialMessage(filled) || 'AI 返回格式异常，请重试' }
    }

    batch.forEach((t, j) => {
      const summary = String(list[j] ?? '').trim()
      if (!summary) return
      if (writeDayPlan(tripId, t.day_index, summary)) {
        filled.push(t.day_index)
        known.push({ day_index: t.day_index, title: summary })
      }
    })
  }

  if (filled.length < targets.length) return { filled, error: partialMessage(filled) }
  return { filled, error: null }
}

/** 部分成功时的提示文案；一天都没成功则返回空串交给调用方给更具体的说法 */
function partialMessage(filled) {
  return filled.length ? '部分天数没排上，可点对应日期重试' : ''
}

/**
 * 给「因为失效边界项（返回/抵达）被摘掉而变短」的某一天补回内容。
 *
 * 只处理不足 3 项的天：摘掉边界项通常只少 1 项，够饱满的天不值得再烧一次 token。
 * 与 planDays 的区别：这些天【已经有内容】，prompt 要求原样保留、只在末尾追加，
 * 所以落库前还要校验原有项目有没有被模型丢掉 —— 丢掉过半就整版丢弃，
 * 宁可停在「摘干净但略短」，也不能把用户已经认可的安排排坏。
 *
 * 导出是为了让「一次性补数据脚本」也能复用同一套口径（见 .workbuddy/fix-stale-boundary.mjs）。
 *
 * @returns {Promise<{filled:number[], error:string|null}>}
 */
export async function fillShortDays({ tripId, title, totalDays, dayIndexes, knownDays }) {
  const filled = []
  const known = knownDays

  for (const dayIndex of dayIndexes) {
    const day = queryOne('SELECT id, title, date FROM trip_days WHERE trip_id = ? AND day_index = ?', [
      tripId,
      dayIndex,
    ])
    if (!day) continue

    const items = queryAll('SELECT title FROM trip_items WHERE trip_day_id = ? ORDER BY sort_order', [
      day.id,
    ]).map((r) => r.title)
    if (items.length >= 3) continue

    let content = ''
    try {
      content = await chatOnce(
        buildRefillDayMessages({
          title,
          totalDays,
          dayIndex,
          date: day.date,
          existingItems: items,
          // 避重上下文里要排除它自己，否则模型会为了「别和已有重复」把本天剩下的一起换掉
          existingDays: known.filter((d) => d.day_index !== dayIndex),
          need: items.length ? Math.max(1, 3 - items.length) : 0,
          isLastDay: dayIndex === totalDays,
        }),
        { temperature: 0.7, timeoutMs: 30_000 },
      )
    } catch (e) {
      console.error('[trip] 补齐变短的天失败:', e)
      return { filled, error: 'AI 补排失败，请稍后重试' }
    }

    const list = extractJson(content)?.days
    const summary = Array.isArray(list) ? String(list[0] ?? '').trim() : ''
    if (!summary) return { filled, error: 'AI 返回格式异常，请重试' }

    // 保真校验：原有项目一个都不许丢（允许换措辞，所以用子串匹配）
    const lost = items.filter((t) => !summary.includes(bareTitle(t))).length
    if (items.length && lost * 2 > items.length) {
      console.error('[trip] 补排丢掉了原有安排，已丢弃:', { dayIndex, items, summary })
      return { filled, error: 'AI 返回的内容没保住原有安排，已保留原样' }
    }

    if (writeDayPlan(tripId, dayIndex, summary)) {
      filled.push(dayIndex)
      const entry = { day_index: dayIndex, title: summary }
      const i = known.findIndex((d) => d.day_index === dayIndex)
      if (i >= 0) known[i] = entry
      else known.push(entry)
    }
  }

  return { filled, error: null }
}

/** PATCH /v1/trip/:id  修改日期 / 出行人数（乐观锁：If-Match: revision，冲突 409） */
router.patch('/trip/:id', async (req, res) => {
  const trip = queryOne('SELECT * FROM trips WHERE id = ?', [req.params.id])
  if (!trip) return err(res, '行程不存在', 404)
  if (trip.user_id !== req.user.id) return err(res, '无权访问', 403)

  // 乐观锁：写操作必须带 If-Match，与当前 revision 一致才放行
  const ifMatch = req.get('If-Match')
  if (!ifMatch) return err(res, '缺少 If-Match 请求头', 428)
  if (Number(ifMatch) !== trip.revision) {
    return err(res, '行程已被修改，请刷新后重试', 409)
  }

  const { start_date, end_date, traveler } = req.body || {}
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  if (start_date !== undefined && !ISO.test(start_date)) return err(res, 'start_date 需为 YYYY-MM-DD')
  if (end_date !== undefined && !ISO.test(end_date)) return err(res, 'end_date 需为 YYYY-MM-DD')

  const nextStart = start_date ?? trip.start_date
  const nextEnd = end_date ?? trip.end_date
  if (nextEnd < nextStart) return err(res, '结束日期不能早于开始日期')

  // 人数：{ adults >= 1, children?: [{ age }] }
  let nextTraveler = trip.traveler
  if (traveler !== undefined) {
    if (typeof traveler !== 'object' || traveler === null) return err(res, 'traveler 格式不正确')
    const adults = Number(traveler.adults)
    if (!Number.isInteger(adults) || adults < 1) return err(res, '成人人数至少 1 人')
    const children = Array.isArray(traveler.children)
      ? traveler.children.map((c) => ({ age: Number(c?.age) || 8 }))
      : []
    const next = children.length ? { adults, children } : { adults }
    nextTraveler = JSON.stringify(next)
  }

  const dayCount = diffDays(nextStart, nextEnd) + 1
  if (dayCount > MAX_TRIP_DAYS) return err(res, `行程最长 ${MAX_TRIP_DAYS} 天`)

  // 天数变了就顺手把标题里的「N日游 / N天」改成新数字（标题里没有天数表述则原样返回）
  const nextTitle = dayCount === trip.day_count ? trip.title : syncTitleDayCount(trip.title, dayCount)

  // 读一次当前的天（放事务外，减少持锁时间）
  const days = queryAll('SELECT * FROM trip_days WHERE trip_id = ? ORDER BY day_index', [trip.id])
  /** 本次因为天数变长而新补出来的天。事务里收集，事务提交后再补内容 */
  const newIndexes = []
  /** 本次被摘掉的失效边界项与其所在天（removeStaleBoundaryItems 在事务里填充） */
  let boundary = { removed: [], days: [] }

  // 主表更新 + 逐日同步必须原子：中途失败会留下「day_count 说 5 天、实际只有 3 条 day」的坏数据
  transaction(() => {
    run(
      'UPDATE trips SET title = ?, start_date = ?, end_date = ?, day_count = ?, traveler = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      [nextTitle, nextStart, nextEnd, dayCount, nextTraveler, new Date().toISOString(), trip.id],
    )

    // 日期变了要同步每一天：已有的改日期，多出的补建，超出的删掉（CASCADE 连带 items）
    for (let i = 0; i < dayCount; i++) {
      const dayIndex = i + 1
      const date = addDays(nextStart, i)
      const exist = days.find((d) => d.day_index === dayIndex)
      if (exist) {
        run('UPDATE trip_days SET date = ? WHERE id = ?', [date, exist.id])
      } else {
        run('INSERT INTO trip_days (id, trip_id, day_index, date, title) VALUES (?,?,?,?,?)', [
          `${trip.id}-d${dayIndex}-${Date.now().toString(36)}`,
          trip.id,
          dayIndex,
          date,
          `D${dayIndex}`,
        ])
        // 只建了个空壳，标题也是占位的 "D3"，内容等事务提交后由 AI 补
        newIndexes.push(dayIndex)
      }
    }
    // 缩短天数会级联删掉那几天的行程项；先清掉它们的交通衔接 ——
    // 子查询必须赶在 trip_days 被删之前跑，删完就查不到 items 了。
    const droppedDays = days.filter((d) => d.day_index > dayCount)
    for (const d of droppedDays) {
      run('DELETE FROM trip_hops WHERE from_item_id IN (SELECT id FROM trip_items WHERE trip_day_id = ?)', [d.id])
      run('DELETE FROM trip_hops WHERE to_item_id IN (SELECT id FROM trip_items WHERE trip_day_id = ?)', [d.id])
    }
    droppedDays.forEach((d) => run('DELETE FROM trip_days WHERE id = ?', [d.id]))

    // 天数一变，行程的边界就被推开了：原来挂在最后一天上的「返程」，在延长后已经
    // 落进行程中段 —— 留着就会和补排出来的新最后一天撞成「D3 返程、D5 也返程」。
    // 摘掉它并同步那天的摘要串（不摘的话，补排的 prompt 会把已经失效的返程再读一遍）。
    // 必须排在 recalcTripBudget 前面：摘项会改人均价合计。
    if (dayCount !== trip.day_count) boundary = removeStaleBoundaryItems(trip.id, dayCount)

    // 天和项都改完后再算一次总预算：缩短天数会级联删掉那几天的行程项，人数变了同理。
    // 放在末尾按 items 实际内容算，口径唯一。
    recalcTripBudget(trip.id)
  })

  // 事务提交后再调 AI —— 调用必须放在事务【外面】：一次网络往返几秒到几十秒，
  // 包在事务里会长时间持有写锁。
  // 两类要补的：① 新补出来的空天（从零排）；② 被摘掉失效边界项后变短的天（保留原样再追加）。
  let appended = []
  let refilled = []
  let aiError = null
  try {
    if (!newIndexes.length && !boundary.days.length) {
      // 单纯平移日期 / 只改人数：什么都没变，不烧 token
    } else if (!aiReady()) {
      aiError = 'AI 未配置'
    } else {
      // 避重上下文要重新查库：事务里刚重拼过受影响天的 title，
      // 用变更前读的 days 会把已经摘掉的「返程」又喂给模型。
      const known = queryAll(
        'SELECT day_index, title FROM trip_days WHERE trip_id = ? AND day_index <= ? ORDER BY day_index',
        [trip.id, dayCount],
      )
        .filter((d) => !newIndexes.includes(d.day_index) && !isPlaceholderTitle(d.title))
        .map((d) => ({ day_index: d.day_index, title: d.title }))

      // 先补「被摘短」的那几天：它们序号通常更小，排完会进入下面的避重上下文
      if (boundary.days.length) {
        const r = await fillShortDays({
          tripId: trip.id,
          title: nextTitle,
          totalDays: dayCount,
          dayIndexes: boundary.days,
          knownDays: known,
        })
        refilled = r.filled
        aiError = r.error
      }

      if (newIndexes.length) {
        const targets = newIndexes.map((dayIndex) => ({
          day_index: dayIndex,
          date: addDays(nextStart, dayIndex - 1),
        }))
        const r = await planDays({
          tripId: trip.id,
          title: nextTitle,
          totalDays: dayCount,
          targets,
          knownDays: known,
        })
        appended = r.filled
        aiError = r.error ?? aiError
      }

      // 两批补排都会改变人均价合计，事务里那次算的是「两批都还没写」的状态，得再算一次
      if (refilled.length || appended.length) recalcTripBudget(trip.id)
    }
  } catch (e) {
    // async 处理函数里抛出去的错误 Express 4 不会接住，请求会一直挂着 —— 必须自己兜
    console.error('[trip] 补排异常:', e)
    aiError = 'AI 补排失败，请稍后重试'
  }

  // 这三个字段是 PATCH 专有的附加信息（其余接口不返回）：
  //   appended_days  — 新补出来的天里排上了哪些
  //   refilled_days  — 被摘短之后又补齐了哪些
  //   stale_closings — 摘掉了哪些失效的边界项（前端据此说明「为什么 D3 的返程没了」）
  // 失败时前端会在空天上给「让 AI 补排」的重试入口。
  // 行程信息变化通知：改完就走的人，回来也有一条「已更新」入口（事务已提交，必弹）
  const mmdd = (iso) => iso.slice(5).replace('-', '.') // YYYY-MM-DD → MM.DD
  if (dayCount !== trip.day_count) {
    notifyTrip(req.user.id, {
      title: nextTitle,
      preview: `已更新为 ${mmdd(nextStart)} - ${mmdd(nextEnd)} · ${dayCount} 天`,
    })
  } else if (nextStart !== trip.start_date || nextEnd !== trip.end_date) {
    notifyTrip(req.user.id, {
      title: nextTitle,
      preview: `行程日期已更新为 ${mmdd(nextStart)} - ${mmdd(nextEnd)}`,
    })
  } else if (nextTraveler !== trip.traveler) {
    notifyTrip(req.user.id, { title: nextTitle, preview: '出行人数已更新' })
  }

  ok(res, {
    ...getTripDetail(trip.id),
    appended_days: appended,
    refilled_days: refilled,
    stale_closings: boundary.removed,
    ai_error: aiError,
  })
})

/** 单天（重）排的频率限制：直连付费大模型，不设限等于把额度挂公网 */
const genDayLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyFn: (req) => `genday:${req.user?.id || req.ip}`,
  message: '生成过于频繁，请稍后再试',
})

/**
 * POST /v1/trip/:id/day/:dayIndex/generate  给指定的一天（重）排行程。
 *
 * 主要用途：「日期变长后自动补排失败」时，用户点那一天的「让 AI 补排」重试。
 * 接口语义是【重排这一天】—— 会先清掉该天现有的行程项再生成。
 * 前端目前只在空天上暴露入口，但语义上允许重排已有内容（相当于「换一批」）。
 */
router.post('/trip/:id/day/:dayIndex/generate', genDayLimiter, async (req, res) => {
  const trip = queryOne('SELECT * FROM trips WHERE id = ?', [req.params.id])
  if (!trip) return err(res, '行程不存在', 404)
  if (trip.user_id !== req.user.id) return err(res, '无权访问', 403)

  const dayIndex = Number(req.params.dayIndex)
  if (!Number.isInteger(dayIndex) || dayIndex < 1 || dayIndex > trip.day_count) {
    return err(res, `天序号需在 1-${trip.day_count} 之间`)
  }
  const day = queryOne('SELECT * FROM trip_days WHERE trip_id = ? AND day_index = ?', [trip.id, dayIndex])
  if (!day) return err(res, `第 ${dayIndex} 天不存在`, 404)

  if (!aiReady()) return ok(res, { ...getTripDetail(trip.id), appended_days: [], ai_error: 'AI 未配置' })

  const knownDays = queryAll(
    'SELECT day_index, title FROM trip_days WHERE trip_id = ? AND day_index <> ? ORDER BY day_index',
    [trip.id, dayIndex],
  ).filter((d) => !isPlaceholderTitle(d.title))

  try {
    const r = await planDays({
      tripId: trip.id,
      title: trip.title,
      totalDays: trip.day_count,
      targets: [{ day_index: dayIndex, date: day.date }],
      knownDays,
    })
    if (r.filled.length) {
      recalcTripBudget(trip.id)
      notifyTrip(req.user.id, { title: trip.title, preview: `D${dayIndex} 已排好，去看看今天的安排吧` })
    }
    ok(res, { ...getTripDetail(trip.id), appended_days: r.filled, ai_error: r.error })
  } catch (e) {
    console.error('[trip] 单天补排异常:', e)
    ok(res, { ...getTripDetail(trip.id), appended_days: [], ai_error: 'AI 补排失败，请稍后重试' })
  }
})

/** 整条行程优化的频率限制：同上，直连付费大模型不能裸奔 */
const optimizeLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyFn: (req) => `optimize:${req.user?.id || req.ip}`,
  message: '优化过于频繁，请稍后再试',
})

/**
 * POST /v1/trip/:id/optimize  按一句口语要求优化整条行程。
 *
 * 场景：「上海4日游 这里购物太多，把购物日换成亲子项目」这句话只想改 D2，
 * 但改动属于整合式的——AI 要看着全盘才能判断怎么动。所以接口把
 * 【整条行程】喂进去，返回重排后覆盖每一天的结果，逐天落库。
 *
 * 不提供保留现场的回滚：迭代式开发阶段，改坏了一键重新生成即可。
 * 返回附加字段 optimized_days（改了哪些天）+ ai_error（失败原因，失败不回滚）。
 */
router.post('/trip/:id/optimize', optimizeLimiter, async (req, res) => {
  const trip = queryOne('SELECT * FROM trips WHERE id = ?', [req.params.id])
  if (!trip) return err(res, '行程不存在', 404)
  if (trip.user_id !== req.user.id) return err(res, '无权访问', 403)

  const instruction = String(req.body?.instruction || '').trim()
  if (!instruction) return err(res, '请说明你想怎么调整', 400)

  const knownDays = queryAll(
    'SELECT day_index, title FROM trip_days WHERE trip_id = ? ORDER BY day_index',
    [trip.id],
  ).filter((d) => !isPlaceholderTitle(d.title))

  if (!aiReady()) return ok(res, { ...getTripDetail(trip.id), optimized_days: [], ai_error: 'AI 未配置' })

  let content = ''
  try {
    content = await chatOnce(
      buildOptimizeTripMessages({
        title: trip.title,
        totalDays: trip.day_count,
        existingDays: knownDays,
        instruction,
      }),
      { temperature: 0.7, timeoutMs: 60_000 },
    )
  } catch (e) {
    console.error('[trip] 优化调用失败:', e)
    return ok(res, { ...getTripDetail(trip.id), optimized_days: [], ai_error: 'AI 优化失败，请稍后重试' })
  }

  const list = extractJson(content)?.days
  if (!Array.isArray(list) || !list.length) {
    return ok(res, { ...getTripDetail(trip.id), optimized_days: [], ai_error: 'AI 返回格式异常，请重试' })
  }

  // 逐天落库；AI 偶尔会漏天（数组长度对不上）——没给到的天保持原样，不算失败
  const changed = []
  for (let i = 0; i < trip.day_count; i++) {
    const summary = String(list[i] ?? '').trim()
    if (!summary) continue
    if (writeDayPlan(trip.id, i + 1, summary)) changed.push(i + 1)
  }

  let aiError = null
  if (!changed.length) {
    aiError = 'AI 没有返回有效的调整结果，请换个说法试试'
  } else {
    recalcTripBudget(trip.id)
  }
  if (changed.length) {
    notifyTrip(req.user.id, { title: trip.title, preview: '行程已按你的要求重排，看看新安排吧' })
  }
  ok(res, { ...getTripDetail(trip.id), optimized_days: changed, ai_error: aiError })
})

/** PATCH /v1/trip/:id/item/:itemId  上移/下移行程项 { direction: 'up' | 'down' } */
router.patch('/trip/:id/item/:itemId', (req, res) => {
  const detail = getTripDetail(req.params.id)
  if (!detail) return err(res, '行程不存在', 404)
  if (detail.user_id !== req.user.id) return err(res, '无权访问', 403)
  const dir = req.body?.direction
  if (dir !== 'up' && dir !== 'down') return err(res, 'direction 必须为 up 或 down')

  const item = queryOne('SELECT * FROM trip_items WHERE id = ? AND trip_id = ?', [req.params.itemId, req.params.id])
  if (!item) return err(res, '行程项不存在', 404)

  // 找同一天的相邻项（按 sort_order 排序）。要 title：边界判定靠标题语义
  const siblings = queryAll(
    'SELECT id, title, sort_order, start_time FROM trip_items WHERE trip_day_id = ? ORDER BY sort_order',
    [item.trip_day_id],
  )
  const idx = siblings.findIndex((s) => s.id === item.id)
  if (idx === -1) return err(res, '行程项不存在', 404)

  const swapIdx = dir === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= siblings.length) {
    return ok(res, { id: item.id, swapped: false }) // 已到顶/底，无需交换
  }

  // 边界项（抵达/返程）固定在当天首/末。这里判的是【交换之后的整个顺序】，
  // 而不是「拖的是不是边界项」—— 把第二项往上拖同样会把「抵达」顶到中间，
  // 只判被拖项会漏掉这种情况。前端也会禁用入口，这里是兜底（防旧客户端/直连请求）。
  const blockReason = boundaryMoveError(siblings, idx, swapIdx)
  if (blockReason) return err(res, blockReason)

  const swap = siblings[swapIdx]

  // 两次 sort_order 交换 + 整组时间槽重排必须原子。
  // 中途失败会留下两个 item 相同的 sort_order —— 之后每次排序结果都不确定。
  transaction(() => {
    // 只交换顺序，时间不跟着卡片走
    run('UPDATE trip_items SET sort_order = ? WHERE id = ?', [swap.sort_order, item.id])
    run('UPDATE trip_items SET sort_order = ? WHERE id = ?', [item.sort_order, swap.id])

    // 左侧时间是「时间槽」，归位置所有而不是归卡片：移动后按新顺序重新分配
    // （09:00 / 11:00 / 13:00 …）。这样无论怎么移动，左侧时间列都保持递增且不变，
    // 同时也能把历史移动造成的倒挂（如 09:00 / 13:00 / 11:00）修回来。
    const times = siblings.map((s) => s.start_time).sort()
    const ordered = queryAll(
      'SELECT id FROM trip_items WHERE trip_day_id = ? ORDER BY sort_order',
      [item.trip_day_id],
    )
    ordered.forEach((row, i) => {
      if (times[i] !== undefined) {
        run('UPDATE trip_items SET start_time = ? WHERE id = ?', [times[i], row.id])
      }
    })
  })

  ok(res, { id: item.id, swapped: true })
})

/**
 * POST /v1/trip/:id/item/:itemId/check  行中打卡 { done: true | false }
 *
 * 三个刻意的取舍：
 * 1. 【不带乐观锁】。打卡是自己点自己的，冲突概率≈0；带 If-Match 就得多一次
 *    往返、还可能 409 打断正在路上走的人，代价大于收益。
 * 2. 【支持 done:false 撤销】。只给单向打卡的话，点错一个就永久错了。
 * 3. 【幂等】。重复打卡只刷新 done_at，不报错 —— 移动端重发是常态。
 *
 * 打卡【不重算预算】：它只标状态、不改价格，budget_total 不该动。
 * 前端「今天还要花多少」是自己按未打卡项算的，属于展示层。
 */
router.post('/trip/:id/item/:itemId/check', (req, res) => {
  const trip = queryOne('SELECT id, user_id FROM trips WHERE id = ?', [req.params.id])
  if (!trip) return err(res, '行程不存在', 404)
  if (trip.user_id !== req.user.id) return err(res, '无权访问', 403)

  const done = req.body?.done !== false // 不传按打卡处理，显式 false 才是撤销
  const item = queryOne('SELECT id FROM trip_items WHERE id = ? AND trip_id = ?', [
    req.params.itemId,
    req.params.id,
  ])
  if (!item) return err(res, '行程项不存在', 404)

  const doneAt = done ? new Date().toISOString() : null
  run('UPDATE trip_items SET done_at = ? WHERE id = ?', [doneAt, item.id])

  ok(res, { id: item.id, done_at: doneAt })
})

export default router
