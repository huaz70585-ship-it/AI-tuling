/**
 * 行程天气查询（Open-Meteo，免费无需 Key）。
 *
 * 抽成独立模块的原因：routes/weather.js（前端直接查）与 agent/tools.js
 * （AI 自主调用工具）都要这份逻辑。两边各写一份的话，WMO 码映射、
 * 坐标缓存、预报范围口径早晚漂移。
 *
 * 对外只暴露 fetchTripWeather(trip) → { city, days }，
 * 所有失败都降级为 days: []（天气是锦上添花，不该让调用方处理异常）。
 */
import { run } from '../db.js'
import { resolveCityFromTitle } from './city.js'

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const FETCH_TIMEOUT_MS = 8000

/** 免费额度只能查到未来 15 天（今天是第 1 天） */
const FORECAST_SPAN_DAYS = 15

const DAY_MS = 86_400_000
const iso = (d) => d.toISOString().slice(0, 10)

/** 城市名 → 经纬度内存缓存（cities 表里没有的城市靠它避免反复 geocode） */
const coordCache = new Map()

/**
 * WMO 天气码 → 中文描述 + 前端图标 key。
 * 图标 key 与 Trip.vue 的 WEATHER_ICONS 一一对应。
 */
const WEATHER_CODES = {
  0: ['晴', 'sunny'],
  1: ['晴间多云', 'sunny'],
  2: ['多云', 'cloudy'],
  3: ['阴', 'overcast'],
  45: ['雾', 'fog'],
  48: ['雾凇', 'fog'],
  51: ['小毛毛雨', 'drizzle'],
  53: ['毛毛雨', 'drizzle'],
  55: ['大毛毛雨', 'drizzle'],
  56: ['冻毛毛雨', 'rain'],
  57: ['冻毛毛雨', 'rain'],
  61: ['小雨', 'rain'],
  63: ['中雨', 'rain'],
  65: ['大雨', 'rain'],
  66: ['冻雨', 'rain'],
  67: ['冻雨', 'rain'],
  71: ['小雪', 'snow'],
  73: ['中雪', 'snow'],
  75: ['大雪', 'snow'],
  77: ['雪粒', 'snow'],
  80: ['阵雨', 'rain'],
  81: ['强阵雨', 'rain'],
  82: ['暴雨', 'rain'],
  85: ['阵雪', 'snow'],
  86: ['强阵雪', 'snow'],
  95: ['雷阵雨', 'thunder'],
  96: ['雷阵雨伴冰雹', 'thunder'],
  99: ['雷暴冰雹', 'thunder'],
}

function describe(code) {
  const hit = WEATHER_CODES[code]
  return hit ? { text: hit[0], icon: hit[1] } : { text: '多云', icon: 'cloudy' }
}

/** 单次 geocode：查到返回坐标；查无此地返回 null（调用方可对更短前缀重试）；网络/超时抛错 */
async function geocodeOnce(name) {
  const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`)
  const json = await res.json()
  const hit = json.results?.[0]
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null
}

/**
 * 城市名 → 经纬度：优先 cities 表已存的，其次内存缓存，最后 geocode 并回填。
 *
 * 地名可能带着标题里的后缀（「南宁中秋5日游」按正则会抓出「南宁中秋」），
 * Open-Meteo 不认识整个串 —— 查无结果时把地名从原长逐字缩短重试，
 * 取第一个能查到的前缀（「南宁中秋」→「南宁」）。查过的前缀（含失败）
 * 记进 coordCache，避免每次请求都把失败链重打一遍。
 */
async function coordinateOf(name, cityRow) {
  if (cityRow?.latitude != null && cityRow?.longitude != null) {
    return { lat: cityRow.latitude, lon: cityRow.longitude, matched: name }
  }
  for (let len = name.length; len >= 2; len--) {
    const part = name.slice(0, len)
    if (coordCache.has(part)) {
      const cached = coordCache.get(part)
      if (cached) return { ...cached, matched: part }
      continue
    }
    try {
      const coord = await geocodeOnce(part)
      if (coord) {
        coordCache.set(part, coord)
        if (cityRow) {
          run('UPDATE cities SET latitude = ?, longitude = ? WHERE id = ?', [coord.lat, coord.lon, cityRow.id])
        }
        return { ...coord, matched: part }
      }
      coordCache.set(part, null) // 负缓存：这个前缀查过且无结果
    } catch {
      // 网络/超时：更短的前缀也一样发不出去，直接放弃（调用方按拿不到天气降级）
      return null
    }
  }
  return null
}

/**
 * 查一条行程每天的天气。
 * 返回 { city, days: [{ date, code, text, icon, tmax, tmin }] }；
 * 定位不到城市、或行程日期已超出预报范围时 days 为空数组（调用方不显示天气，不报错）。
 */
export async function fetchTripWeather(trip) {
  const found = resolveCityFromTitle(trip.title, trip.destination_id)
  if (!found) return { city: null, days: [] }

  // 预报范围：[今天, 今天+15天]，与行程日期取交集
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const minDate = iso(today)
  const maxDate = iso(new Date(today.getTime() + FORECAST_SPAN_DAYS * DAY_MS))
  const start = trip.start_date > minDate ? trip.start_date : minDate
  const end = trip.end_date < maxDate ? trip.end_date : maxDate
  if (start > end) return { city: found.name, days: [] }

  try {
    const coord = await coordinateOf(found.name, found.row)
    if (!coord) return { city: found.name, days: [] }

    const url =
      `${FORECAST_URL}?latitude=${coord.lat}&longitude=${coord.lon}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
      `&timezone=Asia%2FShanghai&start_date=${start}&end_date=${end}`
    const upstream = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!upstream.ok) throw new Error(`forecast HTTP ${upstream.status}`)
    const json = await upstream.json()

    const daily = json.daily || {}
    const days = (daily.time || []).map((date, i) => {
      const code = daily.weather_code?.[i]
      const d = describe(code)
      return {
        date,
        code,
        text: d.text,
        icon: d.icon,
        tmax: Math.round(daily.temperature_2m_max?.[i] ?? 0),
        tmin: Math.round(daily.temperature_2m_min?.[i] ?? 0),
      }
    })
    return { city: coord.matched, days }
  } catch (e) {
    // 天气是锦上添花，拿不到就返回空，不打扰用户（仅服务端记录）
    console.error('[weather]', e.message)
    return { city: found.name, days: [] }
  }
}