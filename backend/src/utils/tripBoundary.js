/**
 * 行程的「边界语义项」——只在整条行程的第一天 / 最后一天才成立的那些安排。
 *
 * 为什么需要单独的模块：行程项的落库位置是 trip_days.day_index（第几天），
 * 而「返程」「抵达」这类安排依赖的是【它是不是边界】，不是【它排在第几天】。
 * 一旦边界被推开（结束日期后移、天数变长），原来挂在最后一天上的「返程」
 * 就变成了行程中段的一个返程 —— 典型症状是「D3 有返程、D5 也有返程」：
 * 旧的那个没被处理，而补排新天时 prompt 又明确要求最后一天返程。
 *
 * 注意与 hop.js 的 ABSTRACT_ONLY 区分，别合并：
 *   那个判的是「这项能不能算出交通」（整体等于抽象词就跳过估算）；
 *   这个判的是「这项是不是行程边界动作」。
 * 「返程（免费）」两边都命中；「抵达虹桥 · 酒店寄存」只命中本模块的抵达 ——
 * 它含真实地名、能算交通，但仍然是「行程第一天」的标记。
 */
import { queryAll, queryOne, run } from '../db.js'
// 边界项的判定（正则）已抽到 utils/boundary.js —— db.js 与 routes/trip.js 也要用，
// 放这里会让 db.js 反过来 import 本模块，形成循环
import { isArrivalItem, isClosingItem } from './boundary.js'

export { isArrivalItem, isClosingItem }

/**
 * 找出所有「位置与语义不符」的行程项。
 *
 * dayCount 传【变更之后】的总天数 —— 判定用的是新边界。
 * 例：3 天行程延到 5 天，旧的 D3「返程」此时 day_index=3 !== dayCount=5 → 命中。
 */
export function collectStaleBoundaryItems(tripId, dayCount) {
  const rows = queryAll(
    `SELECT i.id, i.title, d.day_index
       FROM trip_items i
       JOIN trip_days d ON d.id = i.trip_day_id
      WHERE i.trip_id = ?
      ORDER BY d.day_index, i.sort_order`,
    [tripId],
  )
  return rows.filter((r) => {
    // 收尾动作只能挂在最后一天。延长行程后旧最后一天落进中段 → 失效
    if (isClosingItem(r.title)) return r.day_index !== dayCount
    // 抵达动作只能挂在第一天。理论上不会被动到（新天一律补在末尾），
    // 这条是兜底：人工移动行程项、或早前的脏数据都能被顺手清掉
    if (isArrivalItem(r.title)) return r.day_index !== 1
    return false
  })
}

/**
 * 用剩下的行程项重拼当天的摘要串，保留原有的「Day3 」前缀。
 * 前缀不能丢的原因：tripPrompt.js 的 dayLine() 靠它把老的 "Day1 xxx" 归一成 "D1 xxx"。
 */
function joinDayTitle(prevTitle, keptTitles) {
  const m = String(prevTitle || '').match(/^(Day\s*\d+(?:\s*[-~]\s*\d+)?\s*[：:，,。]?\s*)/i)
  return (m ? m[1] : '') + keptTitles.join('+')
}

/**
 * 删除越界的边界项，并同步受影响那天的摘要与交通衔接。
 *
 * 【不开事务】—— 必须由调用方包在它自己的事务里，和「天数同步 + 重算预算」原子完成，
 * 否则会留下「日期已经是 5 天、D3 的返程还在」的中间态。
 *
 * @returns {{removed:{day_index:number,title:string}[], days:number[]}}
 *          days 是按升序去重后的受影响天序号（调用方据此决定给哪几天补内容）
 */
export function removeStaleBoundaryItems(tripId, dayCount) {
  const stale = collectStaleBoundaryItems(tripId, dayCount)
  if (!stale.length) return { removed: [], days: [] }

  for (const it of stale) {
    // trip_hops 对 item 没有外键（只对 trips 建了 CASCADE），删项时必须手工清，
    // 否则留下指不到任何行程项的孤立行 —— 与 clearDayItems() 同一个理由
    run('DELETE FROM trip_hops WHERE from_item_id = ? OR to_item_id = ?', [it.id, it.id])
    run('DELETE FROM trip_items WHERE id = ?', [it.id])
  }

  // trip_days.title 是当天摘要串，补排时会作为「已有安排」原样喂回模型。
  // 不同步重拼的话，模型下次看到的是「…+返程（免费）」，还会再排一遍。
  const days = [...new Set(stale.map((s) => s.day_index))].sort((a, b) => a - b)
  for (const dayIndex of days) {
    const day = queryOne('SELECT id, title FROM trip_days WHERE trip_id = ? AND day_index = ?', [
      tripId,
      dayIndex,
    ])
    if (!day) continue
    const kept = queryAll('SELECT title FROM trip_items WHERE trip_day_id = ? ORDER BY sort_order', [
      day.id,
    ]).map((r) => r.title)
    run('UPDATE trip_days SET title = ? WHERE id = ?', [joinDayTitle(day.title, kept), day.id])
  }

  return { removed: stale.map((s) => ({ day_index: s.day_index, title: s.title })), days }
}

/**
 * 把标题里的天数表述改成新的天数：「南宁中秋3日游」+ 5 天 → 「南宁中秋5日游」。
 *
 * 与上面两个函数同属「改日期时的连带修正」—— 天数变了，标题里写死的旧数字也该跟着走。
 *
 * 刻意做得保守，宁可不改也不误伤：
 *   1. 只认「N日 / N天」；
 *   2. N 前面紧挨着「月 / 年 / 第」的一律不碰 —— 挡掉「9月3日出发」这类日期，
 *      以及「第3天去西湖」这种"具体某一天"的说法；
 *   3. 标题里没有天数表述 → 原样返回（不新增、不猜测）。
 */
export function syncTitleDayCount(title, dayCount) {
  const t = String(title || '')
  if (!t) return t
  return t.replace(/(?<![月年第])(\d{1,2})\s*([日天])/g, (_m, _n, unit) => `${dayCount}${unit}`)
}
