<template>
  <div class="msg-page">
    <!-- 顶栏：消息中心 + 全部已读（tab 落地页，无返回箭头，与行程列表页一致） -->
    <van-nav-bar fixed placeholder title="消息中心">
      <template #right>
        <span class="nav-act" @click="readAll">全部已读</span>
        <span class="nav-act nav-act--danger" @click="onClearAll">清空</span>
      </template>
    </van-nav-bar>

    <!-- 分类筛选 -->
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

    <!-- 消息列表 · 按时间分组（下拉刷新拉取最新） -->
    <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <main class="list">
        <template v-for="g in groups" :key="g.label">
          <div v-if="g.items.length" class="group">
            <p class="group__label">{{ g.label }}</p>
            <van-swipe-cell v-for="m in g.items" :key="m.id" class="msg-cell">
              <article
                class="item"
                :class="{ 'is-unread': m.unread, [`is-${m.type}`]: true }"
                @click="onItem(m)"
              >
                <div class="item__avatar" :style="{ background: avatarBg(m.type) }">
                  <van-icon :name="m.icon" />
                  <span v-if="m.unread" class="item__dot"></span>
                </div>
                <div class="item__body">
                  <div class="item__head">
                    <p class="item__title">{{ m.title }}</p>
                    <span class="item__time">{{ relTime(m.createdAt) }}</span>
                  </div>
                  <p class="item__preview">{{ m.preview }}</p>
                  <button
                    v-if="m.cta"
                    class="item__cta"
                    :class="`cta--${m.cta.kind}`"
                    @click.stop="onItem(m)"
                  >{{ m.cta.label }}</button>
                </div>
              </article>
              <template #right>
                <button class="item__del" @click.stop="onDelete(m)">删除</button>
              </template>
            </van-swipe-cell>
          </div>
        </template>

        <!-- 空状态：没消息时替代时间分组和结束语 -->
        <div v-if="!messages.length" class="empty">
          <van-icon name="bell-o" class="empty__ic" />
          <p class="empty__title">暂无消息</p>
          <p class="empty__desc">行程保存、系统通知会出现在这里</p>
        </div>
        <p v-else class="end-tip">没有更多消息了</p>
      </main>
    </van-pull-refresh>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { getMessages, readAllMessages, readMessage, deleteMessage, clearAllMessages, type Message } from '../api/message'

const router = useRouter()

type CatKey = 'all' | 'trip' | 'system'

/**
 * 产品当前只产生「行程」「系统」两类消息 —— 没有交易系统，也没有社交关系，
 * 所以不设「交易」「互动」分类。
 *
 * 历史库里若残留 trade / social 等旧类型（早期演示数据），一律不展示：
 * 它们的落点按钮（如「去支付」）没有对应接口，点了不会有任何反应。
 */
const VISIBLE_TYPES = ['trip', 'system']

const cats: { key: CatKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'trip', label: '行程' },
  { key: 'system', label: '系统' },
]
const activeCat = ref<CatKey>('all')

/**
 * 头像底色按类型派生（不信任后端 iconBg）——类型即视觉，四种类型一眼分辨：
 *   · 交易 trade    → 暖橙（强调层 5%）：可支付动作
 *   · 行程 trip     → 品牌青（品牌层 15%）：可查看行程
 *   · 系统/互动     → 中性灰：纯通知，不可点动作
 * 灰色用 --c-muted，因为它是 tokens 里给「系统图标底」定义的弱化色。
 */
const AVATAR_BG: Record<string, string> = {
  trade: 'var(--c-accent)',
  trip: 'var(--c-brand)',
  social: 'var(--c-muted)',
  system: 'var(--c-muted)',
}
function avatarBg(type: string): string {
  return AVATAR_BG[type] ?? 'var(--c-muted)'
}

/**
 * 全量消息：一次拉回，分类和计数都在本地派生。
 *
 * 改成这样是因为原来「切一次分类拉一次」有两个硬伤：
 *  ① 计数用的是「当前分类已加载的那几条」，切到「交易」后 全部/互动/系统 的徽标全变成 0；
 *  ② 快速切分类时旧响应可能后到，把新分类的列表覆盖掉（无序号校验）。
 * 单份数据 + 本地派生，两个问题一起消失，切分类也不再发请求。
 */
const allMessages = ref<Message[]>([])

async function load() {
  try {
    allMessages.value = await getMessages()
  } catch {
    allMessages.value = []
    showToast({ message: '消息加载失败', position: 'top' })
  }
}
onMounted(load)

/* 下拉刷新：拉最新消息（load 内部已处理失败，刷新态交给 Vant 收回） */
const refreshing = ref(false)
async function onRefresh() {
  await load()
  refreshing.value = false
}

