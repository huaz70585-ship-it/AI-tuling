import { Router } from 'express'
import { authMiddleware } from '../utils/auth.js'
import { rateLimit } from '../utils/rateLimit.js'
// 景点注入与「名称（价格）」格式规则改由 tripPrompt.js 提供 ——
// trip.js 补排新天时要用同一份口径，两边各写一份早晚漂移
import { citySpotContext, dayFormatRules, boundaryRules } from '../utils/tripPrompt.js'
import { todayInShanghai } from '../utils/date.js'

const router = Router()

/** 同一用户每分钟最多 10 次对话请求。
 *  这个接口直连付费大模型，不设限等于把 API 额度挂在公网上。 */
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `chat:${req.user?.id || req.ip}`,
  message: '对话过于频繁，请稍后再试',
})

// AI 配置（DeepSeek 兼容 OpenAI 格式，可改 .env 切换其他平台）
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.deepseek.com/v1'
const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat'

/** 单点信息问句的确定性识别（防 LLM 偶发误路由）。
 *  背景：只靠 system prompt 分流时，"上海美食推荐"这类句子在默认温度下
 *  仍会偶发被吐成行程 json（实测复现过 5 次全对、第 6 次翻车）。
 *  规则：命中信息类关键词 且 不含任何行程类动词 → 判定为"问信息，不是要行程"，
 *  给模型追加一条硬性提醒（确定性闸门，不依赖模型自觉）。
 *  注意：正则只做"收紧"，不做"放开"——命中行程类动词时交给模型按 prompt 判断。 */
const INFO_RE = /美食|好吃|吃什么|特产|小吃|景点|门票|价格|多少钱|消费|天气|下雨|住宿|酒店|民宿|怎么走|怎么去|交通|地铁|高铁|坐什么车/
const PLAN_RE = /规划|计划|行程|路线|安排|怎么玩|玩几天|几天|排一|日游|自由行|跟团/

export function isInfoQuery(msg) {
  return INFO_RE.test(msg) && !PLAN_RE.test(msg)
}

// 构造 system prompt：注入全部城市的真实景点（来自 city_spots 表），
// 由 AI 按用户提问自行判断目的地 —— 不再依赖前端传城市（城市切换功能已下线）
// 导出只为可测：改 prompt 前后可以比对生成结果，避免悄悄改了模型输入
export function buildSystemPrompt() {
  let p = '你是「途灵」旅行助手，专注中国境内旅行规划。根据用户的目的地、天数、预算，给出可执行的行程建议。语言口语化、有温度，说明文字控制在 200 字内。'

  p += citySpotContext()

  // 必须把今天告诉模型：否则「25号」「下周三」「国庆」这类相对说法它无从推算，
  // 只能默认从今天开始排 —— 这正是「不管说几号都生成今天」的根因。
  const today = todayInShanghai()
  p += `\n【今天的日期】${today.date}（${today.weekday}）。用户提到日期时（「25号」「下周三」「国庆」等），先按今天推算成具体日期再排行程。`

  p += `\n【意图判断——先判断，再回答，非常重要】\n意图只依据用户【当前这条消息】判断，上一轮排过行程不代表这一轮也要排。\n只有当用户【明确要一份多天行程安排】——说了"规划/计划/路线/怎么玩/排几天/行程"这类词，才输出行程 json。\n以下情况【禁止】输出 json，用正常对话回答（可以推荐、可以口语化介绍，但不要排行程）：\n- 问单点信息：美食、景点、价格、门票、交通、天气、住宿（例："上海有什么好吃的""外滩怎么走""上海美食推荐"）；\n- 用户没说目的地（例："附近有什么好玩的"——先反问一句想去哪个城市，不要编造目的地硬排行程）；\n- 纯闲聊（"你好""你是谁""谢谢"）。\n\n【输出行程时的格式——严格遵守】\n确认要输出行程时，回复只包含两部分：\n1) 1-2 句口语化说明（不超过 50 字）；\n2) 紧接着一个 json 代码块。\n【禁止】用 **粗体**、markdown 列表、编号列表等方式排版行程。行程信息只能放在 json 里。\n\njson 格式严格如下（以此为例）：\n用户问"帮我规划成都3天行程"\n你的回复：\n成都3天这样安排，紧凑又不赶：\n\`\`\`json\n{"intent":"plan","title":"成都3日深度游","start_date":"${today.date}","days":["Day1 抵达成都（免费）+宽窄巷子（免费）+锦里夜市（80）","Day2 大熊猫基地（55）+武侯祠（50）+人民公园喝茶（30）","Day3 都江堰（80）+返程（免费）"]}\n\`\`\`\n\n规则：\n- intent：固定填 "plan"。这是行程标记，前端靠它区分"行程"和"普通对话"，没有这个字段不会被识别成行程；\n- title：行程总标题（含目的地+天数）；\n- start_date：出发日期，格式 YYYY-MM-DD。用户说了日期就按他说的填（"25号""下周三""国庆"都先结合今天的日期 ${today.date} 推算）；用户没说日期才填今天 ${today.date}。不能填早于今天的日期；\n${dayFormatRules()}\n${boundaryRules(true, true)}\n- days 长度必须等于用户说的天数（没说默认3天）；\n- 目的地必须有：用户说了城市就排；没说城市就不是行程需求，回到上面的意图判断。`
  return p
}

