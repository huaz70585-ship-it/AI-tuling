/**
 * Agent 循环：让模型自己决定「调哪个工具、调几次」。
 *
 * 与 chatCompletion 一次调用到底的区别就在这个 for：
 *   模型要调工具 → 我们执行 → 把结果塞回对话 → 再问模型 → …直到它给出文本答案。
 * 控制权从「代码写死流程」交到了模型手里 —— 这就是 agent 与普通 LLM 调用的分界线。
 *
 * 三道兜底（自主循环最容易翻车的地方）：
 * 1. maxSteps：限制最大轮数，防止模型反复调同一个工具把额度烧光；
 * 2. maxTokens：累计 token 超预算就停；
 * 3. 工具错误不抛异常，作为一条 tool 消息回给模型 —— 让它自己修正，
 *    而不是整个请求 500（模型参数给错是常态，不是异常）。
 */
import { chatCompletion } from '../utils/ai.js'
import { TOOL_SCHEMAS, executeTool, WRITE_TOOLS } from './tools.js'

/** 最多几轮「模型 ⇄ 工具」交互。旅游场景 4 轮足够：查天气 → 改行程 → 汇报 */
const DEFAULT_MAX_STEPS = 4

/** 单次 agent 任务的累计 token 上限，防止死循环烧钱 */
const DEFAULT_MAX_TOKENS = 12_000

const TRACE_PREVIEW = 120

/** 参数可能不是合法 JSON（模型偶发输出），日志里截断即可，不要把循环打断 */
function previewArgs(raw) {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
  return s.length > TRACE_PREVIEW ? `${s.slice(0, TRACE_PREVIEW)}…` : s
}

/**
 * 跑完一次 agent 任务。
 *
 * @param {object[]} messages   初始对话（system + user）
 * @param {object}   ctx        工具上下文，见 tools.js（{ trip }）
 * @param {(e:object)=>void} [onEvent] 过程回调，route 用它推进度给前端
 * @returns {{content:string, steps:object[], mutations:object[], stopReason:string, tokens:number}}
 *   stopReason: done | max_steps | token_budget | error
 */
export async function runAgentLoop({
  messages,
  ctx,
  onEvent,
  maxSteps = DEFAULT_MAX_STEPS,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  const convo = [...messages]
  const steps = []
  const mutations = []
  let tokens = 0

  for (let round = 1; round <= maxSteps; round++) {
    let message
    let usage
    try {
      ({ message, usage } = await chatCompletion(convo, {
        tools: TOOL_SCHEMAS,
        // 0.3：工具选择要的是稳，不需要创意（但也别到 0，容易在两种工具间死板二选一）
        temperature: 0.3,
        timeoutMs: 60_000,
      }))
    } catch (e) {
      return { content: '', steps, mutations, stopReason: 'error', error: e.message, tokens }
    }

    tokens += Number(usage?.total_tokens) || 0
    const calls = message.tool_calls || []

    // assistant 这轮的消息必须原样入历史（含 tool_calls），
    // 否则下一轮请求里 tool 结果会找不到对应的调用而报错
    convo.push({
      role: 'assistant',
      content: message.content ?? '',
      ...(calls.length ? { tool_calls: calls } : {}),
    })

    // 没有工具调用 = 模型给出最终答复，收工
    if (!calls.length) {
      return { content: message.content ?? '', steps, mutations, stopReason: 'done', tokens }
    }

    for (const call of calls) {
      const name = call.function?.name ?? ''
      const argsRaw = call.function?.arguments ?? '{}'
      const started = Date.now()
      const result = await executeTool(name, argsRaw, ctx)

      const step = {
        round,
        tool: name,
        args: previewArgs(argsRaw),
        ok: result.ok,
        write: WRITE_TOOLS.has(name),
        ms: Date.now() - started,
        summary: result.ok ? (result.summary ?? '') : (result.error ?? ''),
      }
      steps.push(step)
      if (result.mutated) mutations.push({ tool: name, ...(result.data ?? {}) })
      onEvent?.({ type: 'step', step })

      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(
          result.ok
            ? { ok: true, result: result.summary, ...(result.data ? { data: result.data } : {}) }
            : { ok: false, error: result.error },
        ),
      })
    }

    if (tokens > maxTokens) {
      return { content: '', steps, mutations, stopReason: 'token_budget', tokens }
    }
  }

  // 轮数用完还没给出答复：去掉 tools 再问一次，逼出一段文本总结。
  // 不给这一步的话用户会看到「转了几圈什么都没说」。
  try {
    const { message, usage } = await chatCompletion(
      [...convo, { role: 'system', content: '已达到本次工具调用上限。请直接根据已有信息用中文回答用户，不要再调用工具。' }],
      { temperature: 0.3, timeoutMs: 30_000 },
    )
    tokens += Number(usage?.total_tokens) || 0
    return { content: message.content ?? '', steps, mutations, stopReason: 'max_steps', tokens }
  } catch (e) {
    return { content: '', steps, mutations, stopReason: 'max_steps', error: e.message, tokens }
  }
}
