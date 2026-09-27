import { request } from '../utils/request'

// ═══════════════════════════════════════════════════════════════
// 契约类型：与《接口契约与数据模型 v1.0》trip / trip_day / trip_item 一字对齐
// 字段语义见契约文档 §1；本文件是前端数据层的唯一事实来源
// ═══════════════════════════════════════════════════════════════

/** trip.status：draft 生成前 / generating 生成中 / ready 可用 / archived 归档 */
export type TripStatus = 'draft' | 'generating' | 'ready' | 'archived'
/** trip.source：行程的来源 */
export type TripSource = 'ai' | 'user' | 'mix'
/** trip_item.type */
export type TripItemType = 'sight' | 'hotel' | 'meal' | 'transport' | 'note'
/** trip_item.source：可追溯，AI 重排只碰 ai 来源且未锁定的项 */
export type TripItemSource = 'ai' | 'user' | 'system'

/** trip.traveler JSON：{ adults: 2, children: [{ age: 6 }] } */
export interface Traveler {
  adults: number
  children?: { age: number }[]
}

/** 行程（契约 §1 trip 表） */
export interface Trip {
  id: string
  user_id: string
  title: string
  destination_id: string | null
  start_date: string // ISO YYYY-MM-DD
  end_date: string
  day_count: number
  traveler: Traveler
  budget_total: number
  status: TripStatus
  /** 乐观锁：写操作带 If-Match，冲突 409 */
  revision: number
  source: TripSource
  updated_at: string
}

/** 行程天（契约 §1 trip_day 表） */
export interface TripDay {
  id: string
  trip_id: string
  day_index: number
  date: string
  title: string
  summary: string
  theme_tags: string[]
}

/** 行程项（契约 §1 trip_item 表） */
export interface TripItem {
  id: string
  trip_id: string
  trip_day_id: string
  sort_order: number
  type: TripItemType
  ref_poi_id: string | null
  /** 可直接下单的挂商品；为 null 表示纯参考项 */
  ref_product_id: string | null
  title: string
  subtitle: string
  cover_url: string | null
  /** 本地时区 HH:mm，跨时区不换算（契约 §3） */
  start_time: string
  duration_min: number | null
  price_ref: number | null
  /** 冻结价，publish 时写入；之后价格变动不改快照 */
  price_snapshot: { amount: number; currency: 'CNY'; captured_at: string } | null
  /** 用户锁定后 AI 重排不碰 */
  locked: boolean
  source: TripItemSource
  /** 低于阈值（前端约定 0.7）标「待确认」 */
  ai_confidence: number | null
  note: string
  /**
   * 打卡时间戳（行中模式）。null = 还没去过。
   * 是时间戳而不是布尔量：既能判断去没去过，也能显示几点去的。
   */
  done_at: string | null
  /**
   * 边界项标记：arrival = 抵达（固定在当天首位）/ closing = 返程（固定在末位）/ null = 普通项。
   * 由后端按标题语义判定（与移动接口的拦截同一口径），前端只读不算 ——
   * 正则只留后端一份，避免两边各写一套导致「前端说能拖、后端拒绝」。
   */
  boundary: 'arrival' | 'closing' | null
}

/** GET /v1/trip/{id} 全量拉取：trip + days[]（每层含 items[]） */
export interface TripDetail extends Trip {
  days: (TripDay & { items: TripItem[] })[]
  /**
   * PATCH /v1/trip/:id 与 POST /v1/trip/:id/day/:dayIndex/generate 的附加信息，
   * 其余接口不返回（所以是可选的）。
   * 日期变长时后端会为新多出来的天调 AI 补排行程：
   * - appended_days：本次实际补排成功的天序号，如 [2,3,4]
   * - ai_error：补排失败的原因（AI 未配置 / 上游失败），**失败不回滚日期**，新天会留空
   *
   * 天数一变，行程边界就被推开，后端会顺手摘掉旧边界上失效的收尾项（如旧最后一天的
   * 「返程」—— 留着会和补排出来的新最后一天撞成两个返程），再给被摘短的那天补回内容：
   * - stale_closings：被摘掉的越界边界项，如 [{ day_index: 3, title: '返程（免费）' }]
   * - refilled_days：摘短之后又补齐了的天序号
   */
  appended_days?: number[]
  refilled_days?: number[]
  stale_closings?: { day_index: number; title: string }[]
  ai_error?: string | null
  /**
   * POST /v1/trip/:id/optimize 的附加信息：
   * 整条行程按「口语要求」优化后，实际重写成功的天序号。
   */
  optimized_days?: number[]
}

