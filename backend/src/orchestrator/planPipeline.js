/**
 * 行程生成调度中枢（编排层）。
 *
 * 背景：旧链路是「前端 SSE 流式拿到 JSON → 前端自己解析 → 再调 POST /v1/trips 落库
 * → 天气/交通再各自发请求」。本模块把整条链路收进后端一次串行执行，前端只发一次请求。
 *
 * 流水线（严格串行，后一步读前一步写进 data 的结果）：
 *   1. 调 DeepSeek 生成初步行程 { title, start_date, days[] }   → data.draft
 *   2. 从 draft 提取目的地城市 + 全部景点名称                   → data.destination / data.spots
 *   3. 调 Open-Meteo 拿行程期天气                              → data.weather
 *   4. 把 draft + weather 一起回喂 DeepSeek，补交通建议 + 天气提醒 → data.transport / data.weather_tips
 *   5. 整份行程落库，返回完整结构化 JSON                        → data.trip_id / data.budget_total
 *
 * 设计约定：
 * - 全流水线共用一个可变 data 对象（见下方 createSharedData），每一步只往它上面写字段，
 *   步骤之间不各自重新查库/调外部接口。
 * - 降级粒度：第 1 步（生成本体）失败 = 致命，向上抛错；第 3 步天气、第 4 步建议
 *   失败 = 降级，记进 data.warnings，行程照常落库返回，绝不把整条链路拖崩。
 * - 人工拖动增删、/trip/:id/optimize 增量优化不走这里，本模块对它们零改动。
 * - 不做 self-check 校验模块，不做 function-call 工具调用（按当前需求明确排除）。
 */
import { run, queryAll, transaction } from '../db.js'
import { chatCompletion, chatOnce, extractJson } from '../utils/ai.js'
import { citySpotContext, dayFormatRules, boundaryRules } from '../utils/tripPrompt.js'
import { resolveCityFromTitle } from '../utils/city.js'
import { stripPrice, isAbstractTitle } from '../utils/geo.js'
import { fetchTripWeather } from '../utils/forecast.js'
import { createDayItems, recalcTripBudget } from '../utils/tripStore.js'
import { todayInShanghai } from '../utils/date.js'
import { notifyTrip, notifyWeatherAlert, notifyDisclaimer } from '../utils/notify.js'

const DAY_MS = 86_400_000
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * 收敛 AI 给的出发日期（口径与 routes/trip.js 的 normalizeStartDate 完全一致）：
 * 非法 / 早于今天 / 超过两年 → 兜底到今天。宁可从今天开始，也不生成一条"已结束"的行程。
 */
