import express from 'express'
import cors from 'cors'
import compression from 'compression'
import dotenv from 'dotenv'

dotenv.config()

import authRoutes from './routes/auth.js'
import tripRoutes from './routes/trip.js'
import messageRoutes from './routes/message.js'
import userRoutes from './routes/user.js'
import cityRoutes from './routes/city.js'
import chatRoutes from './routes/chat.js'
import weatherRoutes from './routes/weather.js'
import hopRoutes from './routes/hop.js'
import agentRoutes from './routes/agent.js'
import planRoutes from './routes/plan.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }))
app.use(express.json({ limit: '10mb' }))

// gzip 压缩：行程详情/列表这类大 JSON 在手机网络上全量传输很慢，是明显的卡顿点。
// 注意 SSE（text/event-stream）绝不能压缩——压缩会缓冲 token，逐字流式输出就废了。
app.use(
  compression({
    filter: (req, res) =>
      /text\/event-stream/.test(String(res.getHeader('Content-Type') || ''))
        ? false
        : compression.filter(req, res),
  }),
)

// 请求日志
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${req.method}  ${req.url}`)
  next()
})

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ code: 0, data: { status: 'ok', ts: Date.now() }, message: 'ok' })
})

// 业务路由（统一 /api 前缀，与前端 request.ts baseURL 对齐）
app.use('/api/v1/auth', authRoutes)
app.use('/api/v1', cityRoutes)        // /cities  (公开，无需鉴权)
app.use('/api/v1', tripRoutes)        // /trips, /trip/:id
app.use('/api/v1', messageRoutes)     // /messages
app.use('/api/v1', userRoutes)        // /user/profile, /user/footprints
app.use('/api/v1', weatherRoutes)     // /weather（行程每日天气，代理 Open-Meteo）
app.use('/api/v1', hopRoutes)         // /trip/:id/hops（相邻行程项交通衔接）
app.use('/api/v1', agentRoutes)       // /trip/:id/agent（带工具的 agent 会话，SSE）
app.use('/api/v1', planRoutes)        // /plan/trip（一键行程生成：后端串行编排，一次请求出整条行程）
app.use('/api', chatRoutes)           // /chat/stream (SSE)

// 404
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`)
  res.status(404).json({
    code: 404,
    data: null,
    message: `接口不存在：${req.method} ${req.originalUrl}`,
  })
})

// 错误兜底：对外只说「服务器内部错误」，细节只落服务端日志。
// 原来把 err.message 原样回给客户端，会把 SQL 报错、列名、文件路径一起泄漏出去。
// 可预期的业务错误请走 utils/response.js 的 err()，不要靠抛异常。
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err)
  if (res.headersSent) return // SSE 等已开始写的响应，交回 Express 关闭连接
  res.status(500).json({ code: 500, data: null, message: '服务器内部错误' })
})

// 进程级兜底：至少让未处理的异步异常留痕，而不是静默消失
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

app.listen(PORT, () => {
  console.log(`\n🚀 智能旅游助手后端已启动：http://localhost:${PORT}`)
  console.log(`   健康检查：http://localhost:${PORT}/api/health`)
  console.log(`   前端代理目标：/api -> http://localhost:${PORT}\n`)
})