// ── 列表行（契约补遗：GET /v1/trips，见契约文档「补遗」一节）────
export interface TripListItem extends Trip {
  item_count: number
  pending_count: number
}

// ═══════════════════════════════════════════════════════════════
// 视图模型辅助：状态推导 / 格式化（列表页与「我的」页共用）
// ═══════════════════════════════════════════════════════════════

export type DerivedTripState = 'generating' | 'upcoming' | 'ongoing' | 'done'

export interface DerivedTripStateInfo {
  state: DerivedTripState
  stateText: string
  /** TripList 卡片样式档位 */
  style: 'ai' | 'soon' | 'live' | 'done'
}

/** 由 status + 日期推导展示态（与筛选器的 upcoming/ongoing 语义一致） */
export function deriveTripState(t: Trip): DerivedTripStateInfo {
  if (t.status === 'generating' || t.status === 'draft') {
    return { state: 'generating', stateText: 'AI 规划中', style: 'ai' }
  }
  if (t.status === 'archived') {
    return { state: 'done', stateText: '已完成', style: 'done' }
  }
  const today = new Date()
  const start = new Date(`${t.start_date}T00:00:00`)
  const end = new Date(`${t.end_date}T23:59:59`)
  if (today < start) {
    const days = Math.ceil((start.getTime() - today.getTime()) / 86_400_000)
    return { state: 'upcoming', stateText: `${days}天后出发`, style: 'soon' }
  }
  if (today > end) {
    return { state: 'done', stateText: '已完成', style: 'done' }
  }
  // 进行中：第几天由起始日差值算
  const dayNo = Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1
  return { state: 'ongoing', stateText: `进行中 · D${dayNo}`, style: 'live' }
}

/** 出行人数：成人与儿童合计 */
export function travelerCount(t: Trip): number {
  return t.traveler.adults + (t.traveler.children?.length ?? 0)
}

/** '2026-10-12' ~ '2026-10-15' → '10.12 - 10.15' */
export function formatDateRange(start: string, end: string): string {
  const f = (iso: string) => iso.slice(5).replace('-', '.')
  return `${f(start)} - ${f(end)}`
}

