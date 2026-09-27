import { Router } from 'express'
import { queryOne } from '../db.js'
import { ok, err } from '../utils/response.js'
import { authMiddleware } from '../utils/auth.js'
import { fetchTripWeather } from '../utils/forecast.js'

const router = Router()

// 行程天气接口都需要登录
router.use(authMiddleware)

/**
 * GET /v1/weather?tripId=xxx  行程每天的天气
 * 逻辑全在 utils/forecast.js —— agent 的 query_weather 工具复用同一份，
 * 避免「前端查到的天气」和「AI 说的天气」两个口径。
 */
router.get('/weather', async (req, res) => {
  const tripId = String(req.query.tripId || '')
  if (!tripId) return err(res, '缺少 tripId')

  const trip = queryOne('SELECT * FROM trips WHERE id = ?', [tripId])
  if (!trip) return err(res, '行程不存在', 404)
  if (trip.user_id !== req.user.id) return err(res, '无权访问', 403)

  ok(res, await fetchTripWeather(trip))
})

export default router