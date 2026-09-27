/**
 * 行程「边界项」的纯判定 —— 抵达 / 返程这类只在首尾成立的安排。
 *
 * 为什么单独一个文件（且【不 import 任何东西】）：
 * 判定被三处共用 ——
 *   1. db.js 的 mapItem 要给前端标出 boundary（前端据此不给移动入口）；
 *   2. routes/trip.js 的移动接口要拦下破坏边界的交换；
 *   3. tripBoundary.js 改日期时清理越界的边界项。
 * 而 1 和 3 之间会形成 db.js ⇄ tripBoundary.js 的循环 import。
 * 把纯判定摘出来，谁都能直接 import，且不产生环。
 */

/**
 * 收尾动作：只在行程最后一天成立。
 * 刻意不锚定开头 —— 「虹桥站返程」「傍晚返程」这类都该认出来。
 */
const CLOSING_ITEM =
  /(返程|回程|返家|返京|返沪|返杭|返穗|返深|返津|返渝|返蓉|返邕|返汉|返长|离程|送机|送站|去机场|去火车站|去高铁站|散团|行程结束|结束行程)/

/**
 * 抵达动作：只在行程第一天成立。
 *
 * 必须锚定开头，且刻意【不收「入住」】—— 「入住 · 陆家嘴精品酒店」在 1001 里就落在
 * 第 2 天，那是正常的住宿动作，不是边界标记（连住几晚会重复出现）。踩过这个坑。
 * 末尾的负向断言再挡一层：第 N 天的「抵达酒店」不是「抵达目的地」。
 */
const ARRIVAL_ITEM = /^(抵达|到达|飞抵|落地|初到)(?!酒店|宾馆|民宿|住处|客栈)/

export const isArrivalItem = (title) => ARRIVAL_ITEM.test(String(title || ''))
export const isClosingItem = (title) => CLOSING_ITEM.test(String(title || ''))

/**
 * 判断一次相邻交换会不会把边界项挤离首位/末位，破坏了就拒绝。
 *
 * 【关键】判的是「交换之后的整个顺序」，而不是「被拖的是不是边界项」：
 * 把第二项往上拖，同样会把「抵达」顶到第二位 —— 只判被拖项会漏掉这种情况。
 *
 * @param {{title:string}[]} items 交换前的当天项（按 sort_order 升序）
 * @param {number} idx     被移动项的下标
 * @param {number} swapIdx 要交换的邻居下标
 * @returns {string|null} null = 允许；否则为给用户看的拒绝原因
 */
export function boundaryMoveError(items, idx, swapIdx) {
  const next = [...items]
  const tmp = next[idx]
  next[idx] = next[swapIdx]
  next[swapIdx] = tmp

  const last = next.length - 1
  if (next.some((s, i) => i !== 0 && isArrivalItem(s.title))) {
    return '「抵达」固定在当天第一位，不能移动'
  }
  if (next.some((s, i) => i !== last && isClosingItem(s.title))) {
    return '「返程」固定在当天最后一位，不能移动'
  }
  return null
}
