import { streamSse } from '../utils/sse'
import { useUserStore } from '../stores/user'

/** 一次工具调用（后端 loop.js 推的 {step} 事件） */
export interface AgentStep {
  round: number
  /** 工具名，如 query_weather / optimize_trip */
  tool: string
  /** 参数预览（已截断，仅用于展示/调试） */
  args: string
  ok: boolean
  /** 是否是写操作（会改库），前端据此提示「将修改行程」 */
  write: boolean
  ms: number
  /** 成功是结果摘要，失败是错误原因 */
  summary: string
}

export interface AgentDoneEvent {
  stop_reason: 'done' | 'max_steps' | 'token_budget' | 'error'
  steps: AgentStep[]
  /** 写操作留下的变更记录，如 { tool, changed_days, budget_total } */
  mutations: Array<Record<string, unknown>>
}

export interface AgentCallbacks {
  /** 每执行完一个工具触发一次，用来显示「正在查天气…」这类进度 */
  onStep?: (step: AgentStep) => void
  /** 最终答复的增量文本 */
  onToken: (delta: string) => void
  onDone?: (e: AgentDoneEvent) => void
  onError?: (e: Error) => void
  onAbort?: () => void
}

/** 一轮对话（纯文本）。与 Chat.vue 的历史格式保持一致 */
export interface AgentTurn {
  role: 'user' | 'ai'
  text: string
}

/**
 * 绑定某条行程的 agent 会话（SSE）。
 *
 * 与 streamChat 的区别：这个有工具、带行程上下文，后端会推 {step} 进度事件。
 * sse.ts 的 onMessage 已经能拿到每条原始消息，所以在这里解析 step/done，
 * 不必改那个通用工具。
 *
 * history 是【跨轮记忆】：只传纯文本轮次即可。工具的效果已经落库、
 * 行程现状每轮都会重新注入 system prompt，所以不需要回放工具调用记录。
 * 少了它，AI 上一句问「要不要帮你把27号调成室内」、用户回「好」时会接不住。
 */
export function streamTripAgent(
  tripId: string,
  message: string,
  callbacks: AgentCallbacks,
  history: AgentTurn[] = [],
): AbortController {
  const controller = new AbortController()
  const userStore = useUserStore()
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'

  // done 事件在 [DONE] 之前到达，先存下来，等流结束再回调（保证顺序：先 token 后 done）
  let doneEvent: AgentDoneEvent | null = null

  streamSse({
    url: `${baseUrl}/v1/trip/${tripId}/agent`,
    body: { message, history },
    headers: userStore.token ? { Authorization: `Bearer ${userStore.token}` } : undefined,
    signal: controller.signal,
    onMessage: (raw) => {
      try {
        const evt = JSON.parse(raw) as { step?: AgentStep; done?: boolean } & AgentDoneEvent
        if (evt.step) callbacks.onStep?.(evt.step)
        else if (evt.done) doneEvent = evt
      } catch {
        // 非 JSON 行忽略
      }
    },
    onToken: callbacks.onToken,
    onDone: () =>
      callbacks.onDone?.(
        doneEvent ?? { stop_reason: 'done', steps: [], mutations: [] },
      ),
    onError: callbacks.onError,
    onAbort: callbacks.onAbort,
  })

  return controller
}

/** 工具名 → 中文进度文案（后端只回工具名，展示层自己决定怎么说） */
export const AGENT_TOOL_LABEL: Record<string, string> = {
  query_weather: '查询行程天气',
  optimize_trip: '重排行程并保存',
}
