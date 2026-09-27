<template>
  <div class="chat">
    <!-- 顶栏 -->
    <van-nav-bar title="途灵 · AI 行程" left-arrow fixed placeholder @click-left="onBack">
      <template #right>
        <button class="nav-menu" aria-label="对话菜单" @click="onMenu">
          <van-icon name="ellipsis" size="20" />
        </button>
      </template>
    </van-nav-bar>

    <!-- ① 信息流消息区（卡片化 · 全宽 · 无聊天气泡） -->
    <main ref="msgsRef" class="feed">
      <template v-for="m in messages" :key="m.id">
        <!-- ── 用户提问条（右对齐 · 用户头像在右 · 品牌浅蓝） ── -->
        <section v-if="m.role === 'user'" class="q">
          <p class="q__text">{{ m.text }}</p>
          <span class="q__ic">
            <img v-if="userStore.profile?.avatar" :src="userStore.profile.avatar" alt="" class="q__ic-img" />
            <van-icon v-else name="user-o" />
          </span>
        </section>

        <!-- ── AI 回复：普通内容=左对齐气泡；行程=全宽白卡板块 ── -->
        <article v-else class="a" :class="{ 'a--trip': m.product || m.streamingTrip }">
          <!-- 消息头：AI 图标 + 途灵标识（统一紧凑一行；「AI 行程规划」tag 下线——
               板块形态本身就是行程，标题才是主角，不需要自我介绍） -->
          <!-- 气泡才带头部；行程板块是纯产物卡（顶部品牌条 + 行程卡），
               头部会浮在卡上方孤立，去掉 -->
          <header v-if="!(m.product || m.streamingTrip)" class="a__head a__head--mini">
            <span class="a__ic">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" fill="currentColor"/>
              </svg>
            </span>
            <span class="a__name">途灵</span>
          </header>

          <!-- ② 正文段落（信息流文本） -->
          <p v-if="m.text" class="a__text">{{ m.text }}</p>

          <!-- ② 引用与来源（可展开角标 · 信息流内嵌） -->
          <button
            v-if="m.citation"
            class="cite"
            :class="{ 'is-open': m.citeOpen }"
            @click="m.citeOpen = !m.citeOpen"
          >
            <van-icon name="bookmark-o" />
            <span>引用 {{ m.citation.length }} 篇来源</span>
            <van-icon :name="m.citeOpen ? 'arrow-up' : 'arrow-down'" />
          </button>
          <ul v-if="m.citeOpen" class="cite__list">
            <li v-for="(c, i) in m.citation" :key="i">
              <span class="cite__idx">{{ i + 1 }}</span>
              <span class="cite__name">{{ c.name }}</span>
              <span class="cite__src">{{ c.src }}</span>
            </li>
          </ul>

          <!-- ③ 结构化行程（时间轴板块 · 流式期间直接渲染骨架，随解析逐行填充） -->
          <section v-if="m.product || m.streamingTrip" class="trip">
            <div class="trip__head">
              <span v-if="m.product?.title" class="trip__title">{{ m.product.title }}</span>
              <span v-else class="trip__title trip__title--ph">行程标题生成中…</span>
              <div class="trip__head-rt">
                <span class="trip__badge" :class="{ 'trip__badge--run': m.streamingTrip }">
                  {{ m.streamingTrip ? '生成中' : '可编辑' }}
                </span>
                <!-- 操作收敛：复制/重试从卡底收进右上角，浏览行程不被操作条打断 -->
                <button class="trip__op" aria-label="复制" @click="onCopy(m)"><van-icon name="description" /></button>
                <button class="trip__op" aria-label="重试" :disabled="m.streamingTrip" @click="onRetry(m)"><van-icon name="replay" /></button>
              </div>
            </div>
            <!-- 日期范围：AI 可能听错日期，存之前先让用户核对；start_date 和 days 齐了才显示 -->
            <p v-if="m.product?.start_date && m.product.days?.length" class="trip__date">
              <van-icon name="calendar-o" /> {{ tripDateRange(m.product) }}
            </p>
            <!-- 时间轴：rail + day + desc（参考 Trip.vue .tl 结构） -->
            <div class="trip__tl">
              <template v-if="m.product?.days?.length">
                <div v-for="(d, i) in m.product.days" :key="i" class="tl">
                  <div class="tl__rail">
                    <span class="tl__dot"></span>
                    <span v-if="i < m.product.days.length - 1" class="tl__line"></span>
                  </div>
                  <div class="tl__day">D{{ i + 1 }}</div>
                  <div class="tl__desc">{{ d }}</div>
                </div>
              </template>
              <!-- 流式占位：天数未知时先出 3 行骨架，随解析逐行替换成真内容 -->
              <template v-else-if="m.streamingTrip">
                <div v-for="i in 3" :key="i" class="tl">
                  <div class="tl__rail"><span class="tl__dot"></span><span class="tl__line"></span></div>
                  <div class="tl__day">D{{ i }}</div>
                  <div class="tl__desc tl__desc--ph"></div>
                </div>
              </template>
            </div>
            <div class="trip__foot">
              <!-- 一键编排的行程：后端已落库，给"查看"入口，由用户自己决定何时进详情（不自动跳转） -->
              <template v-if="m.tripId">
                <span class="trip__hint"><van-icon name="success" /> 已保存到我的行程</span>
                <button class="trip__save" @click="openTrip(m)">
                  <van-icon name="eye-o" /> 查看完整行程
                </button>
              </template>
              <!-- 一键生成、尚未保存：手动点「保存到行程」才写库 -->
              <template v-else-if="m.manualSave">
                <span class="trip__hint">确认行程后保存</span>
                <button class="trip__save" @click="onSavePlan(m)">
                  <van-icon name="down" /> 保存到行程
                </button>
              </template>
              <!-- SSE 兜底卡片：仍需手动点保存（保留旧行为） -->
              <template v-else>
                <span class="trip__hint">保存后可编辑</span>
                <button class="trip__save" :disabled="m.streamingTrip || m.saved" @click="onSaveTrip(m)">
                  <van-icon :name="m.saved ? 'success' : 'down'" /> {{ m.saved ? '已保存' : '保存到行程' }}
                </button>
              </template>
            </div>
          </section>

          <!-- ④ 消息操作栏：只给普通气泡（行程的操作已收进板块右上角） -->
          <footer v-if="!(m.product || m.streamingTrip)" class="a__bar">
            <button class="a__act" @click="onCopy(m)"><van-icon name="description" /> 复制</button>
            <button class="a__act" @click="onRetry(m)"><van-icon name="replay" /> 重试</button>
          </footer>
        </article>
      </template>

      <!-- 打字指示器（卡片化加载状态） -->
      <article v-if="thinking" class="a a--loading">
        <header class="a__head">
          <span class="a__ic">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" fill="currentColor"/>
            </svg>
          </span>
          <span class="a__name">途灵</span>
          <span class="a__tag">正在规划…</span>
        </header>
        <div class="typing"><span></span><span></span><span></span></div>
      </article>
    </main>

    <!-- ⑥ 输入条（底部固定 · 简洁） -->
    <footer class="input">
      <input
        v-model="text"
        class="input__field"
        placeholder="告诉途灵你的旅行计划…"
        @keyup.enter="onSend"
      />
      <!-- 生成中：发送键变停止键 -->
      <button v-if="thinking" class="input__stop" @click="onStop" aria-label="停止生成">
        <van-icon name="stop" />
      </button>
      <button v-else class="input__send" :disabled="!text.trim()" @click="onSend" aria-label="发送">
        <van-icon name="arrow" />
      </button>
    </footer>

    <!-- 顶栏菜单：新建对话 / 清空历史 -->
    <van-action-sheet
      v-model:show="menuOpen"
      :actions="menuActions"
      cancel-text="取消"
      @select="onMenuSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { streamChat } from '../api/chat'
