/**
 * 行程相关的 prompt 片段。
 *
 * 抽出来的原因：「日期变长后补排新天」（trip.js）和「对话生成整条行程」（chat.js）
 * 必须用同一份口径 —— 尤其是【景点名后紧跟人均价】这条格式铁律，
 * 因为 trip.js 的 parsePersonPrice() 正是按「名称（价格）」解析人均价的。
 * 两处各写一份，早晚会漂移出一批解析不出价格的项目。
 */
import { queryAll } from '../db.js'

/**
 * city_spots.price 存的是【已经带 ¥ 的展示串】（"¥60" / "¥300"）或「免费」。
 * 老代码直接拼 `¥${r.price}`，注入给模型的是「¥¥60」「¥免费」——
 * 既难看，也会诱导模型照抄成不带括号的「故宫¥¥60」，
 * 而 trip.js 的 parsePersonPrice() 只认【结尾括号】里的数字 → 那天价格全变 0。
 */
function priceLabel(price) {
  const raw = String(price ?? '').trim()
  if (!raw) return '¥0'
  if (raw === '免费') return '免费'
  return /^[¥￥]/.test(raw) ? raw : `¥${raw}`
}

/**
 * 把 city_spots 里的真实景点拼成一段注入文本；没有任何景点时返回空串。
 * 原样搬自 chat.js 的 buildSystemPrompt()，挪过来是为了两边共用。
 */
export function citySpotContext() {
  const rows = queryAll(`
    SELECT c.name AS city, s.name, s.price, s.rating
    FROM city_spots s JOIN cities c ON c.id = s.city_id
    ORDER BY c.id, s.rating DESC`)
  if (!rows.length) return ''

  const byCity = new Map()
  for (const r of rows) {
    if (!byCity.has(r.city)) byCity.set(r.city, [])
    byCity.get(r.city).push(`${r.name}(${priceLabel(r.price)},评分${r.rating})`)
  }
  let p = '\n以下是合作城市的真实景点与参考价，用户提到这些城市时优先使用：'
  for (const [city, list] of byCity) p += `\n${city}：${list.join('、')}。`
  p += '\n用户目的地不在上述城市时，按你自己的知识推荐。'
  return p
}

/**
 * 一天摘要的格式铁律（三条）。末尾不带换行，调用方自己接。
 *
 * 注意第 1 条的「+ 连接」和第 2 条的「名称（价格）」是硬约定：
 * trip.js 的 createDayItems() 按 + / → 拆项，parsePersonPrice() 从结尾括号里取人均价。
 * 格式一破，那一天的价格就全变 0。
 */
export function dayFormatRules() {
  return [
    '- days：数组，每个元素是一天的行程摘要，项目之间必须用 + 连接；',
    '- 【强制】每个景点/项目后面必须紧跟人均价格，写成「名称（价格）」：免费写（免费），收费直接写阿拉伯数字；正确：天安门广场（免费）、故宫（60）、都江堰（80）；错误：故宫、故宫60元、故宫（门票60）；',
    '- 价格一律是【每人】的参考价（门票 / 人均消费），不要乘以人数，也不要写成整单总价；',
  ].join('\n')
}

/**
 * 首尾边界项的写法规则（抵达 / 返程）。
 *
 * 为什么必须抽出来、且必须显式写进规则：
 * 「抵达」以前【只出现在 chat.js 的示例句里】，从来没写成一条规则 ——
 * 于是模型照抄示例时才有「Day1 抵达成都」，没照抄就直接第一站，
 * 同一批生成里时有时无，用户一眼就看得出不一致。规则不能只活在示例里。
 *
 * 与 §格式规则 放一起（而不是塞进编号任务规则）：它约束的是"摘要长什么样"，
 * 和「名称（价格）」是同一类要求；而且各调用方的编号列表长度不同，混进去会乱。
 *
 * @param {boolean} isFirstDay 本次生成是否覆盖行程第一天
 * @param {boolean} isLastDay  本次生成是否覆盖行程最后一天
 */
export function boundaryRules(isFirstDay, isLastDay) {
  const lines = []
  if (isFirstDay) {
    lines.push(
      '- 【强制】第一天必须以「抵达+目的地（免费）」开头，例如「Day1 抵达成都（免费）+宽窄巷子（免费）」。注意「抵达酒店 / 抵达民宿」是住宿动作、不是抵达目的地，不能拿它当开场；',
    )
  } else {
    lines.push('- 【禁止】本次不涉及第一天，不得出现「抵达」「到达」「飞抵」「落地」这类开场安排；')
  }
  if (isLastDay) {
    lines.push('- 【强制】最后一天必须以「返程（免费）」收尾（用户明确要求去掉时才不写）；')
  } else {
    lines.push('- 【禁止】本次不涉及最后一天，不得出现「返程」「回程」「送机」「送站」这类收尾安排；')
  }
  return lines.join('\n')
}

