import { request } from '../utils/request'

/** 交通方式（后端已收敛到这个枚举，未知一律 unknown） */
export type HopMode = 'walk' | 'bus' | 'metro' | 'taxi' | 'bike' | 'coach' | 'unknown'

/** 分步走法的一步：图标动作 + 一句话说明 */
export interface HopStep {
  /** 步骤图标类型（walk/metro/bus/taxi/bike/coach/exit/transfer） */
  icon: string
  text: string
}

/** 备选交通方式（与主推同结构；点击衔接条可本地切换） */
export interface AltHop {
  mode: HopMode
  duration_min: number | null
  cost_ref: number | null
  /** 这个备选方式的详细分步走法（坐几号线/换乘/哪站下/哪个口） */
  steps?: HopStep[]
}

/** 相邻两个行程项之间的一段交通衔接 */
export interface TripHop {
  from_item_id: string
  to_item_id: string
  from_title: string
  to_title: string
  /** AI 未生成或生成失败时为 null，前端据此不渲染这一段 */
  mode: HopMode | null
  duration_min: number | null
  cost_ref: number | null
  tip: string
  /** 这段路除主选外的 2~3 个备选方式（本地切换用，可缺省） */
  alts?: AltHop[]
  /** 主选方式的详细分步走法（坐几号线/换乘/哪站下/哪个口；空数组退回单句 tip） */
  steps?: HopStep[]
  source: string | null
  /**
   * 'return' = 这一段是「当天最后一站 → 返程」。
   * 返程项本身没有地名（就写「返程」两个字），后端按「当地的火车站 / 机场」
   * 这个占位语义估的时长，前端据此把目标写成「车站 / 机场」。其余段为 null。
   */
  kind?: 'return' | null
}

export interface TripHops {
  trip_id: string
  day: number
  hops: TripHop[]
  /** 当日交通合计（仅展示用，不计入行程总预算） */
  total_cost: number
  total_min: number
  /** 'AI 未配置' / 'AI 暂时不可用'；正常为 null */
  ai_error: string | null
}

/**
 * 某天相邻行程项之间的交通衔接：GET /v1/trip/:id/hops?day=N
 * 后端缓存优先，命中时毫秒级返回；首次访问会调一次大模型（约 1 秒）。
 * 失败时 hops 里的 mode 为 null，前端静默不展示，不影响主流程。
 *
 * silent：这是「锦上添花」的后台增强，不是用户主动发起的操作。
 * 移动行程项后会自动重拉，若此时上游抖动，不该弹一个「502」打断用户 —— 
 * 拿不到就退回不展示，下次打开再补。
 */
export function getTripHops(tripId: string, day: number): Promise<TripHops> {
  return request<TripHops>({
    url: `/v1/trip/${tripId}/hops`,
    method: 'GET',
    params: { day },
    silent: true,
  })
}