import { generateTrip } from '../api/plan'
import { saveTrip, addDays, formatDateRange } from '../api/travel'
import { getProfile } from '../api/user'
import { useUserStore } from '../stores/user'

const route = useRoute()
const router = useRouter()
// 用户头像来源（提问条右侧展示）
const userStore = useUserStore()

interface Citation { name: string; src: string }
interface Product {
  title: string
  days: string[]
  /** 出发日期 YYYY-MM-DD（AI 按用户说的日期推算）。缺省时后端按今天兜底 */
  start_date?: string
}
interface Msg {
  id: string
  role: 'user' | 'ai'
  text?: string
  /** 原始完整文本（含 JSON 代码块），用于构建 history 发给 AI */
  rawText?: string
  citation?: Citation[]
  citeOpen?: boolean
  product?: Product
  /** 已保存到我的行程（防重复保存；从历史恢复后按钮保持「已保存」） */
  saved?: boolean
  /** 一键编排接口已落库的行程 id：卡片显示「查看完整行程」，由用户手动点入，不自动跳转 */
  tripId?: string
  /** 一键生成但尚未保存：卡片显示「保存到行程」，手动保存后翻成已保存态 */
  manualSave?: boolean
  /** 行程板块生成中（流式期间 true）：渲染骨架、禁用保存、徽标显示「生成中」 */
  streamingTrip?: boolean
}