/** '2026-10-12' → '10.12 周六' */
export function formatDateCn(iso: string): string {
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${iso}T12:00:00`).getDay()]
  return `${iso.slice(5).replace('-', '.')} 周${week}`
}

/** 3860 → '3,860'（千分位，无小数） */
export function formatMoney(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}

/** 「待确认」阈值：ai_confidence 低于此值前端标出 */
export const AI_CONFIRM_THRESHOLD = 0.7

// ═══════════════════════════════════════════════════════════════
// 接口函数
// ═══════════════════════════════════════════════════════════════

// MOCK 开关：后端 /v1/trips 与 /v1/trip/{id} 就绪后改为 false（本文件其余不动）
const USE_MOCK = false

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 用户行程列表（契约补遗：GET /v1/trips） */
export async function getTrips(): Promise<TripListItem[]> {
  if (!USE_MOCK) {
    return request<TripListItem[]>({ url: '/v1/trips', method: 'GET' })
  }
  await sleep(300)
  return MOCK_TRIP_LIST.map((t) => ({ ...t }))
}

/** 行程详情全量拉取（契约：GET /v1/trip/{id}，响应含 revision + days[].items[]） */
export async function getTripDetail(id: string): Promise<TripDetail> {
  if (!USE_MOCK) {
    return request<TripDetail>({ url: `/v1/trip/${id}`, method: 'GET' })
  }
  await sleep(300)
  const detail = MOCK_TRIP_DETAILS[id]
  if (detail) return structuredClone(detail)
  // 列表里存在但没有铺全量 day/item 明细的行程：给一个骨架，页面仍可用
  const base = MOCK_TRIP_LIST.find((t) => t.id === id)
  if (!base) throw new Error('trip not found')
  return {
    ...base,
    days: Array.from({ length: base.day_count }, (_, i) => ({
      id: `${id}-d${i + 1}`,
      trip_id: id,
      day_index: i + 1,
      date: addDays(base.start_date, i),
      title: `D${i + 1} 行程安排`,
      summary: '',
      theme_tags: [],
      items: [],
    })),
  }
}

/**
 * 保存 AI 生成的行程（POST /v1/trips：title + start_date + days 摘要数组）。
 * start_date 是 AI 按用户说的日期推算出来的（YYYY-MM-DD）；
 * 后端会兜底校验（缺失/格式错/早于今天 一律收敛到今天），所以这里原样透传即可。
 */
export function saveTrip(params: {
  title: string
  days: string[]
  start_date?: string
}): Promise<{ id: string }> {
  return request<{ id: string }>({ url: '/v1/trips', method: 'POST', data: params })
}

/** 删除行程（DELETE /v1/trip/:id，CASCADE 自动清 days + items） */
export function deleteTrip(id: string): Promise<{ id: string }> {
  return request<{ id: string }>({ url: `/v1/trip/${id}`, method: 'DELETE' })
}

/** 删除单个行程项（DELETE /v1/trip/:id/item/:itemId）
 *  响应回带重算后的 budget_total —— 总预算依赖行程项，删项后必须同步。
 *  标为可选：旧版后端不返回该字段，调用方需本地兜底。 */
export function deleteTripItem(
  tripId: string,
  itemId: string,
): Promise<{ id: string; budget_total?: number }> {
  return request<{ id: string; budget_total?: number }>({
    url: `/v1/trip/${tripId}/item/${itemId}`,
    method: 'DELETE',
  })
}

/** 上移/下移行程项（PATCH /v1/trip/:id/item/:itemId，body: { direction }） */
export function moveTripItem(
  tripId: string,
  itemId: string,
  direction: 'up' | 'down',
): Promise<{ id: string; swapped: boolean }> {
  return request<{ id: string; swapped: boolean }>({
    url: `/v1/trip/${tripId}/item/${itemId}`,
    method: 'PATCH',
    data: { direction },
  })
}

/**
 * 行中打卡 / 撤销打卡（POST /v1/trip/:id/item/:itemId/check）。
 * 后端幂等、不带乐观锁（自己点自己不冲突），所以可以放心乐观更新。
 * 只标状态、不改价格，不触发预算重算。
 */
export function checkTripItem(
  tripId: string,
  itemId: string,
  done: boolean,
): Promise<{ id: string; done_at: string | null }> {
  return request<{ id: string; done_at: string | null }>({
    url: `/v1/trip/${tripId}/item/${itemId}/check`,
    method: 'POST',
    data: { done },
  })
}

/** 修改日期 / 出行人数（PATCH /v1/trip/:id）
 *  乐观锁：必须带 If-Match: revision，revision 不一致后端返回 409
 *  注意：日期变长时后端会为新多出来的天调 AI 补排行程（耗时数秒），
 *  结果在返回值的 appended_days / ai_error 里 */
export function updateTrip(
  id: string,
  params: { start_date?: string; end_date?: string; traveler?: Traveler },
  revision: number,
): Promise<TripDetail> {
  return request<TripDetail>({
    url: `/v1/trip/${id}`,
    method: 'PATCH',
    data: params,
    headers: { 'If-Match': String(revision) },
  })
}

/** 给某一天（重）排行程（POST /v1/trip/:id/day/:dayIndex/generate）
 *  主要用于「日期变长后自动补排失败」的重试；会先清掉该天现有行程项再重新生成。
 *  直连大模型，后端限流 5 次/分钟，慢的时候要等几秒。 */
export function generateTripDay(id: string, dayIndex: number): Promise<TripDetail> {
  return request<TripDetail>({
    url: `/v1/trip/${id}/day/${dayIndex}/generate`,
    method: 'POST',
  })
}

/** 整条行程按「口语要求」优化（POST /v1/trip/:id/optimize）
 *  已被 api/agent.ts 的 streamTripAgent 取代：现在由 AI 自己决定要不要重排行程，
 *  前端不再直接调这个接口。后端接口保留（agent 的 optimize_trip 工具复用其 prompt）。 */

/** YYYY-MM-DD 加 n 天（UTC 正午锚点，规避时区偏移）。
 *  导出给 Chat.vue 用：行程卡片要靠它算出结束日、把日期范围显示给用户核对 */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// ═══════════════════════════════════════════════════════════════
// Mock 数据（形状与真接口完全一致；日期贴近 2026-09-22 保证状态演示正确）
// ═══════════════════════════════════════════════════════════════

const MOCK_TRIP_LIST: TripListItem[] = [
  {
    id: '1004', user_id: '1', title: '大理 · 3日', destination_id: '5301',
    start_date: '2026-09-21', end_date: '2026-09-23', day_count: 3,
    traveler: { adults: 2 }, budget_total: 2400,
    status: 'ready', revision: 3, source: 'mix',
    updated_at: '2026-09-20T18:00:00+08:00',
    item_count: 7, pending_count: 1,
  },
  {
    id: '1001', user_id: '1', title: '上海 · 4日', destination_id: '3101',
    start_date: '2026-09-25', end_date: '2026-09-28', day_count: 4,
    traveler: { adults: 2 }, budget_total: 3860,
    status: 'ready', revision: 5, source: 'ai',
    updated_at: '2026-09-22T09:30:00+08:00',
    item_count: 8, pending_count: 2,
  },
  {
    id: '1002', user_id: '1', title: '杭州 · 2日', destination_id: '3301',
    start_date: '2026-11-02', end_date: '2026-11-03', day_count: 2,
    traveler: { adults: 1 }, budget_total: 1280,
    status: 'generating', revision: 1, source: 'ai',
    updated_at: '2026-09-22T17:00:00+08:00',
    item_count: 0, pending_count: 0,
  },
  {
    id: '1003', user_id: '1', title: '京都 · 5日', destination_id: 'JP-26',
    start_date: '2026-08-15', end_date: '2026-08-19', day_count: 5,
    traveler: { adults: 2 }, budget_total: 12600,
    status: 'archived', revision: 9, source: 'user',
    updated_at: '2026-08-19T20:00:00+08:00',
    item_count: 12, pending_count: 0,
  },
  {
    id: '1005', user_id: '1', title: '厦门 · 3日', destination_id: '3502',
    start_date: '2026-07-04', end_date: '2026-07-06', day_count: 3,
    traveler: { adults: 3 }, budget_total: 3200,
    status: 'archived', revision: 6, source: 'ai',
    updated_at: '2026-07-06T21:00:00+08:00',
    item_count: 9, pending_count: 0,
  },
]

/** 1001 上海 4 日的完整明细：D1 铺满，D2-D4 精简 */
const MOCK_TRIP_DETAILS: Record<string, TripDetail> = {
  '1001': {
    ...MOCK_TRIP_LIST[1],
    days: [
      {
        id: '1001-d1', trip_id: '1001', day_index: 1, date: '2026-09-25',
        title: 'D1 抵达 · 外滩初见', summary: '下午抵达，傍晚看外滩夜景',
        theme_tags: ['citywalk', '夜景'],
        items: [
          {
            id: '9001', trip_id: '1001', trip_day_id: '1001-d1', sort_order: 1,
            type: 'transport', ref_poi_id: null, ref_product_id: 'p-ticket-hq',
            title: '抵达虹桥 · 酒店寄存', subtitle: '地铁2号线约50分钟',
            cover_url: null, start_time: '09:00', duration_min: 50,
            price_ref: 0, price_snapshot: null,
            locked: false, source: 'ai', ai_confidence: 0.92, note: '',
            done_at: null,
            boundary: 'arrival',
          },
          {
            id: '9002', trip_id: '1001', trip_day_id: '1001-d1', sort_order: 2,
            type: 'sight', ref_poi_id: 'poi-bund', ref_product_id: null,
            title: '外滩观景平台', subtitle: '观景 · 门票免费',
            cover_url: null, start_time: '10:30', duration_min: 30,
            price_ref: 0, price_snapshot: null,
            locked: false, source: 'ai', ai_confidence: 0.55, note: 'AI 时间为估算，请核对',
            done_at: null,
            boundary: null,
          },
          {
            id: '9003', trip_id: '1001', trip_day_id: '1001-d1', sort_order: 3,
            type: 'meal', ref_poi_id: 'poi-benbang', ref_product_id: 'p-benbang',
            title: '午餐 · 老弄堂本帮菜', subtitle: '餐饮 · 已预订',
            cover_url: null, start_time: '12:30', duration_min: 60,
            price_ref: 180, price_snapshot: { amount: 180, currency: 'CNY', captured_at: '2026-09-22T09:30:00+08:00' },
            locked: true, source: 'user', ai_confidence: null, note: '',
            done_at: null,
            boundary: null,
          },
          {
            id: '9004', trip_id: '1001', trip_day_id: '1001-d1', sort_order: 4,
            type: 'sight', ref_poi_id: 'poi-yuyuan', ref_product_id: 'p-yuyuan',
            title: '豫园 · 城隍庙', subtitle: '园林 · 建议下午错峰',
            cover_url: null, start_time: '15:00', duration_min: 120,
            price_ref: 40, price_snapshot: null,
            locked: false, source: 'ai', ai_confidence: 0.48, note: '午后客流高峰，建议改期或提前购票',
            done_at: null,
            boundary: null,
          },
        ],
      },
      {
        id: '1001-d2', trip_id: '1001', day_index: 2, date: '2026-09-26',
        title: 'D2 迪士尼', summary: '全天迪士尼',
        theme_tags: ['乐园'],
        items: [
          {
            id: '9101', trip_id: '1001', trip_day_id: '1001-d2', sort_order: 1,
            type: 'sight', ref_poi_id: 'poi-shdr', ref_product_id: 'p-shdr',
            title: '上海迪士尼乐园', subtitle: '乐园 · 全天',
            cover_url: null, start_time: '08:30', duration_min: 600,
            price_ref: 475, price_snapshot: { amount: 475, currency: 'CNY', captured_at: '2026-09-22T09:30:00+08:00' },
            locked: true, source: 'user', ai_confidence: null, note: '',
            done_at: null,
            boundary: null,
          },
          {
            id: '9102', trip_id: '1001', trip_day_id: '1001-d2', sort_order: 2,
            type: 'hotel', ref_poi_id: null, ref_product_id: 'p-hotel-pd',
            title: '入住 · 陆家嘴精品酒店', subtitle: '1晚 · 含双早',
            cover_url: null, start_time: '19:00', duration_min: null,
            price_ref: 680, price_snapshot: { amount: 680, currency: 'CNY', captured_at: '2026-09-22T09:30:00+08:00' },
            locked: true, source: 'system', ai_confidence: null, note: '',
            done_at: null,
            boundary: null,
          },
        ],
      },
      {
        id: '1001-d3', trip_id: '1001', day_index: 3, date: '2026-09-27',
        title: 'D3 武康路 · 田子坊', summary: 'citywalk 一天',
        theme_tags: ['citywalk', '咖啡'],
        items: [
          {
            id: '9201', trip_id: '1001', trip_day_id: '1001-d3', sort_order: 1,
            type: 'sight', ref_poi_id: 'poi-wukang', ref_product_id: null,
            title: '武康路 · 安福路', subtitle: 'citywalk · 免费',
            cover_url: null, start_time: '10:00', duration_min: 150,
            price_ref: 0, price_snapshot: null,
            locked: false, source: 'ai', ai_confidence: 0.85, note: '',
            done_at: null,
            boundary: null,
          },
          {
            id: '9202', trip_id: '1001', trip_day_id: '1001-d3', sort_order: 2,
            type: 'meal', ref_poi_id: null, ref_product_id: null,
            title: '咖啡 · 街角小店', subtitle: '餐饮 · 顺路',
            cover_url: null, start_time: '14:00', duration_min: 60,
            price_ref: 60, price_snapshot: null,
            locked: false, source: 'ai', ai_confidence: 0.62, note: '时间为估算',
            done_at: null,
            boundary: null,
          },
        ],
      },
      {
        id: '1001-d4', trip_id: '1001', day_index: 4, date: '2026-09-28',
        title: 'D4 返程', summary: '睡到自然醒，中午返程',
        theme_tags: [],
        items: [
          {
            id: '9301', trip_id: '1001', trip_day_id: '1001-d4', sort_order: 1,
            type: 'transport', ref_poi_id: null, ref_product_id: 'p-ticket-hq-return',
            title: '虹桥站返程', subtitle: '交通 · 高铁',
            cover_url: null, start_time: '13:00', duration_min: null,
            price_ref: 0, price_snapshot: null,
            locked: false, source: 'ai', ai_confidence: 0.9, note: '',
            done_at: null,
            boundary: 'closing',
          },
        ],
      },
    ],
  },
}
