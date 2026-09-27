/**
 * Agent 工具集：把后端已有的能力声明成 LLM 可以【自主调用】的 function。
 *
 * 与「路由自己决定调什么」的区别：这里只声明能力和参数格式，
 * 「要不要查天气、查到下雨后要不要改行程」由模型在 agent 循环里自己判断
 * （见 loop.js）。所以 description 是写给模型看的，要说清什么时候该用。
 *
 * 参数校验用 zod：模型给的参数是「生成的」，不是「传进来的」——
 * 实测会漏字段、给字符串数字、偶尔给不存在的参数名，先校验再执行，
 * 校验失败当成一条 tool 结果回给模型让它自己改，而不是抛异常终止整个循环。
 */
import { z } from 'zod'
import { queryOne, queryAll } from '../db.js'
import { chatOnce, extractJson } from '../utils/ai.js'
import { fetchTripWeather } from '../utils/forecast.js'
import { buildOptimizeTripMessages } from '../utils/tripPrompt.js'
import { writeDayPlan, recalcTripBudget, isPlaceholderTitle } from '../utils/tripStore.js'

/** 写操作工具：会改库。循环里据此把它们单独标出来给前端提示 */
export const WRITE_TOOLS = new Set(['optimize_trip'])

/**
 * 给 LLM 看的工具声明（OpenAI function calling 格式）。
 * parameters 手写而非由 zod 自动生成 —— 只有两个工具，多引一个转换依赖不划算。
 */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'query_weather',
      description:
        '查询这趟行程每天的天气预报（城市 + 每天日期/天气/最高最低温）。' +
        '在建议户外景点、判断某天是否适合出行、或用户问天气时调用。只能查当前这趟行程，不能查其他城市。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'optimize_trip',
      description:
        '按用户的要求重排整条行程，并【立即写入数据库】（会覆盖原有安排、重算总预算）。' +
        '仅当用户明确要求改动行程内容（换景点、加美食、调整节奏、去掉某类项目）时调用；' +
        '只是问信息、闲聊、或用户还在讨论想法时不要调用。',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: '把用户想怎么调整总结成一句自然语言，如「购物太多，换成亲子项目」',
          },
        },
        required: ['instruction'],
        additionalProperties: false,
      },
    },
  },
]

/** 各工具的参数校验器（与上面的 parameters 一一对应） */
const validators = {
  query_weather: z.object({}),
  optimize_trip: z.object({ instruction: z.string().trim().min(1).max(120) }),
}

/** 工具实现。ctx = { trip }（trip 是当前行程的库行，执行前由调用方查好） */
const handlers = {
  async query_weather(_args, { trip }) {
    const { city, days } = await fetchTripWeather(trip)
    if (!days.length) {
      return {
        ok: true,
        // 拿不到是正常降级（城市定位不到 / 日期超出预报范围），要让模型知道
        // 「是查不到，不是没下雨」，否则它会顺着编一个天气出来
        summary: '查不到这趟行程的天气预报（城市没定位到，或出行日期超出 15 天预报范围）。请如实告诉用户暂时查不到，不要猜。',
        data: { city, days: [] },
      }
    }
    const summary = `${city}未来天气：` + days.map((d) => `${d.date} ${d.text} ${d.tmin}~${d.tmax}°C`).join('；')
    return { ok: true, summary, data: { city, days } }
  },

  async optimize_trip(args, { trip }) {
    const existingDays = queryAll(
      'SELECT day_index, title FROM trip_days WHERE trip_id = ? ORDER BY day_index',
      [trip.id],
    ).filter((d) => !isPlaceholderTitle(d.title))

    // 工具内部再调一次模型：直接复用 /optimize 那套 prompt，
    // 保证「AI 通过工具改的行程」和「用户点按钮改的行程」格式、口径完全一致
    const content = await chatOnce(
      buildOptimizeTripMessages({
        title: trip.title,
        totalDays: trip.day_count,
        existingDays,
        instruction: args.instruction,
      }),
      { temperature: 0.7, timeoutMs: 60_000 },
    )

    const list = extractJson(content)?.days
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, error: '重排没有产出可用的行程（模型返回格式不对），可以换个说法再试一次。' }
    }

    // 逐天落库；模型偶尔会漏天，没给到的天保持原样，不算失败
    const changed = []
    for (let i = 0; i < trip.day_count; i++) {
      const summary = String(list[i] ?? '').trim()
      if (!summary) continue
      if (writeDayPlan(trip.id, i + 1, summary)) changed.push(i + 1)
    }
    if (!changed.length) {
      return { ok: false, error: '重排没有改动任何一天，请让用户换个说法。' }
    }

    const budget = recalcTripBudget(trip.id)
    return {
      ok: true,
      summary: `已重排第 ${changed.join('、')} 天，写入成功。新的总预算 ¥${budget}。`,
      data: { changed_days: changed, budget_total: budget },
      mutated: true,
    }
  },
}

/** 工具名列表（route 里做白名单/日志用） */
export const TOOL_NAMES = Object.keys(validators)

/**
 * 执行一个工具调用。
 * 任何失败都返回 { ok: false, error }，【不抛异常】——
 * 错误是给模型看的一条消息，让它自己修正或向用户解释，
 * 而不是把整个 agent 循环打断。
 */
export async function executeTool(name, argsRaw, ctx) {
  const validator = validators[name]
  if (!validator) return { ok: false, error: `没有名为 ${name} 的工具。` }

  let args
  try {
    args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw ?? {})
  } catch {
    return { ok: false, error: '参数不是合法的 JSON，请重新给出参数。' }
  }

  const parsed = validator.safeParse(args)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '参数'}：${i.message}`)
      .join('；')
    return { ok: false, error: `参数不合法（${detail}），请修正后重试。` }
  }

  try {
    return await handlers[name](parsed.data, ctx)
  } catch (e) {
    console.error(`[agent] 工具 ${name} 执行异常:`, e)
    return { ok: false, error: `${name} 执行失败：${e.message}` }
  }
}

/** 供 route 组装上下文的雏形（保持 trip 的新鲜度：写操作后可能已变） */
export function loadTrip(tripId) {
  return queryOne('SELECT * FROM trips WHERE id = ?', [tripId])
}