let seq = 0
// id 只用作 v-for 的 key，但必须全局唯一：历史消息的 id 从 localStorage 恢复，
// seq 若每次刷新从 0 重新计数，新消息 id 会和历史撞（新 user 消息 = m1 = 恢复的第一条）
const uid = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`

const msgsRef = ref<HTMLElement | null>(null)
const thinking = ref(false)
const text = ref('')

/* 历史对话持久化（localStorage） */
const STORAGE_KEY = 'travel_chat_history'
const WELCOME = '你好，我是途灵旅行助手。告诉我目的地、天数和预算，我帮你规划行程。'

/**
 * 落盘上限：只留最近 40 条（约 20 轮）。
 *
 * 为什么不是「跟 AI 上下文一样只留 10 条」—— 两者需求不同：
 *   · AI 上下文：只有最近 AI_CONTEXT_SIZE 条会被喂给模型；
 *   · 显示：用户会往回翻，看之前聊了什么、AI 之前排的是哪一版。
 * 所以这里按【显示】的需要定上限。40 条体积也就几十 KB，离 localStorage
 * 约 5MB 的配额很远；真要收紧，改这一个常量即可。
 */
const MAX_STORED_MESSAGES = 40

/** 发给模型的上下文窗口（条数）。与 MAX_STORED_MESSAGES 是两个概念，别混用 */
const AI_CONTEXT_SIZE = 10

const messages = ref<Msg[]>([])

function loadHistory(): Msg[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? (JSON.parse(raw) as Msg[]) : null
    if (!arr || !Array.isArray(arr) || !arr.length) return null
    // 重建 rawText：落盘时【刻意不存】它（见 trimForStorage），带行程的消息
    // 在这里用 product 还原出带 ```json 块的完整文本，供下一轮对话当上下文。
    // 旧数据里本身有 rawText 的，保持原样不受影响。
    arr.forEach(m => {
      if (!m.rawText && m.product) {
        m.rawText = m.text + '\n```json\n' + JSON.stringify(m.product) + '\n```'
      }
    })
    return arr
  } catch { return null }
}
/**
 * 落盘前的裁剪（两层，各砍不同的东西）。
 *
 * ① 只留最近 MAX_STORED_MESSAGES 条 —— 给缓存一个上界，不随聊天记录无限增长。
 *
 * ② 丢掉 rawText —— 它其实【完全可推导】，存着纯属双份：
 *    · 带行程的消息：rawText = 正文 + 那段 ```json 块，而 json 已经解析并存成
 *      product 了，loadHistory 会用它把 rawText 重建成语义等价的东西
 *      （模型只关心 JSON 内容，不关心原始空白）；
 *    · 不带行程的消息：rawText 本来就等于 text，更不需要存两份。
 *    带 json 的那种 rawText 比正文大两三倍，这一刀砍掉的是大头。
 */
function trimForStorage(list: Msg[]): Msg[] {
  return list
    .slice(-MAX_STORED_MESSAGES)
    .map((m) => (m.rawText ? { ...m, rawText: undefined } : m))
}

function saveHistory() {
  try {
    if (messages.value.length > 1) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimForStorage(messages.value)))
    }
  } catch {}
}

/**
 * 历史落盘：防抖 800ms + 卸载前补一次。
 *
 * 原来是 `watch(messages, saveHistory, { deep: true })` 直接落盘 —— 流式回复时
 * 每个 token 都会改 msg.text、立刻触发 deep watcher，把【整个消息数组】
 * JSON.stringify 一遍再写 localStorage。代价是 O(消息数 × token 数)，
 * 而且 localStorage.setItem 是【同步阻塞主线程】的 —— 这就是「对话一多就卡」的主因。
 * 现在一轮回复最多落盘一两次。
 */
let saveTimer: number | undefined
function scheduleSave() {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    saveHistory()
  }, 800)
}
/** 卸载/离开前把挂起的这次写掉，否则最后一段回复会丢 */
function flushSave() {
  if (saveTimer === undefined) return
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  saveHistory()
}

/* ⑤ 建议芯片（已下线：预填问题入口迁至首页 4 个能力图标） */

/**
 * 滚到底部：用 rAF 合帧，一帧最多滚一次。
 *
 * 原来每个 token 都 nextTick + 写一次 scrollTop，而写 scrollTop 会强制浏览器
 * 【同步 reflow】—— DOM 越大越贵（历史多了以后就是每 token 十几毫秒）。
 * 合帧后 token 再密也只是一帧一次。
 */
