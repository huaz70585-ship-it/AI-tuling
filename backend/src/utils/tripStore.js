/**
 * 行程写入与预算口径。
 *
 * 抽成独立模块的原因：routes/trip.js（用户操作）与 agent/tools.js
 * （AI 自主调用工具）都要「把一天的计划落库 + 重算预算」。
 * 两边各写一份的话，人均价解析口径（price_ref 是【人均价】）早晚漂移，
 * 预算就会算成两套数。
 */
import { run, queryOne, transaction, parseJSON } from '../db.js'

/** 儿童按成人价的一半计费 */
export const CHILD_PRICE_RATIO = 0.5

/** 占位标题：日期变长时补建的空天，title 只有 "D3"。喂给 AI 时应当忽略，免得它以为已有安排 */
export const isPlaceholderTitle = (t) => /^D\d+$/.test(String(t || '').trim())

/** 计费人数权重：成人 1，儿童 0.5 */
export function headWeight(t) {
  const adults = Number(t?.adults) || 0
  const children = Array.isArray(t?.children) ? t.children.length : 0
  return adults + children * CHILD_PRICE_RATIO
}

/**
 * 从「故宫（60）」这类文本里解析【人均价】。
 * 兼容全角/半角括号，只在结尾处取括号；括号里取第一个数字，取不到（如「免费」）按 0 算。
 * 例：「天安门广场（免费）」→ 0；「景山公园(2元看日落)」→ 2；「故宫（60）」→ 60
 */
export function parsePersonPrice(text) {
  const m = String(text).match(/[（(]([^）)]*)[）)]\s*$/)
  if (!m) return 0
  const num = m[1].match(/\d+(?:\.\d+)?/)
  return num ? Math.round(Number(num[0])) : 0
}

/**
 * 把一天的摘要文本拆成多个行程项落库，返回这一天的人均价合计。
 *
 * 摘要口径与 tripPrompt.js 的 dayFormatRules() 严格对齐：
 *   「Day1 灵隐寺（45）+飞来峰（含于票价）+永福寺（免费）」
 * 按 + / → 拆项，每项【结尾括号】里的数字即人均价，拆不出按 0。
 */
/**
 * 从行程项文本开头抠出可选的开始时间前缀「HH:MM 」。
 * 新流水线要求 LLM 写真实时间（"08:00 八达岭长城（40）"），
 * 旧 SSE 链路不带时间前缀 → 返回 null 走自动时间槽，老行为保持兼容。
 */
const TIME_PREFIX_RE = /^(\d{1,2}):(\d{2})\s+/
function parseItemHead(text) {
  const m = text.match(TIME_PREFIX_RE)
  if (!m) return { start: null, title: text }
  const hh = Number(m[1]); const mm = Number(m[2])
  if (hh > 23 || mm > 59) return { start: null, title: text }
  return { start: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, title: text.slice(m[0].length) }
}

/** HH:MM → 当天分钟数 */
function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 相邻行程项之间默认预留的转场分钟（hop 生成后会用真实在途时间覆盖观感） */
const HOP_BUFFER_MIN = 30

/** 分钟数 → HH:MM */
function toHHMM(min) {
  const m = Math.max(0, Math.min(24 * 60 - 1, min))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function createDayItems(tripId, dayId, summaryText) {
  const itemTexts = String(summaryText)
    .replace(/^Day\s*\d+(-\d+)?\s*[：:，,。]?\s*/i, '') // 去掉 "Day1 " / "Day1-3 " 前缀
    .split(/[+＋→]/)
    .map((s) => s.trim())
    .filter((s) => s)
  const items = itemTexts.length ? itemTexts : [String(summaryText)]

  // 解析每项的时间前缀。注意：不能要求"全部项都带时间"——「抵达北京」这类边界项
  // LLM 经常漏写时间，只要有一项没写就整天回退假槽，等于真实时间永远不生效。
  // 改成：只要【有一项】带时间就进入真实模式，缺时间的项按相邻项自动补齐。
  const parsed = items.map((t) => parseItemHead(t))
  const realMode = parsed.some((x) => x.start)

  if (realMode) {
    // 从左到右补缺时间的项
    parsed.forEach((p, j) => {
      if (p.start) return
      if (j === 0) {
        // 首项（多为「抵达」）：按下一项时间倒推 1 小时 + 转场；没有下一项就 09:00
        p.start = parsed[j + 1]?.start
          ? toHHMM(toMin(parsed[j + 1].start) - 60 - HOP_BUFFER_MIN)
          : '09:00'
      } else {
        const prev = parsed[j - 1]
        const prevDur = prev.duration ?? 60
        p.start = toHHMM(toMin(prev.start) + prevDur + HOP_BUFFER_MIN)
      }
    })
  }

  let personTotal = 0
  parsed.forEach((item, j) => {
    const price = parsePersonPrice(item.title)
    personTotal += price
    const start = realMode ? item.start : `${String(9 + j * 2).padStart(2, '0')}:00`
    // 停留时长：真实模式按与下一项的时间差减转场缓冲；末项兜底 90 分钟。
    let duration = null
    if (realMode) {
      duration = j < parsed.length - 1
        ? Math.max(30, toMin(parsed[j + 1].start) - toMin(start) - HOP_BUFFER_MIN)
        : 90
      item.duration = duration
    }
    run(
      'INSERT INTO trip_items (id, trip_id, trip_day_id, sort_order, type, title, start_time, duration_min, price_ref, source) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        `${dayId}-i${j + 1}`,
        tripId,
        dayId,
        j + 1,
        'sight',
        // 标题保留「故宫（60）」原样（卡片上直接显示价格），人均价另存 price_ref
        item.title,
        start,
        duration,
        price,
        'ai',
      ],
    )
  })
  return personTotal
}