/**
 * POST /chat/stream  SSE 流式对话
 * 调用大模型 /chat/completions（stream:true），把上游 delta 转成 {delta} 吐给前端
 * 注意：abort 必须监听 res.on('close')，req.on('close') 会在请求体读完就触发
 */
router.post('/chat/stream', authMiddleware, chatLimiter, async (req, res) => {
  const prompt = (req.body?.message || '').trim()
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : []

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  if (!prompt) { res.write('data: [DONE]\n\n'); return res.end() }
  if (!AI_API_KEY) {
    res.write(`data: ${JSON.stringify({ delta: 'AI 未配置：服务端缺少 AI_API_KEY，请在 backend/.env 设置后重启。' })}\n\n`)
    res.write('data: [DONE]\n\n'); return res.end()
  }

  // 客户端断开时中断上游请求（必须监听 res 而非 req）
  const ac = new AbortController()
  res.on('close', () => ac.abort())

  try {
    const systemPrompt = buildSystemPrompt()
    // 确定性闸门：正则判定为单点信息问句时，紧贴用户消息前插一条硬性提醒。
    // 放在最后一条 user 消息前面，权重最高；DeepSeek 兼容多条 system 消息。
    const infoGuard = isInfoQuery(prompt)
      ? [{ role: 'system', content: '【本次判定】用户当前这条消息是在询问单点信息（美食/景点/价格/交通/天气/住宿等），不是要行程安排。请用正常对话回答，禁止输出 json 代码块。' }]
      : []
    const upstream = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      signal: ac.signal,
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map((h) => ({ role: h.role === 'ai' ? 'assistant' : 'user', content: h.text || '' })),
          ...infoGuard,
          { role: 'user', content: prompt },
        ],
        stream: true,
        max_tokens: 4096,
        // 意图分流是分类任务，温度从默认 1.0 收到 0.7，降低偶发误路由的概率
        temperature: 0.7,
      }),
    })

    if (!upstream.ok || !upstream.body) {
      const errText = `AI 请求失败：HTTP ${upstream.status}`
      res.write(`data: ${JSON.stringify({ delta: errText })}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        try {
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta?.content ?? ''
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
        } catch {
          // 非 JSON 行跳过
        }
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    // 客户端主动断开不算错误
    if (err.name === 'AbortError') return
    // 上游错误的细节只进服务端日志，不吐给客户端（可能带上游 URL / 账号等信息）
    console.error('[chat] 上游请求异常:', err)
    res.write(`data: ${JSON.stringify({ delta: 'AI 服务暂时不可用，请稍后重试' })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }
})

export default router