let scrollPending = false
function scrollBottom() {
  if (scrollPending) return
  scrollPending = true
  nextTick(() => {
    requestAnimationFrame(() => {
      scrollPending = false
      const el = msgsRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  })
}

/* AI 流式对话：streamChat → onToken 累积文本 → onDone 收尾
   组件卸载时 abort 避免泄漏 */
let controller: AbortController | null = null

/**
 * 分流口径（默认走新接口，只把明确的问答/寒暄留给 SSE）。
 *
 * 教训：上一版用"命中行程关键词才走 /plan/trip"，结果用户打"南宁3天""成都3天"
 * 这种最常见的说法（不带"规划/行程"字眼）全部漏到 SSE，时间还是假的。
 * 现在反过来：只有【明确的单点问答】或【纯寒暄】走旧 SSE，其余一律按行程请求。
 */
// 单点问答识别（与后端 chat.js 的 isInfoQuery 完全同口径）
const INFO_RE = /美食|好吃|吃什么|特产|小吃|景点|门票|价格|多少钱|消费|天气|下雨|住宿|酒店|民宿|怎么走|怎么去|交通|地铁|高铁|坐什么车/
const PLAN_RE = /规划|计划|行程|路线|安排|怎么玩|玩几天|几天|排一|日游|自由行|跟团/
const isInfoQuery = (s: string) => INFO_RE.test(s) && !PLAN_RE.test(s)
// 纯寒暄（整句匹配，避免"你好，帮我规划…"被误判）
const CHITCHAT_RE = /^(你好|您好|hi|hello|谢谢|感谢|再见|拜拜|你是谁|在吗|在不在)[\s!！.。?？~]*$/i
/** true = 走一键编排 /plan/trip；false = 走旧 SSE */
const looksLikePlan = (s: string) => !isInfoQuery(s) && !CHITCHAT_RE.test(s)

/** 一键编排请求的 AbortController（点「停止」时取消；与 SSE 的 controller 互斥使用） */
let planAbort: AbortController | null = null

function onSend() {
  const content = text.value.trim()
  if (!content || controller || planAbort) return
  // 取最近 AI_CONTEXT_SIZE 条作为上下文（用 rawText 保留 JSON 块，让 AI 持续输出 JSON 格式）。
  // 注意这个数不等于落盘上限 MAX_STORED_MESSAGES：落盘是为了能往回翻，上下文只为省 token。
  const history = messages.value
    .filter(m => m.rawText || m.text)
    .slice(-AI_CONTEXT_SIZE)
    .map(m => ({ role: m.role, text: m.rawText || m.text! }))
  messages.value.push({ id: uid(), role: 'user', text: content })
  text.value = ''
  scrollBottom()
  scheduleSave() // 用户的提问先落盘：就算这轮流失败，提问也不该丢

  // 行程类需求 → 一键编排：后端串行跑完生成/天气/交通建议/落库，成功直接跳详情。
  // 不在前端解析行程卡片、不本地存草稿。
  if (looksLikePlan(content)) {
    runPlanRequest(content, history)
    return
  }

  // 单点问答 / 闲聊 → 原有 SSE 流式对话（保留原样，不动）
  thinking.value = true
  const aiIdx = messages.value.length
  messages.value.push({ id: uid(), role: 'ai', text: '' })

  // 流式行程状态：文本里一出现 ```json 就切进「板块模式」——
  // json 原文不再进显示文本，只把已解析出的 title/start_date/days 渐进填进板块
  let tripOpen = false
  let tripRaw = ''

  controller = streamChat(
    { message: content, history },
    {
      onToken: (delta) => {
        thinking.value = false
        const msg = messages.value[aiIdx]
        if (!tripOpen) {
          // 还没看到行程块：继续累积文本，同时盯 ```json 开头
          const combined = msg.text + delta
          const idx = combined.indexOf('```json')
          if (idx >= 0) {
            tripOpen = true
            msg.text = combined.slice(0, idx).trim() // 只留 json 块前的引导文字
            tripRaw = combined.slice(idx + '```json'.length)
            msg.streamingTrip = true
            applyStreamingTrip(msg, tripRaw)
          } else {
            msg.text = combined
          }
        } else {
          tripRaw += delta
          applyStreamingTrip(msg, tripRaw)
        }
        scrollBottom()
      },
      onDone: () => {
        thinking.value = false
        controller = null
        const msg = messages.value[aiIdx]
        msg.streamingTrip = false
        if (tripOpen) {
          // 收尾：从原始 json 定稿 product；解析失败/非行程则回退成普通气泡
          const product = parseFinalTrip(tripRaw)
          if (product) {
            msg.product = product
            msg.rawText =
              (msg.text ? msg.text + '\n' : '') + '```json\n' + JSON.stringify(product) + '\n```'
          } else {
            msg.product = undefined
            if (!msg.text) msg.text = '（未生成有效回复，请重试）'
            // json 原文不进气泡，但留在历史上下文里供下一轮续写
            msg.rawText = (msg.text ? msg.text + '\n' : '') + '```json\n' + tripRaw.trim() + '\n```'
          }
        } else {
          msg.rawText = msg.text
          if (!msg.text) msg.text = '（未收到回复，请重试）'
        }
        scrollBottom()
        scheduleSave()
      },
      onError: (err) => {
        thinking.value = false
        controller = null
        const msg = messages.value[aiIdx]
        msg.streamingTrip = false
        if (tripOpen) msg.product = undefined
        msg.text = friendlyError(err)
        scrollBottom()
        scheduleSave()
      },
    },
  )
}

/**
 * 一键行程生成：POST /plan/trip。
 *
 * 交互兜底（用户明确要求）：
 * - 点击立刻禁用输入（thinking=true → 输入键变停止键），占位气泡提示预计耗时；
 * - 成功后【不自动跳转、不自动保存】：占位气泡换成"待保存"行程卡，
 *   用户核对后自己点「保存到行程」写库，保存后才出现「查看完整行程」；
 * - 失败/超时弹友好提示（区分限流/超时），后端报错不抛给用户。
 */
async function runPlanRequest(
  content: string,
  history: Array<{ role: 'user' | 'ai'; text: string }>,
) {
  thinking.value = true
  const aiIdx = messages.value.length
  messages.value.push({ id: uid(), role: 'ai', text: '正在生成行程，预计15秒…' })
  scrollBottom()

  planAbort = new AbortController()
  try {
    const res = await generateTrip(content, history, planAbort.signal)
    planAbort = null
    if (!res?.title || !res.days?.length) throw new Error('bad response: missing trip content')
    // 生成但【不自动保存】：把占位气泡换成"待保存"行程卡，
    // 用户核对内容后手动点「保存到行程」才写库（POST /v1/trips）。
    thinking.value = false
    const msg = messages.value[aiIdx]
    if (msg) {
      msg.text = ''
      msg.manualSave = true
      msg.product = { title: res.title, days: res.days, start_date: res.start_date ?? undefined }
    }
    showToast('行程已生成，确认后可保存')
    scrollBottom()
    scheduleSave()
  } catch (e: any) {
    planAbort = null
    thinking.value = false
    // 用户主动取消（点停止）不弹错误
    if (e instanceof Error && e.name === 'CanceledError') return
    if (e instanceof DOMException && e.name === 'AbortError') return
    // 区分失败原因，别把限流/超时都笼统报成"生成失败"
    let tip = '行程生成失败，请稍后重试'
    const status = e?.response?.status
    if (status === 429) tip = '操作太频繁，请1分钟后再试'
    else if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '')) tip = '行程生成超时，请稍后重试'
    const msg = messages.value[aiIdx]
    if (msg) msg.text = tip
    showToast(tip)
    scrollBottom()
    scheduleSave()
  }
}

