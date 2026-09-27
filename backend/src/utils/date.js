/**
 * 「今天」的统一口径。
 *
 * 抽出来的原因：chat.js 要把今天告诉模型（否则它没法把「25号」「下周三」
 * 解析成具体日期），trip.js 要拿今天校验 AI 给的出发日（不能早于今天）。
 * 两处各算一次、各写一套时区处理，跨零点就会打架 ——
 * 提示词里说今天是 25 号，校验却按 24 号判。
 *
 * 一律按 Asia/Shanghai 算，不依赖服务器本地时区：
 * 服务器可能跑在 UTC 容器里，用本地时区会在北京时间 0-8 点整体偏一天。
 */

const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
const WEEKDAY_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  weekday: 'long',
})

/** 今天（Asia/Shanghai）的 YYYY-MM-DD。en-CA 的输出格式恰好就是 YYYY-MM-DD */
export function todayIso() {
  return DATE_FMT.format(new Date())
}

/** 今天的中文星期，如「星期五」。解析「下周三」这类说法必须用到 */
export function todayWeekday() {
  return WEEKDAY_FMT.format(new Date())
}

/** 给 prompt 用：一次拿全，避免两次调用跨过零点拿到不一致的组合 */
export function todayInShanghai() {
  const now = new Date()
  return { date: DATE_FMT.format(now), weekday: WEEKDAY_FMT.format(now) }
}