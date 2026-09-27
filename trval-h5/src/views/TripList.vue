<template>
  <div class="triplist">
    <!-- 顶栏：底部 Tab 落地页，刻意不带返回箭头 -->
    <van-nav-bar title="我的行程" fixed placeholder>
      <template #right>
        <van-icon name="plus" size="20" @click="goPlan" />
      </template>
    </van-nav-bar>

    <!-- 状态筛选（带数量） -->
    <div class="cats">
      <button
        v-for="c in cats"
        :key="c.key"
        class="cat"
        :class="{ 'is-active': c.key === activeCat }"
        @click="activeCat = c.key"
      >
        {{ c.label }}
        <span v-if="counts[c.key]" class="cat__badge">{{ counts[c.key] }}</span>
      </button>
    </div>

    <!-- 行程列表 -->
    <main class="list">
      <van-swipe-cell
        v-for="t in visibleTrips"
        :key="t.id"
        class="trip-swipe"
      >
        <article class="trip" @click="goDetail(t)">
          <div class="trip__row">
            <!-- 日期锚点：原来这里是 88px 的 vant 空图占位（cover_url 全为 null，
                 永远不会有图）——换成真实出发日期，消灭死空间 -->
            <div class="trip__date">
              <span class="trip__date-mon">{{ t.mon }}</span>
              <span class="trip__date-day">{{ t.day }}</span>
            </div>
            <div class="trip__body">
              <p class="trip__route">{{ t.title }}</p>
              <p class="trip__meta">{{ t.dateRange }} · {{ t.people }}人</p>
              <span class="trip__state" :class="`state--${t.style}`">
                {{ t.stateText }}
              </span>
            </div>
          </div>

          <div class="trip__foot">
            <span class="trip__progress">
              {{ t.itemCount }} 项安排
            </span>
          </div>
        </article>
        <template #right>
          <button class="trip__del" @click.stop="onDelete(t)">删除</button>
        </template>
      </van-swipe-cell>

      <!-- 空状态：把"没行程"变成一次转化机会 -->
      <div v-if="!visibleTrips.length" class="empty">
        <span class="empty__ic">
          <van-icon name="calendar-o" />
        </span>
        <p class="empty__title">还没有行程</p>
        <p class="empty__slogan">先有灵光，再上路</p>
        <p class="empty__sub">说说目的地和天数，AI 帮你把每天排好</p>
        <button class="empty__btn" @click="goPlan">让 AI 帮我规划</button>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import {
  getTrips,
  deleteTrip,
  formatDateRange,
  travelerCount,
  deriveTripState,
  type TripListItem,
  type DerivedTripState,
  type DerivedTripStateInfo,
} from '../api/travel'

const router = useRouter()

/**
 * 可筛选的档位。
 * 刻意不含 'generating'（规划中）—— 见下面 cats 的说明，那个状态真实流程产生不了。
 */
type CatKey = 'all' | 'ongoing' | 'upcoming' | 'done'

interface TripCard extends DerivedTripStateInfo {
  id: string
  title: string
  dateRange: string
  people: number
  itemCount: number
  /** 日期锚点：出发月（'10月'）与日（'12'） */
  mon: string
  day: string
}

/**
 * 筛选标签。
 *
 * 「进行中」必须有自己的一格：原来「待出行」把 ongoing 一起吞了
 * （`t.state === 'upcoming' || t.state === 'ongoing'`），于是正在旅行中的
 * 行程挂在「待出行」下面 —— 语义是反的，也和详情页把「行中」当独立状态
 * （独立「今天」视图 + 打卡）对不上。
 *
 * 不给「规划中」单独的标签：那个状态由 trips.status 驱动，而 status 全项目
 * 只在创建时写过一次 'ready'（trip.js 的 INSERT），之后没有任何 UPDATE。
 * 也就是说 generating / draft 只有 seed 数据里手写过、真实流程永远产生不了，
 * 给它一个筛选标签永远是空的。列表里这类行程仍会带「AI 规划中」徽标兜底。
 */
const cats: { key: CatKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'ongoing', label: '进行中' },
  { key: 'upcoming', label: '待出行' },
  { key: 'done', label: '已完成' },
]
const activeCat = ref<CatKey>('all')

const trips = ref<TripListItem[]>([])

onMounted(async () => {
  // 兜住失败：裸 await 一旦 reject 就是未处理的 promise rejection，页面停在空白
  try {
    trips.value = await getTrips()
  } catch {
    showToast('行程加载失败')
  }
})

/* 列表行 → 视图卡：展示态由 status + 日期推导（deriveTripState） */
const cards = computed<TripCard[]>(() =>
  trips.value.map((t) => ({
    id: t.id,
    title: t.title,
    dateRange: formatDateRange(t.start_date, t.end_date),
    people: travelerCount(t),
    mon: `${Number(t.start_date.slice(5, 7))}月`,
    day: t.start_date.slice(8, 10),
    ...deriveTripState(t),
    itemCount: t.item_count,
  })),
)

/* 排序按行动优先级：进行中 > 待出行 > 规划中 > 已完成 */
const STYLE_ORDER: Record<TripCard['style'], number> = { live: 0, soon: 1, ai: 2, done: 3 }
const visibleTrips = computed(() => {
  // activeCat 除了 'all' 就是某个状态值，所以这里不需要再拼条件
  const filtered =
    activeCat.value === 'all'
      ? cards.value
      : cards.value.filter((t) => t.state === activeCat.value)
  return [...filtered].sort((a, b) => STYLE_ORDER[a.style] - STYLE_ORDER[b.style])
})