/** 离开页面：取消两路在途请求，并把挂起的对话落盘写掉 */
onUnmounted(() => {
  controller?.abort()
  planAbort?.abort()
  flushSave()
})

/** SSE 流里若模型直接给出了行程卡片（旧链路兜底场景），点「保存」仍可落盘——保留原行为 */
async function onSaveTrip(m: Msg) {
  if (!m.product) return
  try {
    await saveTrip({ title: m.product.title, days: m.product.days })
    showToast('已保存到我的行程')
    router.push('/trip')
  } catch {}
}

/** 打开一键编排已落库的行程详情（手动触发，不自动跳） */
function openTrip(m: Msg) {
  if (m.tripId) router.push(`/trip/${m.tripId}`)
}

/**
 * 一键生成卡片的【手动保存】：调 POST /v1/trips 写库。
 * 成功后卡片翻成"已保存 + 查看完整行程"；失败给提示，卡片保持待保存态。
 */
async function onSavePlan(m: Msg) {
  if (!m.product || m.saved) return
  try {
    const r = await saveTrip({
      title: m.product.title,
      days: m.product.days,
      start_date: m.product.start_date,
    })
    m.manualSave = false
    m.saved = true
    m.tripId = r.id
    showToast('已保存到我的行程')
    scheduleSave()
  } catch {
    showToast('保存失败，请稍后重试')
  }
}

/**
 * 流式渐进解析：每来一段 token，就把已解析出的部分填进 product。
 * 效果 = 板块先出骨架，title 引号一闭合立刻显示，days 每闭合一个元素就多一行 ——「逐字填」。
 * 只做正则扫描、不做 JSON.parse：未写完的 json 解析必然失败，正则反而稳定。
 */
