/**
 * 一键行程生成接口（调度中枢的 HTTP 入口）。
 *
 * 与旧 SSE 聊天链路并存、互不影响：
 *   - POST /api/chat/stream（旧）：流式对话，既能聊也能生成，前端拿 JSON 后还要再调 POST /v1/trips 落库；
 *   - POST /api/v1/plan/trip（本接口，新）：前端只发这一次请求，后端串行跑完
 *     「生成 → 提城市景点 → 查天气 → 补交通/天气建议 → 落库」，一把返回完整结构化 JSON。
 *
 * 人工拖动增删（PATCH item / DELETE item）与增量优化（POST /trip/:id/optimize）
 * 仍走 routes/trip.js，本接口不碰它们。
 */
import { Router } from 'express'
import { ok, err } from '../utils/response.js'
import { authMiddleware } from '../utils/auth.js'
import { rateLimit } from '../utils/rateLimit.js'
import { aiReady } from '../utils/ai.js'
import { runPlanningPipeline } from '../orchestrator/planPipeline.js'

const router = Router()
router.use(authMiddleware)

/**
 * 一次请求背后是 2 次大模型调用 + 1 次天气请求，需要限流控成本。
 * 但不能卡太死：早期 5/min，用户失败后多点几次重试就撞 429，前端只能报"生成失败"。
 * 10/min 对正常重试够用，又挡得住脚本刷。
 */
const planLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `plan:${req.user?.id || req.ip}`,
  message: '生成过于频繁，请稍后再试',
})

/**
 * POST /v1/plan/trip
 * body: { message: '帮我规划成都3天，带娃', history?: [{role, text}] }
 *
 * 成功（code=0）data 字段：
 *   trip_id       新建行程 id（前端可直接跳详情 /trip/:id）
 *   title / start_date / days     初步行程（与原 SSE 返回同构，复用前端解析口径）
 *   weather       { city, days:[{date,text,icon,tmax,tmin}] }
 *   transport     [{ day, spot, mode, duration, cost, note }]
 *   weather_tips  综合天气提醒文案（无天气时为空串）
 *   budget_total  预估总费用（人均价合计 × 默认 1 成人）
 *   warnings      降级提示（天气/建议不可用时填充，正常为空数组）
 *
 * 失败：第 1 步生成本体失败 → code=502，message 为友好提示；
 *       AI 未配置 → code=503；参数缺失 → code=400。
 */
router.post('/plan/trip', planLimiter, async (req, res) => {
  const message = String(req.body?.message || '').trim()
  if (!message) return err(res, '请描述你的出行需求', 400)
  if (!aiReady()) return err(res, 'AI 服务未配置（缺少 AI_API_KEY）', 503)

  try {
    // persist:false —— 只生成不落库。用户在前端卡片上手动点「保存到行程」，
    // 才走 POST /v1/trips 写库（与旧 SSE 卡片的保存完全同一条链路）。
    const data = await runPlanningPipeline({
      userId: req.user.id,
      message,
      history: req.body?.history,
      persist: false,
    })
    ok(res, {
      // 注意：此时没有 trip_id（未保存）。前端拿到后渲染"待保存"卡片
      title: data.draft.title,
      start_date: normalizeDateOut(data.draft.start_date),
      days: data.draft.days,
      destination: data.destination,
      weather: data.weather,
      transport: data.transport,
      weather_tips: data.weather_tips,
      warnings: data.warnings,
    })
  } catch (e) {
    console.error('[plan] 行程流水线失败:', e)
    // 生成本体失败：上游大模型不可用 / 超时。细节只进日志，对外给友好文案
    err(res, e.message || '行程生成失败，请稍后重试', 502)
  }
})

/** 出参日期兜底：保证一定是 YYYY-MM-DD（编排层内部已 normalize，这里只是防御） */
function normalizeDateOut(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null
}

export default router