/**
 * 清掉某一天的全部行程项，以及指向它们的交通衔接。
 *
 * trip_hops 只对 trips(id) 建了 CASCADE，对 item 没有外键，
 * 所以删项时必须手工清 —— 否则留下指不到任何行程项的孤立行。
 * 子查询要赶在 trip_items 被删之前跑。
 */
export function clearDayItems(dayId) {
  run('DELETE FROM trip_hops WHERE from_item_id IN (SELECT id FROM trip_items WHERE trip_day_id = ?)', [dayId])
  run('DELETE FROM trip_hops WHERE to_item_id IN (SELECT id FROM trip_items WHERE trip_day_id = ?)', [dayId])
  run('DELETE FROM trip_items WHERE trip_day_id = ?', [dayId])
}

/**
 * 给某一天写入 AI 排好的摘要：改 title → 清旧项 → 建新项（一天一组，原子）。
 * 「改 title + 删 + 建」必须原子，否则中途失败会留下「标题是新的、项还是旧的」。
 */
export function writeDayPlan(tripId, dayIndex, summary) {
  const day = queryOne('SELECT * FROM trip_days WHERE trip_id = ? AND day_index = ?', [tripId, dayIndex])
  if (!day) return false
  transaction(() => {
    run('UPDATE trip_days SET title = ? WHERE id = ?', [summary, day.id])
    clearDayItems(day.id)
    createDayItems(tripId, day.id, summary)
  })
  return true
}

/**
 * 按行程项算总预算（只算不落库）。
 * 口径：Σ(item.price_ref) + Σ(hop.cost_ref)，再 × 计费人数权重。
 *   - price_ref 是【景点/活动人均门票】；
 *   - cost_ref 是【相邻行程项之间的交通衔接费】（公交/地铁/打车，落在 trip_hops 表）。
 * 原来只算门票，漏掉了"公交2块+打车35"这类衔接成本，导致底部总预算明显偏小（P0 修复）。
 * hops 可能还没生成（前端进详情才懒加载），没生成时这部分按 0 算，不报错。
 */
export function computeBudget(tripId, traveler) {
  const itemRow = queryOne(
    'SELECT COALESCE(SUM(price_ref), 0) AS s FROM trip_items WHERE trip_id = ?',
    [tripId],
  )
  const hopRow = queryOne(
    'SELECT COALESCE(SUM(cost_ref), 0) AS s FROM trip_hops WHERE trip_id = ?',
    [tripId],
  )
  // 门票按人头乘权重；交通是整车钱，不乘人数（见函数头注释）
  const tickets = Number(itemRow?.s || 0) * headWeight(traveler)
  const transport = Number(hopRow?.s || 0)
  return Math.round(tickets + transport)
}

/**
 * 重算总预算并落库，返回新值。
 * trips.budget_total 是冗余列：行程项一增删，它就跟实际对不上了。
 * 前端底部「本次行程总预算」读的正是这一列，所以增删项后必须重算。
 */
export function recalcTripBudget(tripId) {
  const row = queryOne('SELECT traveler FROM trips WHERE id = ?', [tripId])
  if (!row) return null
  const budget = computeBudget(tripId, parseJSON(row.traveler, { adults: 1 }))
  run('UPDATE trips SET budget_total = ?, updated_at = ? WHERE id = ?', [
    budget,
    new Date().toISOString(),
    tripId,
  ])
  return budget
}