const counts = computed<Record<CatKey, number>>(() => {
  const byState = (s: DerivedTripState) => cards.value.filter((t) => t.state === s).length
  return {
    all: cards.value.length,
    ongoing: byState('ongoing'),
    upcoming: byState('upcoming'),
    done: byState('done'),
  }
})

function goDetail(t: TripCard) {
  router.push(`/trip/${t.id}`)
}

/* 左滑删除：确认 → 调接口 → 本地移除（无需整页刷新） */
async function onDelete(t: TripCard) {
  try {
    await showConfirmDialog({ title: '删除行程', message: `确定删除「${t.title}」？此操作不可撤销。` })
    await deleteTrip(t.id)
    trips.value = trips.value.filter((x) => x.id !== t.id)
    showToast('已删除')
  } catch {
    /* 用户取消或接口失败，静默 */
  }
}

function goPlan() {
  router.push('/chat')
}
</script>

<style scoped>
.triplist {
  /* 通用颜色 token 见 src/styles/tokens.css，下面只留本页语义别名 */
  --c-old: var(--c-muted);   /* 已结束行程的弱化信息 */
  --tabbar-h: calc(var(--van-tabbar-height, 50px) + env(safe-area-inset-bottom));

  min-height: 100vh;
  min-height: 100dvh;
  background: var(--c-bg);
  color: var(--c-text);
  padding-bottom: calc(var(--tabbar-h) + 16px);
  font-family: var(--font-sans);
}

/* ---------- 顶栏 ---------- */
:deep(.van-nav-bar) { background: var(--c-card); }
:deep(.van-nav-bar::after) { border-color: var(--c-divider); }
:deep(.van-nav-bar__title) { font-weight: 700; color: var(--c-text); }
:deep(.van-nav-bar .van-icon) { color: var(--c-text); }

/* ---------- 状态筛选 ---------- */
.cats {
  display: flex;
  gap: 8px;
  padding: 10px 20px 6px;
  overflow-x: auto;
}
.cats::-webkit-scrollbar { display: none; }
.cat {
  flex-shrink: 0;
  height: 30px;
  padding: 0 14px;
  font-size: 13px; font-weight: 500;
  color: var(--c-sub);
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  border-radius: 15px;
  transition: all 0.15s;
}
.cat.is-active {
  background: var(--c-brand);
  color: #fff;
  border-color: var(--c-brand);
}
.cat__badge {
  display: inline-grid; place-items: center;
  min-width: 16px; height: 16px;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px; font-weight: 700;
  color: var(--c-sub);
  background: var(--c-divider);
  border-radius: 8px;
  vertical-align: middle;
}
.cat.is-active .cat__badge { color: #fff; background: rgba(255, 255, 255, 0.3); }

/* ---------- 列表 ---------- */
.list { padding: 6px 20px 0; }

/* ---------- 行程卡 ---------- */
.trip-swipe { margin-bottom: 12px; }
.trip {
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  border-radius: var(--radius-card);
  padding: 12px;
  cursor: pointer;
  transition: transform 0.15s;
}
.trip:active { transform: translateY(1px); }
.trip__del {
  height: 100%;
  padding: 0 20px;
  font-size: 14px; font-weight: 600;
  color: #fff;
  background: var(--c-danger, #ff4d4f);
  border: none;
  border-radius: 0 var(--radius-card) var(--radius-card) 0;
  display: flex; align-items: center;
}

.trip__row { display: flex; gap: 12px; align-items: stretch; }
.trip__body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.trip__route {
  font-size: 16px; font-weight: 700;
  color: var(--c-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.trip__meta { font-size: 12px; color: var(--c-sub); margin-top: 4px; font-variant-numeric: tabular-nums; }
.trip__state {
  margin-top: auto;
  align-self: flex-start;
  font-size: 11px; font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
}
.state--ai { color: var(--c-brand-deep); background: var(--c-brand-soft); }
.state--soon { color: var(--c-warn); background: var(--c-warn-soft); }
.state--live { color: #fff; background: var(--c-brand); }
.state--done { color: var(--c-sub); background: var(--c-divider); }

/* 日期锚点列（替代原来的空图占位）：像订单卡的左栏 */
.trip__date {
  flex: none;
  width: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-right: 1px solid var(--c-divider);
  padding-right: 12px;
}
.trip__date-mon {
  font-size: 11px; font-weight: 500;
  color: var(--c-sub);
}
.trip__date-day {
  font-size: 21px; font-weight: 500;
  line-height: 1;
  color: var(--c-brand-deep);
  font-variant-numeric: tabular-nums;
}

.trip__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--c-divider);
}
.trip__progress { font-size: 11.5px; color: var(--c-sub); font-variant-numeric: tabular-nums; }
.trip__progress em { font-style: normal; font-weight: 600; color: var(--c-text); }

/* ---------- 空状态 ---------- */
.empty { padding: 56px 24px 24px; text-align: center; }
.empty__ic {
  display: grid; place-items: center;
  width: 64px; height: 64px;
  margin: 0 auto;
  border-radius: 50%;
  background: var(--c-brand-soft);
  color: var(--c-brand);
}
.empty__ic :deep(.van-icon) { font-size: 30px; }
.empty__title { font-size: 15px; font-weight: 700; color: var(--c-text); margin-top: 14px; }
.empty__slogan {
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--c-brand);
  margin-top: 8px;
}
.empty__sub {
  font-size: 12.5px; line-height: 1.6;
  color: var(--c-sub);
  margin-top: 4px;
}
.empty__btn {
  margin-top: 18px;
  padding: 11px 28px;
  font-size: 14px; font-weight: 700;
  color: #fff;
  background: var(--c-brand);
  border-radius: 22px;
  box-shadow: 0 4px 12px rgba(14, 124, 134, 0.3);
}
.empty__btn:active { transform: scale(0.97); }
</style>