function applyStreamingTrip(msg: Msg, raw: string) {
  const t = raw.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const s = raw.match(/"start_date"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  const days = extractClosedArrayStrings(raw, 'days')
  if (!t && !s && !days.length) return
  msg.product = {
    title: t ? t[1] : (msg.product?.title ?? ''),
    days,
    start_date: s ? s[1] : msg.product?.start_date,
  }
}

/**
 * 从 json 原文里提取某数组【已闭合】的字符串元素。
 * 模型还在吐字时数组可能未写完：只收已闭合引号的元素，未闭合的等下一段 token。
 */
function extractClosedArrayStrings(raw: string, key: string): string[] {
  const anchor = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[`))
  if (!anchor || anchor.index === undefined) return []
  const out: string[] = []
  let i = anchor.index + anchor[0].length
  for (;;) {
    const q = raw.indexOf('"', i)
    if (q < 0) break
    let j = q + 1
    let buf = ''
    let closed = false
    while (j < raw.length) {
      const ch = raw[j]
      if (ch === '\\') { buf += ch + (raw[j + 1] ?? ''); j += 2; continue }
      if (ch === '"') { closed = true; break }
      buf += ch; j++
    }
    if (!closed) break
    out.push(buf)
    i = j + 1
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\n' || raw[i] === '\t' || raw[i] === ',')) i++
    if (i < raw.length && raw[i] === ']') break
  }
  return out
}

/** 从流式累积的 json 原文里定稿 Product；结构不符（intent 非 plan）或解析失败返回 null */
function parseFinalTrip(raw: string): Product | null {
  const end = raw.lastIndexOf('```')
  const body = (end >= 0 ? raw.slice(0, end) : raw).trim()
  try {
    const p = JSON.parse(body) as { title?: string; days?: string[]; start_date?: string; intent?: string }
    if (p.title && Array.isArray(p.days) && (p.intent ?? 'plan') === 'plan') {
      return { title: p.title, days: p.days, start_date: p.start_date }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 卡片上的日期范围。
 * 必须显示：AI 可能把「25号」听成别的日子，用户得在【保存前】看见日期才能纠正，
 * 否则存完才发现行程日期不对。
 */
function tripDateRange(p: Product): string {
  if (!p.start_date) return ''
  const end = addDays(p.start_date, p.days.length - 1)
  return `${formatDateRange(p.start_date, end)} · 共${p.days.length}天`
}

/* 错误分类 → 用户能看懂的文案（原样透传 "HTTP 502" 没人懂）。
   后端 /chat/stream 的错误都是写进 delta 流的，这里的 status 主要来自
   vite proxy / 网关层（后端进程不可达时吐 502），所以重试是正解。 */
function friendlyError(err: unknown): string {
  const e = err as Error & { status?: number }
  const status = e.status
  if (status === 401 || status === 403) return '登录已过期，请重新登录'
  if (status === 429) return '提问太频繁了，歇一会儿再试'
  if (status === 502 || status === 503 || status === 504) return 'AI 服务暂时不可用，可点下方「重试」'
  if (status && status >= 500) return '服务开小差了，可点下方「重试」'
  if (/abort/i.test(e.message)) return '已停止生成'
  if (/network|fetch|Failed to fetch|NetworkError|ECONN/i.test(e.message)) return '网络连接异常，请检查网络'
  return '出了点问题，可点下方「重试」'
}

/* 消息操作：复制。
   行程消息把 json 转成干净文本（标题 + 日期 + 每天行程），不带 ```json 后台结构；
   普通消息复制原文（rawText 优先，避免只复制到界面上的截断文本） */
async function onCopy(m: Msg) {
  try {
    const clip = m.product ? buildTripCopy(m.product) : (m.rawText || m.text || '')
    await navigator.clipboard.writeText(clip)
    showToast('已复制')
  } catch {
    showToast('复制失败')
  }
}

function buildTripCopy(p: Product): string {
  const dateLine = p.start_date ? `${p.start_date} · 共${p.days.length}天` : `共${p.days.length}天`
  return [`${p.title}（${dateLine}）`, ...p.days].join('\n')
}

/* 消息操作：重试 = 删掉这条 AI 回复，重发它前面那条用户问题 */
function onRetry(m: Msg) {
  if (controller) return
  const idx = messages.value.indexOf(m)
  if (idx < 0) return
  for (let i = idx - 1; i >= 0; i--) {
    const u = messages.value[i]
    if (u.role === 'user') {
      const q = u.text ?? ''
      messages.value.splice(i, messages.value.length - i)
      text.value = q
      onSend()
      return
    }
  }
}

/* 生成中停止：abort 上游请求 + 清理半成品消息（sse.ts 会把 abort 导向 onAbort，
   不会触发 onDone/onError，所以中断后的收尾在这里做） */
function onStop() {
  controller?.abort()
  controller = null
  planAbort?.abort()
  planAbort = null
  thinking.value = false
  const msg = messages.value[messages.value.length - 1]
  if (msg?.role === 'ai') {
    msg.streamingTrip = false
    // 一个字都还没吐出来的空回复直接移除
    if (!msg.text && !msg.product) messages.value.pop()
  }
  scheduleSave()
  scrollBottom()
}

/* 顶栏菜单：清空历史。
   （「新建对话」已下线：单会话架构下它与清空历史做的是同一件事——清空 + 回欢迎语，
   两个相同入口是冗余。真正的「新建对话」需要多会话列表，那是另一量级的改动。） */
const menuOpen = ref(false)
const menuActions = [{ name: '清空历史', key: 'clear' }]
function onMenu() {
  menuOpen.value = true
}
function onMenuSelect() {
  menuOpen.value = false
  onClearChat()
}

async function onClearChat() {
  try {
    await showConfirmDialog({ title: '清空历史', message: '将删除本地保存的全部聊天记录，且不可恢复。' })
    resetChat()
  } catch {}
}

function resetChat() {
  messages.value = [{ id: uid(), role: 'ai', text: WELCOME }]
  localStorage.removeItem(STORAGE_KEY)
  text.value = ''
  scrollBottom()
}

function onBack() {
  router.back()
}

/* 从首页带需求进入：预填并自动发送 */
onMounted(() => {
  // 刷新后 pinia 状态丢失，补拉一次资料，保证提问条头像稳定显示
  if (!userStore.profile) {
    getProfile().then(p => userStore.setProfile(p)).catch(() => {})
  }
  const hist = loadHistory()
  if (hist) {
    messages.value = hist
  } else {
    messages.value = [{ id: uid(), role: 'ai', text: WELCOME }]
  }
  const q = route.query.q
  if (q && typeof q === 'string' && q.trim()) {
    text.value = q
    onSend()
  } else {
    scrollBottom()
  }
})

// 落盘改成在关键节点显式触发（onSend / onDone / onError / onUnmounted），
// 不再 watch(messages, ..., { deep: true })：深监听每次触发都要重新遍历整个
// 消息数组收集依赖，同样是 O(消息数)，而且它会在每个 token 上触发（流的是一整轮）。
// 显式调用是 O(1)，也顺手去掉了 citeOpen 这类纯 UI 状态的无谓落盘。
</script>

<style scoped>
/* 卡片信息流风格：去掉聊天气泡，AI 回复=全宽白卡，用户输入=紧凑提问条 */
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background: var(--c-bg);
}

/* nav-bar 透明融入 */
:deep(.van-nav-bar) { background: var(--c-card); }
:deep(.van-nav-bar::after) { border-color: var(--c-divider); }
:deep(.van-nav-bar__title) { font-weight: 700; color: var(--c-text); }
:deep(.van-nav-bar .van-icon) { color: var(--c-text); }
/* 顶栏菜单按钮（原为死图标，现挂新建对话/清空历史） */
.nav-menu {
  border: none;
  background: transparent;
  padding: 4px 2px;
  display: flex;
  color: var(--c-text);
}

/* ---------- ① 信息流消息区 ---------- */
.feed {
  flex: 1;
  overflow-y: auto;
  /* 只准纵向滚动：气泡是 shrink-to-fit（左右伸缩），个别内容略超时若漏出 1-2px，
     overflow-x 会被 auto 推导出来冒出一条横滑条。这里显式掐死横向滚动。 */
  overflow-x: hidden;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  -webkit-overflow-scrolling: touch;
}

/* ---------- 用户提问条（右对齐 · 品牌浅蓝 · 右侧用户头像） ---------- */
.q {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  justify-content: flex-end;
}
.q__text {
  /* 限宽放在气泡自身：放在 .q 上会让 .q 塌成 0 宽，文字被逐字换行。
     上限与 AI 气泡（.a 的 84%）一致，左右两道对话线对称——用户消息靠头像，
     头像在气泡右侧贴 feed 边缘，气泡左边线和系统气泡右边线形成镜像。 */
  box-sizing: border-box;
  max-width: 84%;
  margin: 0;
  padding: 10px 12px;
  background: var(--c-brand-soft);
  /* 右上角靠近头像，收窄成小圆角形成指向 */
  border-radius: 12px 4px 12px 12px;
  font-size: 14px; font-weight: 500;
  color: var(--c-brand-deep);
  line-height: 1.5;
  word-break: break-word;
}
.q__ic {
  flex-shrink: 0;
  width: 30px; height: 30px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--c-brand);
  color: #fff;
  display: grid; place-items: center;
  margin-top: 1px;
}
.q__ic-img { width: 100%; height: 100%; object-fit: cover; }
.q__ic :deep(.van-icon) { font-size: 17px; }

/* ---------- AI 回复：默认=左对齐气泡；行程板块=全宽白卡+品牌竖线 ---------- */
.a {
  /* 普通内容（攻略/美食/问答）：左对齐气泡，与右对齐的蓝色提问条成对 */
  align-self: flex-start;
  box-sizing: border-box;
  max-width: 84%;
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  /* 左上角靠近 AI 一侧，收窄形成指向 */
  border-radius: 4px 12px 12px 12px;
  padding: 10px 12px;
}
.a--trip {
  /* 行程板块：产物卡（工作台级）——浅蓝托盘托白卡，与白底描边的聊天气泡色相分离。
     align-self 必须覆盖 .a 的 flex-start：父容器是 column flex，flex-start 会让
     交叉轴（宽度）收缩到内容宽，只写 width:100% 不够，容易把时间轴压变形。
     box-sizing 必须写死边框盒：项目没有全局重置，content-box 下 width:100% + padding
     会超宽 30px，右侧被 .feed 的 overflow-x:hidden 裁掉（徽标/操作图标不显示）。 */
  align-self: stretch;
  box-sizing: border-box;
  max-width: none;
  width: 100%;
  background: var(--c-brand-soft);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: 0 4px 20px rgba(10, 26, 43, 0.08);
}

/* 卡片头：AI 图标 + 途灵标识 */
.a__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.a__ic {
  flex-shrink: 0;
  width: 22px; height: 22px;
  color: var(--c-brand);
  display: grid; place-items: center;
}
.a__ic svg { width: 18px; height: 18px; }
.a__name { font-size: 14px; font-weight: 700; color: var(--c-text); }
/* 气泡的紧凑头部：小图标 + 名字一行，标明「这是途灵说的」，正文紧跟其下 */
.a__head--mini { margin-bottom: 2px; }
.a__head--mini .a__ic { width: 20px; height: 20px; }
.a__head--mini .a__ic svg { width: 15px; height: 15px; }
.a__head--mini .a__name { font-size: 12.5px; }

/* 正文段落（气泡里默认顶格；行程板块里头部下方留白） */
.a__text {
  margin: 0;
  font-size: 14px; line-height: 1.65;
  color: var(--c-text);
  word-break: break-word;
  white-space: pre-wrap;
}
.a--trip .a__text { margin-top: 10px; }

/* ---------- ② 引用与来源（信息流内嵌） ---------- */
.cite {
  margin-top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 11px; font-weight: 600;
  color: var(--c-brand-deep);
  background: var(--c-brand-soft);
  border: 1px solid var(--c-brand-line);
  border-radius: 6px;
}
.cite :deep(.van-icon) { font-size: 13px; }
.cite__list {
  list-style: none;
  margin: 6px 0 0;
  padding: 8px 10px;
  background: var(--c-bg);
  border-radius: 8px;
  border: 1px solid var(--c-divider);
}
.cite__list li { display: flex; align-items: center; gap: 6px; font-size: 11.5px; padding: 3px 0; }
.cite__idx {
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--c-brand); color: #fff;
  font-size: 10px; font-weight: 700;
  display: grid; place-items: center; flex-shrink: 0;
}
.cite__name { color: var(--c-text); flex: 1; }
.cite__src { color: var(--c-sub); font-size: 10.5px; }

/* ---------- ③ 结构化行程（时间轴卡片 · 内嵌 AI 卡片） ---------- */
.trip {
  margin-top: 12px;
  background: var(--c-card); /* 白卡浮出蓝托盘，产物感 */
  border-radius: 10px;
  border: 1px solid var(--c-divider);
  overflow: hidden;
}
.trip__head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--c-divider);
}
.trip__title {
  flex: 1; min-width: 0;
  font-size: 13.5px; font-weight: 700; color: var(--c-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.trip__badge {
  font-size: 10px; font-weight: 600;
  color: var(--c-brand);
  background: var(--c-brand-soft);
  padding: 2px 8px; border-radius: 4px;
}
/* 头部右侧：徽标 + 操作图标一组，右对齐 */
.trip__head-rt {
  display: flex; align-items: center; gap: 6px;
  flex-shrink: 0;
}
/* 右上角操作图标：小而轻，不抢标题主位 */
.trip__op {
  border: none; background: transparent;
  padding: 4px;
  color: var(--c-sub);
  display: grid; place-items: center;
  border-radius: 6px;
}
.trip__op:active { background: var(--c-bg); }
.trip__op:disabled { opacity: 0.4; }
.trip__op :deep(.van-icon) { font-size: 14px; }
/* 日期范围：告诉用户「AI 理解的出发日期」，存之前能核对 */
.trip__date {
  display: flex; align-items: center; gap: 4px;
  margin: 0; padding: 8px 12px 0;
  font-size: 12px; font-weight: 600; color: var(--c-brand);
  font-variant-numeric: tabular-nums;
}
.trip__date :deep(svg) { width: 13px; height: 13px; }
/* 时间轴：rail + day + desc（参考 Trip.vue .tl） */
.trip__tl { padding: 8px 12px; }
.tl {
  display: grid;
  grid-template-columns: 16px 36px 1fr;
  gap: 8px;
  align-items: flex-start;
  /* 流式逐行填入时，每行轻微上浮淡入——「逐字填」从功能变成观感 */
  animation: tl-rise 0.2s ease both;
}
@keyframes tl-rise {
  from { opacity: 0; transform: translateY(3px); }
}
.tl__rail {
  position: relative;
  width: 16px;
  align-self: stretch;
  display: flex; flex-direction: column; align-items: center;
  padding-top: 5px;
}
.tl__dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--c-brand);
  flex-shrink: 0;
  z-index: 1;
}
.tl__line {
  flex: 1;
  width: 2px;
  margin-top: 2px;
  background-image: linear-gradient(var(--c-divider) 50%, transparent 50%);
  background-size: 2px 5px;
  background-repeat: repeat-y;
}
.tl__day {
  font-size: 12px; font-weight: 700;
  color: var(--c-brand);
  padding-top: 1px;
}
.tl__desc {
  min-width: 0;
  font-size: 12.5px; line-height: 1.55;
  color: var(--c-text);
  word-break: break-word;
  overflow-wrap: anywhere;
  padding-bottom: 10px;
}
.trip__foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--c-divider);
}
.trip__hint { font-size: 10.5px; color: var(--c-sub); }
.trip__save {
  flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 14px;
  font-size: 12px; font-weight: 600;
  color: #fff;
  background: var(--c-brand);
  border: none; border-radius: 14px;
  transition: all 0.15s;
}
.trip__save :deep(.van-icon) { font-size: 13px; }
.trip__save:active { transform: scale(0.95); }