/**
 * 一行「已有安排」：`D1 灵隐寺（45）+飞来峰（含于票价）`
 *
 * 必须剥掉存的标题里自带的 "Day1 " 前缀，否则拼出来是「D1 Day1 灵隐寺…」，
 * 模型容易把第几天数错。
 */
function dayLine(d) {
  const text = String(d.title || '')
    .replace(/^Day\s*\d+(\s*[-~]\s*\d+)?\s*[：:，,。]?\s*/i, '')
    .trim()
  return `D${d.day_index} ${text || '（暂无安排）'}`
}

/**
 * 补排「日期变长后多出来的那几天」的 messages。
 *
 * 与 chat.js 整条行程生成的区别：这里必须把【已有几天】喂进去，
 * 否则模型很容易把第一天去过的景点又排到第二天（同一个寺逛两遍）。
 *
 * @param {object} p
 * @param {string} p.title        行程标题（含目的地，如「杭州灵隐寺1日禅意行」）
 * @param {number} p.totalDays    改完之后的总天数
 * @param {{day_index:number,title:string}[]} p.existingDays 已有内容的天（用来避重）
 * @param {{day_index:number,date:string}[]} p.targets       要补排的天（按 day_index 升序）
 */
export function buildAppendDaysMessages({ title, totalDays, existingDays, targets }) {
  const system = [
    '你是「途灵」旅行助手，专注中国境内旅行规划。现在要为一条【已经存在】的行程补排后面几天的安排。',
    citySpotContext(),
    '\n\n【本次任务规则——非常重要，必须严格遵守】',
    '\n1. 只输出 JSON，不要任何解释文字，不要输出 markdown 代码块以外的内容。',
    '\n2. 输出格式严格为：{"days":["Day2 ...","Day3 ..."]}',
    `\n3. days 数组长度必须等于「需要补排的天数」，顺序与给出的日期先后一致，Day 序号用给出的真实序号。`,
    '\n4. 每天项目数不固定、按景点大小和当天剩余时间弹性安排（大景区占半天就别凑数，同片区小点位可凑2个）；项目之间用 + 连接。',
    '\n5. 【必须避开】「已排好的天数」里已经出现过的景点，并延续它的节奏与主题。',
    '\n6. 不要重复输出已排好的那几天。',
    '\n\n格式规则：\n',
    dayFormatRules(),
    '\n',
    // 补排只加在末尾，所以永远不会覆盖第一天；是否覆盖最后一天看 targets
    boundaryRules(
      false,
      targets.some((t) => t.day_index === totalDays),
    ),
  ].join('')

  const existing = existingDays.length
    ? [...existingDays]
        .sort((a, b) => a.day_index - b.day_index)
        .map(dayLine)
        .join('\n')
    : '（还没有任何安排）'
  const want = targets.map((t) => `第 ${t.day_index} 天（${t.date}）`).join('、')

  const user =
    `行程标题：${title}（整条行程共 ${totalDays} 天）\n` +
    `已排好的天数（这些景点不要重复）：\n${existing}\n\n` +
    `需要补排 ${targets.length} 天：${want}\n` +
    `请输出与这 ${targets.length} 天一一对应的 days JSON。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * 「摘掉失效边界项之后，给那一天补几个项目」的 messages。
 *
 * 与 buildAppendDaysMessages 的本质区别：那些天【已经有内容】，
 * 必须原样保留（名称、价格括号、先后顺序都不许动），只在末尾追加 ——
 * 不是重排。这个区别要写死在 prompt 里，否则模型会把用户已经认可的安排重排一遍。
 *
 * 反过来的极端情况：那天只有一项「返程」，摘完变空天，这时 existingItems 为空，
 * 退化成「从零排这一天」，条数要求也放宽到 3-4 项。
 *
 * @param {object} p
 * @param {string} p.title          行程标题（含目的地）
 * @param {number} p.totalDays      改完之后的总天数
 * @param {number} p.dayIndex       要补的是第几天（1 起算）
 * @param {string} p.date           那天的日期（YYYY-MM-DD）
 * @param {string[]} p.existingItems 那天当前剩下的项目标题，按原顺序
 * @param {{day_index:number,title:string}[]} p.existingDays 其它天（避重）
 * @param {number} p.need           要追加几个（existingItems 为空时不使用）
 * @param {boolean} p.isLastDay     那天是不是新行程的最后一天
 */
export function buildRefillDayMessages({
  title,
  totalDays,
  dayIndex,
  date,
  existingItems,
  existingDays,
  need,
  isLastDay,
}) {
  const keep = existingItems.join('+')

  const system = [
    `你是「途灵」旅行助手，专注中国境内旅行规划。现在要调整一条【已存在】行程里的第 ${dayIndex} 天。`,
    citySpotContext(),
    '\n\n【本次任务规则——非常重要，必须严格遵守】',
    '\n1. 只输出 JSON，不要任何解释文字，不要输出 markdown 代码块以外的内容。',
    `\n2. 输出格式严格为：{"days":["Day${dayIndex} ..."]}，数组长度必须为 1。`,
    existingItems.length
      ? `\n3. 这一天【已有安排】：${keep}。必须原样保留这些项目（名称、价格括号、先后顺序都不变），只在它们后面追加 ${need} 个新项目。绝对不要删掉或改写已有项目。`
      : '\n3. 这一天目前是空的，请排 3-4 个项目。',
    '\n4. 新项目要延续这趟行程的主题与节奏，并且【不能】是其它天已经安排过的景点。',
    '\n\n格式规则：\n',
    dayFormatRules(),
    '\n',
    // 单天重排会整版覆盖这一天，所以它自己是不是首/末天决定要不要写抵达/返程
    boundaryRules(dayIndex === 1, isLastDay),
  ].join('')

  const siblings = existingDays.length
    ? [...existingDays]
        .sort((a, b) => a.day_index - b.day_index)
        .map(dayLine)
        .join('\n')
    : '（还没有其它安排）'

  const user =
    `行程标题：${title}（整条行程共 ${totalDays} 天）\n` +
    `其它天的安排（这些景点不要再排）：\n${siblings}\n\n` +
    (existingItems.length
      ? `请输出第 ${dayIndex} 天（${date}）的【完整摘要】= 已有的「${keep}」+ 新追加的 ${need} 个项目，用 + 连接。`
      : `请排第 ${dayIndex} 天（${date}）的行程，用 + 连接各项目。`)

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * 「按用户的调整要求优化整条已有行程」的 messages。
 *
 * 与 buildAppendDaysMessages / buildRefillDayMessages 不同：这里不新增天、不补某一天，
 * 而是把【整条行程】喂给 AI，让它按用户一句口语要求（如「多加点当地美食」「把购物去掉、
 * 换成亲子项目」）重排。要求是整合式的——改动可能落在任意一天。
 *
 * 平衡约束：用户没点名的天，尽量保留原有安排，避免一拍脑袋全重排把用户认可的部分写坏。
 *
 * @param {object} p
 * @param {string} p.title        行程标题
 * @param {number} p.totalDays    行程总天数
 * @param {{day_index:number,title:string}[]} p.existingDays 当前所有天的安排（按 day_index 升序）
 * @param {string} p.instruction  用户的调整要求（自然语言）
 */
export function buildOptimizeTripMessages({ title, totalDays, existingDays, instruction }) {
  const system = [
    '你是「途灵」旅行助手，专注中国境内旅行规划。现在要根据用户的【调整要求】优化一条【已经存在】的行程。',
    citySpotContext(),
    '\n\n【本次任务规则——非常重要，必须严格遵守】',
    '\n1. 只输出 JSON，不要任何解释文字，不要输出 markdown 代码块以外的内容。',
    '\n2. 输出格式严格为：{"days":["Day1 ...","Day2 ..."]}，必须覆盖整条行程【每一天】，数组长度 = 行程总天数，顺序与天数一一对应。',
    '\n3. 每天 3-4 个项目，项目之间用 + 连接。',
    `\n4. 只按用户的调整要求改动；用户没要求动的天，尽量保留原有安排（只做必要的最小调整，如顺延时间线）。不要整天整天空降与要求无关的新景点。`,
    '\n5. 调整要延续这趟行程的主题与节奏，新景点尽量从合作城市景点里选，不要与要求无关地重复已有项目。',
    '\n\n格式规则：\n',
    dayFormatRules(),
    '\n',
    // 整条优化会重写每一天，首尾都覆盖得到
    boundaryRules(true, true),
  ].join('')

  const existing = existingDays.length
    ? [...existingDays]
        .sort((a, b) => a.day_index - b.day_index)
        .map(dayLine)
        .join('\n')
    : '（还没有任何安排）'

  const user =
    `行程标题：${title}（整条行程共 ${totalDays} 天）\n` +
    `当前安排：\n${existing}\n\n` +
    `用户的调整要求：${instruction}\n` +
    `请输出优化后、覆盖全部 ${totalDays} 天的 days JSON。`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