/** 当前分类要展示的消息（本地过滤；非行程/系统类一律不展示） */
const messages = computed<Message[]>(() => {
  const visible = allMessages.value.filter(m => VISIBLE_TYPES.includes(m.type))
  return activeCat.value === 'all' ? visible : visible.filter(m => m.type === activeCat.value)
})

/* 分类计数（未读）：统计全量数据，不受当前分类影响 */
const counts = computed<Record<CatKey, number>>(() => {
  const c: Record<CatKey, number> = { all: 0, trip: 0, system: 0 }
  for (const m of allMessages.value) {
    if (!m.unread || !VISIBLE_TYPES.includes(m.type)) continue
    c.all += 1
    c[m.type as CatKey] += 1
  }
  return c
})

/* 按真实日期分组 */
const DAY_MS = 86_400_000

/**
 * 消息内时间戳：相对格式（今天/昨天/近 7 天带时刻，更早只给日期）。
 * 分组的「今天/本周/更早」标签已承担日期语义，卡片里再给一次当天时刻就够了。
 */
function pad2(n: number) { return String(n).padStart(2, '0') }
function relTime(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = startOfDay(now) - startOfDay(t)
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`
  if (diff === 0) return `今天 ${hm}`
  if (diff === DAY_MS) return `昨天 ${hm}`
  if (diff < 7 * DAY_MS) return `${t.getMonth() + 1}月${t.getDate()}日 ${hm}`
  const sameYear = t.getFullYear() === now.getFullYear()
  return sameYear
    ? `${t.getMonth() + 1}月${t.getDate()}日`
    : `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`
}

const groups = computed(() => {
  const now = new Date()
  // 今天 0 点；「本周」按近 7 天（含今天）算，比自然周的边界更符合直觉
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const weekStart = todayStart - 6 * DAY_MS

  const buckets: { label: string; items: Message[] }[] = [
    { label: '今天', items: [] },
    { label: '本周', items: [] },
    { label: '更早', items: [] },
  ]
  for (const m of messages.value) {
    const t = Date.parse(m.createdAt)
    if (Number.isNaN(t)) buckets[2].items.push(m)
    else if (t >= todayStart) buckets[0].items.push(m)
    else if (t >= weekStart) buckets[1].items.push(m)
    else buckets[2].items.push(m)
  }
  return buckets
})

async function readAll() {
  try {
    await readAllMessages()
    allMessages.value.forEach(m => (m.unread = false))
    showToast({ message: '已全部标为已读', position: 'top' })
  } catch {
    showToast({ message: '操作失败，请重试', position: 'top' })
  }
}

/**
 * 一键清空：先二次确认（不可恢复），确认后删全部消息、清空本地列表。
 * 没消息时直接提示，不弹确认框。
 */
async function onClearAll() {
  if (!allMessages.value.length) {
    showToast({ message: '暂无消息可清空', position: 'top' })
    return
  }
  try {
    await showConfirmDialog({ title: '清空全部消息', message: '将删除你的全部消息，且不可恢复。' })
  } catch {
    return // 用户在确认框点了取消
  }
  try {
    await clearAllMessages()
    allMessages.value = []
    showToast({ message: '消息已清空', position: 'top' })
  } catch {
    showToast({ message: '操作失败，请重试', position: 'top' })
  }
}

/**
 * 点击消息卡片（含 CTA 按钮）：
 * ① 未读先标读——乐观更新本地 unread（分类徽标随 counts 联动），失败回滚；
 * ② 行程类消息跳行程列表；交易/系统/互动暂无落点（交易支付未上线），只标读。
 */
async function onItem(m: Message) {
  if (m.unread) {
    const prev = m.unread
    m.unread = false
    try {
      await readMessage(m.id)
    } catch {
      m.unread = prev
      showToast({ message: '操作失败，请重试', position: 'top' })
      return
    }
  }
  if (m.cta?.kind === 'view') router.push('/trip')
}

/** 左滑删除：成功后本地移除（分类徽标计数随 counts 联动），失败 toast */
async function onDelete(m: Message) {
  try {
    await deleteMessage(m.id)
    allMessages.value = allMessages.value.filter((x) => x.id !== m.id)
  } catch {
    showToast({ message: '删除失败，请重试', position: 'top' })
  }
}
</script>

<style scoped>
.msg-page {
  /* 通用颜色 token 见 src/styles/tokens.css，下面只留本页语义别名 */
  --c-read: var(--c-sub);    /* 已读标题 */
  --c-old: var(--c-muted);   /* 时间戳 / 已读预览 */

  min-height: 100vh;
  min-height: 100dvh;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-sans);
}

/* ---------- 顶栏 ---------- */
:deep(.van-nav-bar) { background: var(--c-card); }
:deep(.van-nav-bar::after) { border-color: var(--c-divider); }
:deep(.van-nav-bar__title) { font-weight: 700; color: var(--c-text); }
:deep(.van-nav-bar .van-icon) { color: var(--c-text); }
/* 顶栏右侧操作：全部已读 / 清空（两个轻量文字操作） */
.nav-act { font-size: 13px; color: var(--c-brand); font-weight: 600; margin-left: 12px; }
.nav-act:first-child { margin-left: 0; }
.nav-act--danger { color: var(--c-red); }

/* ---------- 分类筛选 ---------- */
.cats {
  display: flex;
  gap: 8px;
  padding: 10px 20px 6px;
  overflow-x: auto;
}
.cats::-webkit-scrollbar { display: none; }
.cat {
  position: relative;
  flex-shrink: 0;
  height: 30px;
  padding: 0 14px;
  font-size: 13px; font-weight: 500;
  color: var(--c-read);
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
  color: #fff;
  background: var(--c-red);
  border-radius: 8px;
  vertical-align: middle;
}
.cat.is-active .cat__badge { background: rgba(255, 255, 255, 0.3); }

/* ---------- 列表分组 ---------- */
/* tab 落地页：底部给 tabbar 让位（原为全屏页只有 24px 留白） */
.list {
  --tabbar-h: calc(var(--van-tabbar-height, 50px) + env(safe-area-inset-bottom));
  padding: 6px 20px calc(var(--tabbar-h) + 16px);
}
.group { margin-top: 8px; }
.group__label {
  font-size: 12px; font-weight: 600;
  color: var(--c-old);
  padding: 6px 4px 8px;
}

/* ---------- 消息项 ---------- */
/* 间距放在 swipe-cell 上：item 本身零 margin，左滑露出的删除按钮才能与卡等高 */
.msg-cell { margin-bottom: 8px; }
.item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 12px;
  background: var(--c-card);
  border-radius: 12px;
}

/* 左滑删除按钮：全高红块，右滑区语义「删掉这条」。
   只圆右侧（按钮永远在卡片右边）：圆角与 .item 的 12px 一致，左滑露出的
   轮廓才是一张完整圆角卡，而不是红块上方卡出个方角。 */
.item__del {
  height: 100%;
  width: 72px;
  border: none;
  background: var(--c-red);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  display: grid;
  place-items: center;
  border-radius: 0 12px 12px 0;
}
.item__avatar {
  position: relative;
  width: 40px; height: 40px;
  flex-shrink: 0;
  border-radius: 10px;
  display: grid; place-items: center;
  color: #fff;
}
.item__avatar :deep(.van-icon) { font-size: 20px; }
.item__dot {
  position: absolute; top: -2px; right: -2px;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--c-red);
  border: 2px solid var(--c-card);
}
.item__body { flex: 1; min-width: 0; }
.item__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.item__title {
  font-size: 14px; font-weight: 700;
  color: var(--c-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.item:not(.is-unread) .item__title { font-weight: 500; color: var(--c-read); }
.item__time { font-size: 11px; color: var(--c-old); flex-shrink: 0; }
.item__preview {
  font-size: 12.5px; line-height: 1.5;
  color: var(--c-old);
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.item:not(.is-unread) .item__preview { color: var(--c-old); opacity: 0.85; }

/* 落点按钮：事务型(支付)=暖橙实心 / 行程型(查看)=蓝描边 */
.item__cta {
  margin-top: 10px;
  padding: 6px 14px;
  font-size: 12.5px; font-weight: 600;
  border-radius: 14px;
  transition: all 0.15s;
}
.cta--pay {
  color: #fff;
  background: var(--c-accent);
  box-shadow: 0 2px 6px rgba(255, 106, 43, 0.3);
}
.cta--view {
  color: var(--c-brand-deep);
  background: var(--c-brand-soft);
  border: 1px solid var(--c-brand-soft);
}
.cta--view:active { background: var(--c-brand-soft); }

/* ---------- 空状态 ---------- */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 72px 0 48px;
}
.empty__ic {
  width: 72px; height: 72px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 34px;
  color: var(--c-muted);
  background: var(--c-card);
  border: 1px solid var(--c-divider);
}
.empty__title {
  margin: 16px 0 0;
  font-size: 15px; font-weight: 600;
  color: var(--c-read);
}
.empty__desc {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--c-old);
}

/* ---------- 底部提示 ---------- */
.end-tip {
  text-align: center;
  font-size: 11.5px;
  color: var(--c-old);
  padding: 16px 0 8px;
  opacity: 0.7;
}
</style>