/* ---------- 流式生成中的占位态 ---------- */
.trip__badge--run {
  color: var(--c-sub);
  background: var(--c-bg);
}
.trip__title--ph {
  color: var(--c-sub);
  font-weight: 500;
}
.tl__desc--ph {
  height: 13px;
  border-radius: 3px;
  background: var(--c-divider);
  margin-bottom: 10px;
}
.trip__save:disabled { opacity: 0.5; }

/* ---------- ④ 消息操作栏（卡片底部小图标行） ---------- */
.a__bar {
  display: flex;
  gap: 2px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--c-divider);
}
.a__act {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px 10px;
  font-size: 11px; font-weight: 500;
  color: var(--c-sub);
  background: transparent;
  border: none; border-radius: 6px;
  transition: all 0.15s;
}
.a__act :deep(.van-icon) { font-size: 13px; }
.a__act:active { color: var(--c-brand); background: var(--c-brand-soft); }

/* 打字指示器 */
.typing {
  margin-top: 10px;
  display: inline-flex; gap: 5px; align-items: center;
}
.typing span {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--c-sub);
  animation: blink 1.2s infinite ease-in-out;
}
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

/* ---------- ⑥ 输入条（底部固定 · 简洁） ---------- */
.input {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px calc(env(safe-area-inset-bottom) + 8px);
  background: var(--c-card);
  border-top: 1px solid var(--c-divider);
}
.input__field {
  flex: 1; min-width: 0;
  height: 38px;
  padding: 0 14px;
  font-size: 14px;
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-divider);
  border-radius: 19px;
  outline: none;
}
.input__field::placeholder { color: var(--c-sub); }
.input__send {
  width: 38px; height: 38px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--c-brand);
  color: #fff;
  display: grid; place-items: center;
  transition: all 0.15s;
}
.input__send:disabled { background: var(--c-divider); color: var(--c-sub); }
.input__send:not(:disabled):active { transform: scale(0.92); }
.input__send :deep(.van-icon) { font-size: 16px; font-weight: 700; }
/* 生成中：发送键原位变停止键（描边灰，与发送键的实心品牌色区分） */
.input__stop {
  width: 38px; height: 38px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  color: var(--c-sub);
  display: grid; place-items: center;
}
.input__stop:active { transform: scale(0.92); }
.input__stop :deep(.van-icon) { font-size: 16px; }
</style>