import { Router } from 'express'
import { queryOne, queryAll } from '../db.js'
import { authMiddleware } from '../utils/auth.js'
import { rateLimit } from '../utils/rateLimit.js'
import { aiReady } from '../utils/ai.js'
import { isPlaceholderTitle } from '../utils/tripStore.js'
import { runAgentLoop } from '../agent/loop.js'

const router = Router()

/** agent 一次请求可能触发多次模型/工具调用，比普通对话更贵，限流收得更紧 */
const agentLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyFn: (req) => `agent:${req.user?.id || req.ip}`,
  message: 'AI 调整过于频繁，请稍后再试',
})

/**
 * system prompt：把行程现状直接喂进上下文。
 *
 * 现状（标题/日期/人数/预算/每天安排）写进 prompt，而不是让模型调工具去查 ——
 * 这是「一查就有的固定上下文」，多一轮工具调用纯属浪费额度和时间。
 * 工具留给真正需要外部动作的事：查天气、改行程。
 */
function buildAgentSystemPrompt(trip, days) {
  const plan = days.length
    ? days.map((d) => `Day${d.day_index}：${d.title}`).join('\n')
    : '（还没有任何安排）'
  return [
    '你是「途灵」旅行助手，正在和用户一起调整他【已经存在】的一趟行程。',
    '\n\n【当前行程】',
    `\n标题：${trip.title}`,
    `\n日期：${trip.start_date} 至 ${trip.end_date}（共 ${trip.day_count} 天）`,
    `\n出行人数：${trip.traveler || '{"adults":1}'}`,
    `\n当前总预算：¥${trip.budget_total}`,
    `\n当前安排：\n${plan}`,
    '\n\n【你能做的事】',
    '\n你有两个工具，需要时自己调用：',
    '\n- query_weather：查这趟行程每天的天气。用户问天气、或你要判断某天适不适合排户外项目时调用。',
    '\n- optimize_trip：按用户要求重排整条行程并直接写入数据库。用户明确要求改动行程时调用。',
    '\n\n【行为准则——严格遵守】',
    '\n1. 用户只是问信息（天气、某个景点怎么样、闲聊），就正常回答，不要调用 optimize_trip。',
    '\n2. 用户提出改动要求时，调用 optimize_trip，把要求总结成一句自然语言放进 instruction。',
    '\n3. 绝不在回复里输出行程 json 代码块 —— 行程改动一律通过 optimize_trip 落库，用户会在行程页看到结果。',
    '\n4. 天气只能来自 query_weather 的返回。查不到就如实说查不到，不要自己猜一个天气。',
    '\n5. 回复口语化、有温度，控制在 150 字内。改动完成后，用一句话说清你改了什么。',
  ].join('')
}

/** 单条历史文本上限。历史来自请求体，是外部输入 —— 不设上限的话
 *  客户端可以塞几 MB 文本进来，白白烧 token（也顺便挡住超长垃圾输入）。 */
const MAX_TURN_CHARS = 1000

/** 最多带几轮历史。太多会挤占 token 预算，也会让模型被陈旧话题带偏 */
const MAX_TURNS = 10

/**
 * 把前端传来的轮次整理成 messages（跨轮记忆）。
 *
 * 只带【纯文本轮次】，不带工具调用记录：工具的效果都已落库，且每轮
 * system prompt 都会重新注入最新行程，所以模型看到的现状永远是最新的，
 * 不需要回放 tool_calls（也就绕开了 tool_call_id 配对的麻烦）。
 *
 * role 在这里被【强制】收敛成 assistant / user —— 客户端传 role: 'system'
 * 会被映射成 user，防止有人借历史注入 system 级指令。
 */
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((h) => h && typeof h.text === 'string' && h.text.trim())
    .slice(-MAX_TURNS)
    .map((h) => ({
      role: h.role === 'ai' ? 'assistant' : 'user',
      content: h.text.slice(0, MAX_TURN_CHARS),
    }))
}

/**
 * POST /v1/trip/:id/agent  带工具的对话（SSE）
 *
 * 事件流：
 *   { step }   每执行完一个工具推一条（前端显示「正在查天气…」）
 *   { delta }  最终文本答复
 *   { done }   收尾：steps / mutations / stop_reason
 *   [DONE]     流结束
 *
 * 与 /chat/stream 分开的原因：那个是纯聊天（无工具、无行程上下文），
 * 这个是绑定某条行程的 agent 会话，两者的 prompt、限流、事件格式都不同。
 */
router.post('/trip/:id/agent', authMiddleware, agentLimiter, async (req, res) => {
  const prompt = String(req.body?.message || '').trim()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const endWith = (event) => {
    if (event) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }

  if (!aiReady()) return endWith({ delta: 'AI 未配置：服务端缺少 AI_API_KEY。' })

  const trip = queryOne('SELECT * FROM trips WHERE id = ?', [req.params.id])
  if (!trip) return endWith({ delta: '行程不存在。' })
  if (trip.user_id !== req.user.id) return endWith({ delta: '无权访问这趟行程。' })
  if (!prompt) return endWith({ delta: '请先说明你想怎么调整。' })

  // 客户端断开就别再往下跑了（否则模型还在烧额度）
  const ac = new AbortController()
  res.on('close', () => ac.abort())

  const days = queryAll(
    'SELECT day_index, title FROM trip_days WHERE trip_id = ? ORDER BY day_index',
    [trip.id],
  ).filter((d) => !isPlaceholderTitle(d.title))

  const result = await runAgentLoop({
    messages: [
      { role: 'system', content: buildAgentSystemPrompt(trip, days) },
      ...normalizeHistory(req.body?.history),
      { role: 'user', content: prompt },
    ],
    ctx: { trip },
    onEvent: (e) => {
      if (ac.signal.aborted) return
      res.write(`data: ${JSON.stringify(e)}\n\n`)
    },
  })

  if (ac.signal.aborted) return

  // 模型没给出答复（报错 / 超过 token 预算）时给一句人能看懂的话，别让前端空着
  const fallback =
    result.stopReason === 'error'
      ? 'AI 服务暂时不可用，请稍后重试。'
      : result.stopReason === 'token_budget'
        ? '这次调整太复杂，已经超出单次额度，请拆成更小的要求再试。'
        : '这次没有生成有效回复，请换个说法再试。'
  const text = result.content?.trim() || fallback

  if (text) res.write(`data: ${JSON.stringify({ delta: text })}\n\n`)

  endWith({
    done: true,
    stop_reason: result.stopReason,
    steps: result.steps,
    mutations: result.mutations,
  })
})

export default router
