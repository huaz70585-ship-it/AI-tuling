import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
// 边界项判定（纯函数、无依赖）：mapItem 要给前端标出抵达/返程，
// 前端据此不给移动入口。放 utils/boundary.js 而非 tripBoundary.js 是为了避免循环 import
import { isArrivalItem, isClosingItem } from './utils/boundary.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = resolve(__dirname, '..', process.env.DB_PATH || './data/travel.db')

// 确保 data 目录存在
mkdirSync(dirname(dbPath), { recursive: true })

// 同步连接（node:sqlite 内置，零依赖）
export const db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

// ═══════════════════════════════════════════════════════
// 建表
// ═══════════════════════════════════════════════════════
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  phone       TEXT UNIQUE,
  username    TEXT UNIQUE,
  password    TEXT,
  name        TEXT NOT NULL,
  avatar      TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  destination_id  TEXT,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  day_count       INTEGER NOT NULL,
  traveler        TEXT NOT NULL DEFAULT '{"adults":1}',  -- JSON
  budget_total    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft',         -- draft/generating/ready/archived
  revision        INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL DEFAULT 'ai',            -- ai/user/mix
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS trip_days (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL,
  day_index   INTEGER NOT NULL,
  date        TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  theme_tags  TEXT NOT NULL DEFAULT '[]',                -- JSON
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trip_items (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL,
  trip_day_id       TEXT NOT NULL,
  sort_order        INTEGER NOT NULL,
  type              TEXT NOT NULL,                      -- sight/hotel/meal/transport/note
  ref_poi_id        TEXT,
  ref_product_id    TEXT,
  title             TEXT NOT NULL,
  subtitle          TEXT NOT NULL DEFAULT '',
  cover_url         TEXT,
  start_time        TEXT NOT NULL,
  duration_min      INTEGER,
  price_ref         INTEGER,
  price_snapshot    TEXT,                                -- JSON or NULL
  locked            INTEGER NOT NULL DEFAULT 0,         -- 0/1
  source            TEXT NOT NULL DEFAULT 'ai',         -- ai/user/system
  ai_confidence     REAL,                                -- NULL 或 0-1
  note              TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (trip_day_id) REFERENCES trip_days(id) ON DELETE CASCADE
);

-- 相邻行程项之间的交通衔接（AI 或地图接口生成，落库缓存）
-- 唯一键保证同一对项只算一次：AI 每次话术会漂移，不缓存会让用户刷新就换说法
CREATE TABLE IF NOT EXISTS trip_hops (
  id           TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL,
  from_item_id TEXT NOT NULL,
  to_item_id   TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'unknown',   -- walk/bus/metro/taxi/bike/coach/unknown
  duration_min INTEGER,                            -- 纯在途分钟数（不含等待）
  cost_ref     INTEGER,                            -- 每人预估花费（元）
  tip          TEXT NOT NULL DEFAULT '',
  alts         TEXT NOT NULL DEFAULT '[]',         -- JSON: 备选交通方式（mode/duration_min/cost_ref/tip/steps）
  steps        TEXT NOT NULL DEFAULT '[]',         -- JSON: 主选方式的详细分步走法（坐几号线/换乘/哪站下/哪个口）
  source       TEXT NOT NULL DEFAULT 'ai',         -- ai/map
  created_at   TEXT NOT NULL,
  UNIQUE (from_item_id, to_item_id),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,            -- trip / system（只有这两类有真实来源）
  icon        TEXT NOT NULL,
  icon_bg     TEXT NOT NULL,
  title       TEXT NOT NULL,
  preview     TEXT NOT NULL,
  time        TEXT NOT NULL,
  unread      INTEGER NOT NULL DEFAULT 1,
  cta_label   TEXT,
  cta_kind    TEXT,                     -- 目前只用 view（跳转行程列表）
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footprints (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL UNIQUE,
  city_count  INTEGER NOT NULL DEFAULT 0,
  travel_days INTEGER NOT NULL DEFAULT 0,
  total_km    INTEGER NOT NULL DEFAULT 0,
  progress    INTEGER NOT NULL DEFAULT 0,  -- 0-10
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cities (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  pinyin TEXT,
  province TEXT,
  hot   INTEGER NOT NULL DEFAULT 0,
  hero_image TEXT,
  tagline TEXT
);

CREATE TABLE IF NOT EXISTS city_spots (
  id          TEXT PRIMARY KEY,
  city_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  price       TEXT,
  image       TEXT,
  enrollment  INTEGER NOT NULL DEFAULT 0,
  rating      REAL,                              -- 评分 0-5
  tags        TEXT NOT NULL DEFAULT '[]',        -- JSON 数组,如 ['5A景区','打卡地']
  promo       TEXT,                                -- 促销文案,如 '满6减300' / '免费' / NULL
  sort        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (city_id) REFERENCES cities(id)
);

-- 地理编码缓存：地点文本 → 坐标。复用 trip_hops 的缓存思路，但动机更硬：
--   1. 同一个地名会在多条行程里反复出现（「豫园」不该查两次）；
--   2. 实测腾讯 placeSuggestion 有抖动 —— 同一个「安福路」前后两次查询，
--      一次返回坐标、一次返回「未找到结果」。只靠实时查询，结论会随接口漂移；
--      缓存把首次成功的结果固化，之后不再依赖接口的稳定性。
-- query_key = 城市 + '|' + 查询串。城市必须参与去重：「城隍庙」在沪/穗是不同实体。
CREATE TABLE IF NOT EXISTS geo_cache (
  query_key  TEXT PRIMARY KEY,
  city       TEXT,
  name       TEXT NOT NULL,
  title      TEXT,                     -- 接口返回的正式名（可能比查询串更完整）
  latitude   REAL,
  longitude  REAL,
  poi_id     TEXT,                     -- 腾讯 POI ID —— 用于回填 trip_items.ref_poi_id
  address    TEXT,
  adcode     TEXT,
  status     TEXT NOT NULL,            -- ok / miss / city_mismatch
  source     TEXT NOT NULL,            -- map(真实接口) / manual(人工灌入)
  created_at TEXT NOT NULL
);

-- 景点决策 brief 的按名缓存（2026-09-25）：city_spots 只覆盖预置的少数城市，
-- 而 AI 排出的行程项是任意城市任意名字 —— 实测命中率 0/46。仿 geo_cache 的思路：
-- 用户点到时现生成一次，按【归一化名称】缓存，之后同名的所有人直接复用。
-- key 用名称而不是 城市|名称：地点重名（两地都有「中山公园」）时 brief 会偏泛，
-- 但决策卡的内容（怎么玩/避坑/时段）大多与具体哪一座关系不大，可接受；
-- 换来的是跨城市复用与更简单的命中逻辑。
-- ⚠ 负缓存也存在：brief_json = {"not_place":true} 表示「这不是个可游的地点」，
--   同样入缓存 —— 否则「返程（免费）」这类占位项会被反复重查（与 geo_cache 的 miss 负缓存同理）。
CREATE TABLE IF NOT EXISTS spot_briefs (
  name        TEXT PRIMARY KEY,        -- 归一化后的名称（normalizeSpotName）
  raw_title   TEXT,                    -- 首次生成时的原始行程项标题（溯源用）
  city_hint   TEXT,                    -- 生成时的城市线索（可能为空，只影响内容不影响 key）
  brief_json  TEXT NOT NULL,           -- 决策包 JSON；{"not_place":true} 为负缓存
  source      TEXT NOT NULL DEFAULT 'ai',
  confidence  REAL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`);
// ═══════════════════════════════════════════════════════
// 索引：外键列与高频查询列
// 原本一个索引都没有 —— 所有 WHERE user_id / trip_id / city_id 都是全表扫描。
// 命名 idx_<表>_<用途>；复合索引把 ORDER BY 列一并带上，避免排序临时表。
// ═══════════════════════════════════════════════════════
db.exec(`
CREATE INDEX IF NOT EXISTS idx_trips_user_updated   ON trips(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_trip_days_trip       ON trip_days(trip_id, day_index);
CREATE INDEX IF NOT EXISTS idx_trip_items_day       ON trip_items(trip_day_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_trip_items_trip      ON trip_items(trip_id);
CREATE INDEX IF NOT EXISTS idx_messages_user        ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_city_spots_city      ON city_spots(city_id, sort);
CREATE INDEX IF NOT EXISTS idx_trip_hops_trip       ON trip_hops(trip_id);
`)
// users.phone / users.username / footprints.user_id 已是 UNIQUE，SQLite 会自建唯一索引，无需重复。

// ═══════════════════════════════════════════════════════
// 迁移：旧库升级（已有列时静默跳过）
// ═══════════════════════════════════════════════════════
{
  const cols = queryAll(`PRAGMA table_info(city_spots)`).map(r => r.name)
  if (!cols.includes('enrollment')) {
    db.exec(`ALTER TABLE city_spots ADD COLUMN enrollment INTEGER NOT NULL DEFAULT 0`)
  }
}
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    console.log(`[migrate] ${table}.${column} 已添加`)
  }
}
addColumnIfMissing('users', 'username', 'TEXT')
addColumnIfMissing('users', 'password', 'TEXT')
addColumnIfMissing('cities', 'hero_image', 'TEXT')
// 交通衔接缓存：老库没有备选交通列，补上（纯缓存，失败静默）
addColumnIfMissing('trip_hops', 'alts', "TEXT NOT NULL DEFAULT '[]'")
addColumnIfMissing('trip_hops', 'steps', "TEXT NOT NULL DEFAULT '[]'")
addColumnIfMissing('cities', 'tagline', 'TEXT')
addColumnIfMissing('city_spots', 'rating', 'REAL')
addColumnIfMissing('city_spots', 'tags', "TEXT NOT NULL DEFAULT '[]'")
addColumnIfMissing('city_spots', 'promo', 'TEXT')
// 天气接口用：城市经纬度（首次查询时由 geocoding 回填，之后直接复用，不必反复解析）
addColumnIfMissing('cities', 'latitude', 'REAL')
addColumnIfMissing('cities', 'longitude', 'REAL')

// 地图接入：行程项的坐标（由 .workbuddy/backfill-geo.mjs 回填）
// geo_status 记录这次解析的结论，三种取值：
//   ok            → 拿到了可用的坐标，latitude/longitude 有效
//   miss          → 地理编码查不到（多是 AI 编的笼统名，如「陆家嘴精品酒店」）
//   city_mismatch → 查到了但不在期望城市（region 是软过滤，会返回外省同名点，见 geo.js 注释）
//   NULL          → 还没尝试过
addColumnIfMissing('trip_items', 'latitude', 'REAL')
addColumnIfMissing('trip_items', 'longitude', 'REAL')
addColumnIfMissing('trip_items', 'geo_status', 'TEXT')

// 行中模式（2026-09-25 起）：打卡时间戳，NULL = 还没去过。
// 用时间戳而不是 done 布尔量：一个字段同时承载「去没去过」和「几点去的」，
// 将来做行程回放 / 足迹统计也用得上，不必再加列。
// 与 locked 的区别：locked 是「已预订，别让 AI 改」，done_at 是「我去过了」，
// 两个维度，不能混用。
addColumnIfMissing('trip_items', 'done_at', 'TEXT')

// 景点决策信息（2026-09-25 起）：把「只显示名字」升级成「给用户决策依据」。
// 为什么是 JSON 而不是平铺 20 列：这些是【叙事型】字段（why_go / avoid / photo…），
// 每加一项都要一次 ALTER TABLE；放进一个 JSON 并带 schema_version，加字段不用再迁移。
// 代价：不能按「有没有避坑提示」做 SQL 筛选 —— 目前不需要，可接受。
// 分拎（很重要）：brief 只装【静态/半静态知识】。排队时长、今日是否约满这类
// 【小时级事实】不入库 —— 国内没有公开的免费排队数据源，静态存必错（见 .workbuddy/geo-audit-report.md 同级讨论）。
addColumnIfMissing('city_spots', 'brief_json', 'TEXT')
addColumnIfMissing('city_spots', 'brief_source', 'TEXT')       // ai / editor
addColumnIfMissing('city_spots', 'brief_updated_at', 'TEXT')
addColumnIfMissing('city_spots', 'brief_confidence', 'REAL')   // 0-1，生成方自己的把握度

// ═══════════════════════════════════════════════════════
// 便捷查询（自动解包 JSON 字段）
// ═══════════════════════════════════════════════════════

/** 通用查询全部行 */
export function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params)
}

/** 查单行 */
export function queryOne(sql, params = []) {
  return db.prepare(sql).get(...params)
}

/** 执行写操作，返回 changes */
export function run(sql, params = []) {
  return db.prepare(sql).run(...params)
}

/**
 * 同步事务：把多条写操作包成原子提交，任一步失败整体回滚。
 * node:sqlite 没提供 transaction helper，这里用 SAVEPOINT 手写 ——
 * 相比 BEGIN/COMMIT，SAVEPOINT 天然支持嵌套（内层失败只回滚内层）。
 * 注意：fn 必须是同步函数（本项目的 sqlite 调用全是同步的）。
 */
let txDepth = 0
export function transaction(fn) {
  const sp = `sp_${txDepth++}`
  db.exec(`SAVEPOINT ${sp}`)
  try {
    const result = fn()
    db.exec(`RELEASE ${sp}`)
    return result
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}`)
    db.exec(`RELEASE ${sp}`)
    throw e
  } finally {
    txDepth--
  }
}

/** 解析 JSON 字符串字段 */
export function parseJSON(str, fallback = null) {
  if (str == null) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

// ═══════════════════════════════════════════════════════
// 行程数据组装（列表行 + 详情嵌套）
// ═══════════════════════════════════════════════════════

/** 列表行：含 item_count 与 pending_count */
export function getTripListRows(userId) {
  const rows = queryAll(
    `SELECT t.*,
       (SELECT COUNT(*) FROM trip_items ti WHERE ti.trip_id = t.id) AS item_count,
       (SELECT COUNT(*) FROM trip_items ti WHERE ti.trip_id = t.id AND ti.ai_confidence IS NOT NULL AND ti.ai_confidence < 0.7) AS pending_count
     FROM trips t WHERE t.user_id = ? ORDER BY t.updated_at DESC`,
    [userId],
  )
  return rows.map(mapTripRow)
}

/** 详情：trip + days[].items[] */
export function getTripDetail(id) {
  const trip = queryOne('SELECT * FROM trips WHERE id = ?', [id])
  if (!trip) return null
  const days = queryAll('SELECT * FROM trip_days WHERE trip_id = ? ORDER BY day_index', [id])
  return {
    ...mapTripRow(trip),
    days: days.map((d) => ({
      id: d.id,
      trip_id: d.trip_id,
      day_index: d.day_index,
      date: d.date,
      title: d.title,
      summary: d.summary,
      theme_tags: parseJSON(d.theme_tags, []),
      items: queryAll(
        'SELECT * FROM trip_items WHERE trip_day_id = ? ORDER BY sort_order',
        [d.id],
      ).map(mapItem),
    })),
  }
}

function mapTripRow(t) {
  return {
    id: t.id,
    user_id: t.user_id,
    title: t.title,
    destination_id: t.destination_id,
    start_date: t.start_date,
    end_date: t.end_date,
    day_count: t.day_count,
    traveler: parseJSON(t.traveler, { adults: 1 }),
    budget_total: t.budget_total,
    status: t.status,
    revision: t.revision,
    source: t.source,
    updated_at: t.updated_at,
    item_count: t.item_count,
    pending_count: t.pending_count,
  }
}

function mapItem(i) {
  return {
    id: i.id,
    trip_id: i.trip_id,
    trip_day_id: i.trip_day_id,
    sort_order: i.sort_order,
    type: i.type,
    ref_poi_id: i.ref_poi_id,
    ref_product_id: i.ref_product_id,
    title: i.title,
    subtitle: i.subtitle,
    cover_url: i.cover_url,
    start_time: i.start_time,
    duration_min: i.duration_min,
    price_ref: i.price_ref,
    price_snapshot: parseJSON(i.price_snapshot, null),
    locked: !!i.locked,
    source: i.source,
    ai_confidence: i.ai_confidence,
    note: i.note,
    /** 打卡时间戳（行中模式），NULL = 未打卡 */
    done_at: i.done_at,
    /**
     * 边界项标记：arrival = 抵达（固定在当天首位）/ closing = 返程（固定在末位）/ null = 普通项。
     * 前端据此不给上移/下移入口。判定口径与 routes/trip.js 的移动拦截同源
     * （utils/boundary.js），前端只读不算 —— 正则只留一份，不再两边各写一套。
     */
    boundary: isArrivalItem(i.title) ? 'arrival' : isClosingItem(i.title) ? 'closing' : null,
    // 地理编码结果（2026-09-24 起）：坐标由 geo.js 回填，是 GCJ-02（火星坐标）。
    // geo_status 取值 ok / miss / city_mismatch / null（未解析，含抽象项）。
    // 前端地图只在 latitude/longitude 同时非空时打点。
    latitude: i.latitude,
    longitude: i.longitude,
    geo_status: i.geo_status,
  }
}

export default db
