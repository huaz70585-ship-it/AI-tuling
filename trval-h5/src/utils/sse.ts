// SSE 流式请求工具
// 浏览器原生 EventSource 仅支持 GET 且无法自定义 Header，
// AI 对话通常需要 POST + 鉴权，因此用 fetch + ReadableStream 自行解析 data: 行。

export interface SseOptions {
  url: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  // 每解析出一段增量 token（OpenAI 风格 delta.content 或纯文本）
  onToken?: (delta: string) => void
  // 每条原始 data: 消息
  onMessage?: (data: string) => void
  onError?: (error: Error) => void
  onDone?: () => void
  // 主动中断（AbortSignal）时回调。刻意与 onDone 分开：
  // 组件卸载触发的 abort，不该再跑去执行 onDone 里的收尾逻辑。
  onAbort?: () => void
}

export async function streamSse(options: SseOptions): Promise<void> {
  const { url, body, headers, signal, onToken, onMessage, onError, onDone, onAbort } = options
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    if (!response.ok || !response.body) {
      // 错误对象带上 HTTP 状态码，让上层能按 4xx/5xx/429 分类成友好文案
      const err = new Error(`SSE 请求失败：HTTP ${response.status}`) as Error & { status?: number }
      err.status = response.status
      throw err
    }

    const reader = response.body.getReader()
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
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          onDone?.()
          return
        }
        onMessage?.(data)
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>
            delta?: string
          }
          const delta = json.choices?.[0]?.delta?.content ?? json.delta ?? ''
          if (delta) onToken?.(delta)
        } catch {
          // 非 JSON 的纯文本，原样吐出
          onToken?.(data)
        }
      }
    }
    onDone?.()
  } catch (err) {
    // abort 不再走 onDone：卸载时的 abort 会让 onDone 作用在已卸载的组件上
    //（解析 JSON 块、往 messages 写状态）。需要中断后收尾的调用方用 onAbort。
    if ((err as Error).name === 'AbortError') {
      onAbort?.()
      return
    }
    onError?.(err as Error)
  }
}

export default streamSse