function normalizeStartDate(raw) {
  const today = todayInShanghai().date
  const s = String(raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return today
  if (Number.isNaN(Date.parse(`${s}T12:00:00Z`))) return today
  if (s < today) return today
  if (s > addDays(today, 730)) return today
  return s
}

/** 公共 data 对象：流水线每一步都读写它，是这个编排层的"黑箱状态" */
function createSharedData({ userId, message }) {
  return {
    user_id: userId,
    user_query: message,
    // step1
    draft: null,        // { intent, title, start_date, days: string[] }
    // step2
    destination: null,  // { name, destination_id }
    spots: [],          // [{ day_index, raw, name }]
    // step3
    weather: { city: null, days: [] },
    // step4
    transport: [],      // [{ day, spot, mode, duration, cost, note }]
    weather_tips: '',
    // step5
    trip_id: null,
    budget_total: null,
    // 降级记录（天气/建议失败时填，前端可静默展示也可忽略）
    warnings: [],
  }
}

// ── Step 1：初步行程 ──────────────────────────────────────────

/**
 * 第 1 步 system prompt。
 * 与 routes/chat.js 的 buildSystemPrompt 复用同一份景点库 / 日期格式 / 边界项规则，
 * 差别只有一处：编排层不需要"1-2 句口语开场白"，要求【纯 JSON】直接产出。
 * 开 jsonMode（response_format）后模型不会再包 ```json 围栏。
 */
function buildDraftSystemPrompt() {
  const today = todayInShanghai()
  return [
    '你是「途灵」旅行助手，专注中国境内旅行规划。根据用户的目的地、天数、预算，给出可执行的行程建议。',
    citySpotContext(),
    `【今天的日期】${today.date}（${today.weekday}）。用户提到日期时（"25号""下周三""国庆"等），先按今天推算成具体日期再排。`,
    '【输出格式——严格遵守】只输出一个 JSON 对象，禁止任何解释文字、禁止 markdown、禁止代码块围栏。字段：',
    '{"intent":"plan","title":"北京3日深度游","start_date":"YYYY-MM-DD","days":["Day1 08:00 八达岭长城·登好汉坡（40）+ 15:30 奥林匹克公园·看鸟巢水立方（免费）+ 18:30 王府井步行街·吃小吃（免费）", "..."]}',
    '字段规则：',
    '- intent 固定 "plan"；',
    '- title 为行程总标题（含目的地+天数），不超过 100 字；',
    '- start_date 为出发日期 YYYY-MM-DD，不能早于今天；用户没说日期就填今天 ' + today.date + '；',
    '- days 长度必须等于用户说的天数（没说默认 3 天）；',
    dayFormatRules(),
    boundaryRules(true, true),
    // -- 硬约束（来自真实翻车案例，模型常识盲区，必须写死）--
    '【排期硬约束--违反就是错行程】',
    '- 夜市、小吃街、滨江夜景点必须排在【当天最后一项】（傍晚才出摊），严禁排在上午/中午的位置；',
    '- 5A级景区 / 大型自然景区（如青秀山、故宫、西湖）【每天最多排 1 个】，给足游览时间，半天塞两个大景区等于走马观花；城市公园/商业街可以紧凑些；博物馆/室内展馆单段留 1.5-2 小时；',
    '- 高温天（>=33℃）别把户外大景区排在中午，优先上午早段或傍晚；雨天优先安排博物馆/商场等室内项目；',
    '【每天排几个点--弹性节奏，禁止机械凑数】',
    '- 项目数不做固定要求，完全按景点大小和当天剩余时间定：大型5A景区（青秀山、故宫）单独占半天，别再硬塞两个小景点凑数；商业街/城市公园/博物馆这类1小时能逛完的小点位，同片区可凑2个放半天；',
    '- 优先级：先把用户点名的必去点全部列出、留够时间；剩下的可选点只加「车程15分钟以内顺路的」，不顺路的宁愿删掉，绝不为凑数跑远路；',
    '- 抵达日/返程日只安排酒店周边1个点，别跑远路折腾；核心游玩日安排2-3个近距离点即可，不用刻意凑数；',
    '- 当天天气不好 / 气温超过35℃，直接砍掉户外可选点、多留休息时间；',
    '【每项必须写真实开始时间——时间是行程的核心，禁止假时间】',
    '- 每个景点名前必须写「HH:MM 」开始时间；相邻两项的时间差要算上【真实路程 + 游览时长】，不许机械隔2小时；',
    '- 远郊大景区（八达岭长城、都江堰、武当山这类距市区40km以上的）【单独占一整天】：早出晚归，当天只在返程方向顺路安排1个点，严禁和市区另一侧的景点（如颐和园）拼在同一天；',
    '- 行程要从早上覆盖到晚上（约9:00-21:00）：下午、傍晚、晚上都要有安排，夜市/夜景放最后；项数可以少，但时间必须真实连续，不许留大段空缺；',
    '- 大景区给足3-5小时，城市小点位1小时左右；转场耗时按常识估（地铁/打车/步行）。',
    '【景点描述】每个景点名后用「·」补一句核心看点，格式：青秀山·登龙象塔看邕江全景（20）。价格括号仍写在最后（解析只认最后一个括号里的数字），看点括号写在它前面。',
  ].join('\n')
}

/** Step1：调大模型生成初步行程，解析成 draft 写进 data */
async function stepGenerateDraft(data, history) {
  const messages = [
    { role: 'system', content: buildDraftSystemPrompt() },
    ...(Array.isArray(history) ? history.slice(-10) : []).map((h) => ({
      role: h.role === 'ai' ? 'assistant' : 'user',
      content: h.text || '',
    })),
    { role: 'user', content: data.user_query },
  ]

  // 一次要排整条行程，输出较长，超时给到 60s；jsonMode 强制纯 JSON
  const { message } = await chatCompletion(messages, {
    temperature: 0.7,
    timeoutMs: 60_000,
    jsonMode: true,
  })
  const draft = extractJson(message.content)

  if (!draft || draft.intent !== 'plan' || !Array.isArray(draft.days) || !draft.days.length) {
    // 模型没认可这是个行程需求（闲聊/单点询问/格式异常）—— 这是致命的：
    // 第 1 步拿不到行程，后面所有步骤都没有输入。
    throw new Error('没能识别出你的行程需求，请说明目的地和大概玩几天')
  }
  data.draft = draft
}

// ── Step 2：提取城市与景点 ────────────────────────────────────

/** Step2：从 draft 拆出目的地城市与景点名列表，写进 data */
function stepExtractTargets(data) {
  const { title, days } = data.draft

  // 目的地：与 POST /v1/trips 落库时用同一个解析口径（内置城市优先 → 标题正则）
  const found = resolveCityFromTitle(title)
  data.destination = {
    name: found?.name ?? null,
    destination_id: found?.row?.id ?? null,
  }

  // 景点：每天的摘要按 + / → 拆项，剥掉结尾价格括号；抽象项（抵达/返程/用餐）不是 POI，丢掉
  days.forEach((rawDay, i) => {
    String(rawDay)
      .split(/[+＋→]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((raw) => {
        if (isAbstractTitle(raw)) return
        const name = stripPrice(raw)
        if (name) data.spots.push({ day_index: i + 1, raw, name })
      })
  })
}

// ── Step 3：天气 ─────────────────────────────────────────────

/**
 * Step3：查行程期天气。
 * fetchTripWeather 内部已把 geocode 失败 / Open-Meteo 超时 / 超出预报范围
 * 全部降级成 days:[]（天气是锦上添花）。这里再兜一层 try/catch 双保险：
 * 任何意外都不允许炸掉主链路。
 */
async function stepFetchWeather(data) {
  try {
    const start = normalizeStartDate(data.draft.start_date)
    const end = addDays(start, data.draft.days.length - 1)
    data.weather = await fetchTripWeather({
      title: data.draft.title,
      destination_id: data.destination?.destination_id ?? null,
      start_date: start,
      end_date: end,
    })
  } catch (e) {
    console.error('[pipeline] 天气获取失败，已降级:', e.message)
    data.warnings.push('天气信息暂不可用')
    data.weather = { city: data.destination?.name ?? null, days: [] }
  }
}

// ── Step 4：交通建议 + 天气提醒（第二次调大模型）──────────────

/** Step4 的 system prompt：要求模型基于已有行程 + 天气补两类增量信息 */
function buildAdviceSystemPrompt() {
  return [
    '你是出行顾问。我会给你一份已排好的行程（days）、景点清单（spots）和目的地逐日天气（weather）。',
    '只输出一个 JSON 对象，禁止任何解释文字、禁止 markdown、禁止代码块围栏。格式：',
    '{"transport":[{"day":1,"spot":"景点名","mode":"地铁2号线","duration":"15分钟","cost":3,"note":"一句备注"}],"weather_tips":"80字以内的出行提醒"}',
    '要求：',
    '- transport 尽量覆盖 spots 里的主要景点；"抵达/返程/用餐"这类抽象项可跳过；',
    '- mode 写具体可执行的方式（地铁几号线/打车/步行/公交几路）；note 里只写时长和走法（"打车约15分钟""地铁2号线3站")，【不要写具体金额】——打车费模型估不准，写死会让用户到现场对不上账；cost 字段仍填粗略整数（免费0），只用于预算汇总，不展示给用户；',
    '- weather_tips 基于 weather.days 里的雨/雪/高温等写穿衣带伞/防晒提醒；天气为空时返回空字符串；',
    '- 不要改动原行程的景点顺序与名称，只做补充建议。',
  ].join('\n')
}

/**
 * Step4：把 draft + weather 一起回喂大模型。
 * 这一步是"增强项"不是"命根子"——失败就降级：transport/weather_tips 留空，
 * warnings 记一笔，行程照常返回。temperature 0.3：建议要稳，不要每次花样不同。
 */
async function stepEnrichAdvice(data) {
  try {
    const userPayload = {
      title: data.draft.title,
      days: data.draft.days,
      spots: data.spots.map((s) => ({ day: s.day_index, name: s.name })),
      weather: data.weather,
    }
    const text = await chatOnce(
      [
        { role: 'system', content: buildAdviceSystemPrompt() },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      { temperature: 0.3, timeoutMs: 45_000, jsonMode: true },
    )
    const parsed = extractJson(text) ?? {}
    data.transport = Array.isArray(parsed.transport) ? parsed.transport : []
    data.weather_tips = typeof parsed.weather_tips === 'string' ? parsed.weather_tips : ''
  } catch (e) {
    console.error('[pipeline] 交通/天气建议生成失败，已降级:', e.message)
    data.warnings.push('交通与天气建议暂不可用，可先按行程出发')
    data.transport = []
    data.weather_tips = ''
  }
}

// ── Step 5：落库 ──────────────────────────────────────────────

/**
 * 把 draft 落库。口径与 routes/trip.js 的 POST /v1/trips 完全一致：
 * 1 条 trips + N 条 trip_days + M 条 trip_items（createDayItems 拆项并解析人均价）
 * + 预算回写。放事务里：中途失败不留半截行程。
 */
function saveDraftTrip(userId, data) {
  const { title, days } = data.draft
  const startIso = normalizeStartDate(data.draft.start_date)
  const destinationId = data.destination?.destination_id ?? null

  const id = 't' + Date.now() + Math.random().toString(36).slice(2, 6)
  const now = new Date().toISOString()
  let personTotal = 0

  transaction(() => {
    run(
      'INSERT INTO trips (id, user_id, title, destination_id, start_date, end_date, day_count, status, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, userId, title, destinationId, startIso, addDays(startIso, days.length - 1), days.length, 'ready', 'ai', now],
    )
    days.forEach((d, i) => {
      const dId = id + '-d' + (i + 1)
      run('INSERT INTO trip_days (id, trip_id, day_index, date, title) VALUES (?,?,?,?,?)', [
        dId, id, i + 1, addDays(startIso, i), String(d),
      ])
      personTotal += createDayItems(id, dId, String(d))
    })
    // 新行程默认 1 成人（权重 1）；后续详情页改人数时 PATCH 会等比重算
    run('UPDATE trips SET budget_total = ? WHERE id = ?', [Math.round(personTotal * 1), id])
  })

  return { id, startIso, budget_total: recalcTripBudget(id) }
}

/** 落库后的轻量通知：与 POST /v1/trips 行为对齐，但都包在 try 里——通知失败不影响主响应 */
function fireNotifications(userId, data, startIso) {
  try {
    notifyTrip(userId, {
      title: data.draft.title,
      preview: `共 ${data.draft.days.length} 天行程，可随时查看或继续调整`,
    })
    // 该用户第一条行程再补一条 AI 免责声明
    if (queryAll('SELECT id FROM trips WHERE user_id = ?', [userId]).length === 1) {
      notifyDisclaimer(userId)
    }
    // 天气恶劣提醒（第 3 步已经拿到 weather，直接复用，不再发第二次请求）
    const hit = (data.weather.days || []).find((d) => ['rain', 'snow', 'thunder', 'fog'].includes(d.icon))
    if (hit) {
      const dayNum = Math.round(
        (Date.parse(`${hit.date}T12:00:00Z`) - Date.parse(`${startIso}T12:00:00Z`)) / DAY_MS,
      ) + 1
      if (dayNum >= 1) notifyWeatherAlert(userId, data.draft.title, `D${dayNum}`, hit.text)
    }
  } catch (e) {
    console.error('[pipeline] 通知发送失败（忽略）:', e.message)
  }
}

// ── 调度入口 ─────────────────────────────────────────────────

/**
 * 跑完整条行程生成流水线。
 *
 * @param {object}   arg
 * @param {number}   arg.userId   当前登录用户 id（来自 authMiddleware）
 * @param {string}   arg.message  用户原始需求（"帮我规划成都3天，带娃，预算宽松"）
 * @param {Array}    [arg.history] 可选对话历史 [{ role:'user'|'ai', text }]
 * @param {boolean}  [arg.persist=true] 是否落库。一键生成接口传 false：
 *   生成结果先回前端，用户在卡片上手动点「保存到行程」才写库（POST /v1/trips）。
 * @returns {Promise<object>} 公共 data 对象（含 draft / weather / transport / trip_id / warnings）
 * @throws  第 1 步生成本体失败时抛 Error，message 是给用户看的友好文案；
 *          天气/建议失败不抛错，降级进 data.warnings。
 */
export async function runPlanningPipeline({ userId, message, history, persist = true }) {
  const data = createSharedData({ userId, message })

  // Step1 致命失败：没有行程就没有后面一切，直接抛给路由层返回错误
  await stepGenerateDraft(data, history)

  // Step2~4 串行：读 data、写 data。天气/建议失败已在各自内部降级
  stepExtractTargets(data)
  await stepFetchWeather(data)
  await stepEnrichAdvice(data)

  // Step5 落库（可选）。persist=false 时只返回生成结果，不写库、不发通知，
  // 由前端手动保存触发 POST /v1/trips（复用原有保存链路）。
  if (persist) {
    // 落库失败属于服务端错误（唯一主键/约束冲突），抛出让路由返回 500
    const saved = saveDraftTrip(userId, data)
    data.trip_id = saved.id
    data.budget_total = saved.budget_total

    fireNotifications(userId, data, saved.startIso)
  }

  return data
}