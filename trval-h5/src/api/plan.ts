import { request } from '../utils/request'

/**
 * 一键行程生成（后端编排层）。
 *
 * 与旧 SSE 聊天（/chat/stream）的分工：
 *   - 行程类需求（"帮我规划成都3天"）走这里：后端串行跑完
 *     「生成 → 提城市景点 → 查天气 → 补交通/天气建议 → 落库」，一次请求出整条行程；
 *   - 单点问答 / 闲聊继续走 streamChat，本接口不碰。
 */
export interface PlanTripResult {
  /** 行程标题 */
  title: string
  start_date: string | null
  days: string[]
  weather: { city: string | null; days: unknown[] }
  transport: unknown[]
  weather_tips: string
  /** 降级提示（天气/建议不可用时填充，正常为空数组） */
  warnings: string[]
}

/**
 * @param message 用户原始需求
 * @param history 可选对话上下文 [{ role:'user'|'ai', text }]
 * @param signal  可选 AbortSignal（点「停止」时取消请求）
 *
 * timeout 40s：后端是 2 次大模型（60s+45s 超时）串行 + 重试，
 * 前端给足冗余，别用默认 15s 提前掐断。
 * silent: true：不弹拦截器的后端报错文案，由调用方统一弹「行程生成失败，请稍后重试」。
 */
export function generateTrip(
  message: string,
  history?: Array<{ role: 'user' | 'ai'; text: string }>,
  signal?: AbortSignal,
) {
  return request<PlanTripResult>({
    url: '/v1/plan/trip',
    method: 'POST',
    data: { message, history },
    timeout: 40_000,
    silent: true,
    signal,
  })
}
