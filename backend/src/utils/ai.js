/**
 * 大模型一次性调用（非流式）。
 *
 * 与 chat.js 的流式通道分开：交通衔接这类任务只要一个完整 JSON，
 * 非流式实现更简单（不用解 SSE），实测延迟也在 200-500ms，够用。
 * 配置与 chat.js 同源（AI_BASE_URL / AI_API_KEY / AI_MODEL）。
 *
 * 注意：环境变量在【函数内】读取，不在模块顶层 —— 否则和 dotenv.config() 的
 * 加载顺序耦合，一旦本模块先于 db.js 求值就会读到空值。
 */

/** 运行时读取配置 */
export function aiConfig() {
  return {
    baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'deepseek-chat',
  }
}

export const aiReady = () => Boolean(aiConfig().apiKey)

/**
 * 值得重试的上游状态码：限流与网关抖动。
 * 实测 DeepSeek 网关会偶发 502，一次抖动就让整批交通衔接失败，代价太大。
 */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 调一次大模型，返回原始 message（含 tool_calls）与 usage。
 *
 * 传 tools 时开启 function calling：模型可能不返回文本，而是返回
 * message.tool_calls（要调哪个工具、参数是什么）—— agent 循环靠它驱动。
 * 不传 tools 时行为与原来完全一致，老的 chatOnce 调用方不受影响。
 *
 * 失败会重试（默认 2 次，退避 400ms / 1.6s）：
 * - 429 / 5xx（限流、网关抖动）—— 这是线上最常见的偶发失败；
 * - 网络层异常（连接被重置等）。
 * 自身超时（AbortError）不重试：那是「上游太慢」，再等一遍只会更慢。
 */
export async function chatCompletion(
  messages,
  { tools, temperature = 0, timeoutMs = 15_000, retries = 2, jsonMode = false } = {},
) {
  const { baseUrl, apiKey, model } = aiConfig()
  if (!apiKey) throw new Error('AI_API_KEY 未配置')

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature,
          ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
          // jsonMode：开启 OpenAI 兼容的 JSON 模式，强制模型只吐合法 JSON
          // （不包 ```json 围栏、不写前后废话）。DeepSeek 兼容该参数。
          // 与 extractJson() 配合：prompt 里仍要写清字段格式，双保险。
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: ac.signal,
      })
      if (!res.ok) {
        const e = new Error(`上游 HTTP ${res.status}`)
        e.status = res.status
        if (TRANSIENT_STATUS.has(res.status) && attempt < retries) {
          lastErr = e
          await sleep(400 * (attempt + 1) ** 2)
          continue
        }
        throw e
      }
      const json = await res.json()
      return {
        message: json.choices?.[0]?.message ?? { role: 'assistant', content: '' },
        usage: json.usage ?? null,
      }
    } catch (e) {
      // e.status 有值说明是上面明确抛出的上游状态错误（非瞬时的那类），原样向上抛。
      // 没 status 且不是主动超时 = 网络层失败，重试。
      const transient = !e.status && e.name !== 'AbortError'
      if (transient && attempt < retries) {
        lastErr = e
        await sleep(400 * (attempt + 1) ** 2)
        continue
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('AI 请求失败')
}

/**
 * 调一次大模型，返回纯文本内容。
 * temperature 默认 0：交通方案要的是稳定结论，不是创意。
 */
export async function chatOnce(messages, opts) {
  const { message } = await chatCompletion(messages, opts)
  return message.content ?? ''
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 包裹与前后废话） */
export function extractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}
