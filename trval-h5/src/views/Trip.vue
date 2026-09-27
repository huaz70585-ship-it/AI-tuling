<template>
  <div class="trip-page">
    <!-- 顶栏：标题 + 副信息行 -->
    <van-nav-bar left-arrow fixed placeholder @click-left="onBack" @click-right="onMore">
      <template #title>
        <div class="nav-title">
          <span class="nav-title__main">{{ headTitle }}</span>
          <span class="nav-title__sub">
            <span>{{ headDateRange }}</span>
            <span class="dot">·</span>
            <span>{{ headPeople }}人</span>
            <span class="dot">·</span>
            <span class="nav-title__budget">¥{{ headBudget }}</span>
          </span>
        </div>
      </template>
      <template #right>
        <van-icon name="ellipsis" size="20" />
      </template>
    </van-nav-bar>

    <!-- 错误态：id 无效 / 接口失败时兜底，不再裸抛异常 -->
    <div v-if="loadError" class="error-state">
      <span class="error-state__ic"><van-icon name="warning-o" /></span>
      <p class="error-state__title">行程加载失败</p>
      <p class="error-state__sub">这段行程可能不存在或已被删除</p>
      <button class="error-state__btn" @click="load">重新加载</button>
      <button class="error-state__link" @click="onBack">返回行程列表</button>
    </div>

    <template v-else>
      <!-- Tab：行程。行中时多一个「今天」并默认落在它上面
           （不是在行中就不显示 —— 未来的行程谈不上「今天」） -->
      <div class="seg">
        <button
          v-if="isTraveling"
          class="seg__btn"
          :class="{ 'is-active': view === 'today' }"
          @click="switchView('today')"
        >
          今天
        </button>
        <button class="seg__btn" :class="{ 'is-active': view === 'plan' }" @click="switchView('plan')">
          行程
        </button>
      </div>

    <!-- 日期芯片（由 trip.days 驱动，不再写死 4 天）。
         「今天」视图不需要它 —— 那里只有今天，没有可切的天 -->
    <div v-if="view !== 'today'" class="days">
      <button
        v-for="d in trip?.days ?? []"
        :key="d.id"
        class="day"
        :class="{ 'is-active': d.day_index === activeDayIndex }"
        @click="activeDayIndex = d.day_index"
      >D{{ d.day_index }}</button>
    </div>

    <!-- 当日头部：日期 / 天气 / 预算（「今天」视图自带头部，见下方 .today__head） -->
    <div v-if="view !== 'today'" class="dayhead">
      <span class="dayhead__d">D{{ activeDayIndex }}</span>
      <span class="dayhead__date">{{ activeDayDate }}</span>
      <!-- 天气：Open-Meteo 每日预报（超出预报范围 / 定位失败时不显示） -->
      <span v-if="activeDayWeather" class="dayhead__weather">
        <span class="dayhead__wicon" v-html="weatherIcon(activeDayWeather.icon)"></span>
        {{ activeDayWeather.text }} {{ activeDayWeather.tmax }}°
      </span>
      <span class="dayhead__budget">当日 <em>¥{{ activeDayBudget }}</em></span>
    </div>

    <!-- 行中视图：今天该干嘛。和「行程」的差别是排序与预算口径 ——
         未完成在前（已完成折叠）、预算只看「还要花多少」，
         因为出门后关心的是「接下来」，不是「我计划过什么」 -->
    <template v-if="view === 'today'">
      <div class="today">
        <div class="today__head">
          <span class="today__d">D{{ todayDayIndex }}</span>
          <span class="today__date">{{ todayDateText }}</span>
          <span v-if="todayWeather" class="today__weather">
            <span class="today__wicon" v-html="weatherIcon(todayWeather.icon)"></span>
            {{ todayWeather.text }} {{ todayWeather.tmax }}°
          </span>
        </div>

        <!-- 当天天气提醒（与「行程」视图同一份规则） -->
        <div v-if="todayWeatherAlert" class="walert">
          <span class="walert__ic" v-html="weatherIcon(todayWeather?.icon)"></span>
          <p>{{ todayWeatherAlert }}</p>
        </div>

        <!-- 进度 -->
        <div v-if="todayItems.length" class="prog">
          <span class="prog__track"><span class="prog__fill" :style="{ width: todayProgress + '%' }"></span></span>
          <span class="prog__text">{{ todayDone.length }}/{{ todayItems.length }}</span>
        </div>

        <!-- 下一站：单独拎出来，别被后面的项淹掉 -->
        <div v-if="nextItem" class="next">
          <p class="next__label">下一站</p>
          <p class="next__title">{{ nextItem.title }}</p>
          <p class="next__meta">
            {{ nextItem.start_time }}
            <template v-if="nextItem.price_ref"> · 人均 ¥{{ nextItem.price_ref }}</template>
            <span v-if="isOverdue(nextItem)" class="late">已过时</span>
          </p>
          <button class="next__btn" @click="onCheckItem(nextItem)">我已去过</button>
        </div>

        <!-- 后续待办 -->
        <div v-if="todayRest.length" class="tlist">
          <div v-for="i in todayRest" :key="i.id" class="titem">
            <div class="titem__body">
              <p class="titem__title">{{ i.title }}</p>
              <p class="titem__meta">
                {{ i.start_time }}
                <template v-if="i.price_ref"> · 人均 ¥{{ i.price_ref }}</template>
                <span v-if="isOverdue(i)" class="late">已过时</span>
              </p>
            </div>
            <button class="titem__check" @click="onCheckItem(i)">打卡</button>
          </div>
        </div>

        <!-- 已完成：默认折叠，走一天后它会淹掉「下一站」 -->
        <div v-if="todayDone.length" class="done">
          <button class="done__head" @click="doneExpanded = !doneExpanded">
            已完成 {{ todayDone.length }} 项
            <van-icon :name="doneExpanded ? 'arrow-up' : 'arrow-down'" />
          </button>
          <div v-if="doneExpanded" class="tlist">
            <div v-for="i in todayDone" :key="i.id" class="titem titem--done">
              <div class="titem__body">
                <p class="titem__title">{{ i.title }}</p>
                <p class="titem__meta">{{ checkTimeText(i) }} 已打卡</p>
              </div>
              <button class="titem__check titem__check--undo" @click="onCheckItem(i)">撤销</button>
            </div>
          </div>
        </div>

        <p v-if="!todayItems.length" class="today__empty">今天没有安排</p>

        <p v-if="todayItems.length" class="today__foot">
          <template v-if="todayPending.length">今天还要花 <em>¥{{ todayLeftBudget }}</em></template>
          <template v-else>今天的安排全部走完啦</template>
        </p>
      </div>
    </template>

    <template v-else>
    <!-- 天气提醒（规则版）：雨/雪/雾/极端温度才出现，正常天气不占地方。
         数据来自 dayhead 同一份 Open-Meteo 预报，切页签 / 改日期自动跟着变 -->
    <div v-if="weatherAlert" class="walert">
      <span class="walert__ic" v-html="weatherIcon(activeDayWeather?.icon)"></span>
      <p>{{ weatherAlert }}</p>
    </div>

    <!-- 时间轴（trip_item 驱动；locked = 用户已锁定/已预订）。
         编号节点即 logo 里那条路的展开；点卡片任意位置选中（原勾选圆已并入整卡点击） -->
    <div class="timeline">
      <template v-for="row in timeline" :key="row.item.id">
        <div class="tl" :class="{ 'tl--linked': !!row.hop }">
          <div class="tl__rail">
            <span class="tl__node" :class="dotState(row.index)">{{ String(row.index + 1).padStart(2, '0') }}</span>
            <span v-if="row.index < dayItems.length - 1" class="tl__line"></span>
          </div>
          <div
            class="tl__card"
            :class="{ 'is-selected': selectedItemId === row.item.id }"
            role="button"
            @click="onToggleSelect(row.item)"
          >
            <div class="tl__body">
              <p class="tl__time">{{ row.item.start_time }}</p>
              <p class="tl__title">{{ row.item.title }}</p>
              <p class="tl__meta">{{ tagList(row.item).join(' · ') }}</p>
              <!-- 决策卡入口：整卡的 @click 已经被「选中/操作」占用，所以这里必须 @click.stop。
                   抵达/返程是行程边界动作、不是景点，按语义直接不给入口（boundary 由后端判定）；
                   其余匹配不到城市景点库的项（如"午餐"）仍会在查一次失败后永久隐藏（noSpot），不留死入口。
                   不靠 noSpot 挡边界项的原因：那样得先让用户点一次、等一次请求、失败后才消失。 -->
              <button
                v-if="!row.item.boundary && !noSpot.includes(row.item.title)"
                class="tl__why"
                @click.stop="openSpot(row.item)"
              >
                {{ spotLoadingId === row.item.id ? '正在查…' : '为什么值得去 ›' }}
              </button>
            </div>
            <div class="tl__side">
              <p v-if="row.item.price_ref" class="tl__price"><em>¥</em>{{ row.item.price_ref }}</p>
            </div>
            <van-icon v-if="row.item.locked" name="checked" class="tl__lock" />
          </div>
        </div>

        <!-- 到下一站的交通衔接（AI 生成；未生成成功时不渲染，不占位）。
             视觉是卡片之间的一段虚线「路」，信息行内化，不再占色块。
             点击「方式」可切换（主推 + AI 备选，本地零延迟） -->
        <div v-if="row.hop" class="hop">
          <div class="hop__rail"><span class="hop__dash"></span></div>
          <div class="hop__main">
            <div class="hop__row">
              <button class="hop__mode" @click.stop="openHopPicker(row.hop.from_item_id)">
                <span class="hop__ic" v-html="HOP_ICONS[row.hop.mode] ?? HOP_ICONS.unknown"></span>
                {{ row.hop.label }}
                <van-icon name="arrow-down" />
              </button>
              <!-- 收尾段的目标不是景点，是当地的火车站/机场，单独标出来 -->
              <span v-if="row.hop.dest" class="hop__dest">→ {{ row.hop.dest }}</span>
              <span class="hop__meta">
                {{ row.hop.meta }}<template v-if="row.hop.cost !== null"> · <em class="hop__cost">约 ¥{{ row.hop.cost }}</em></template>
              </span>
              <span v-if="row.hop.tight" class="hop__warn">衔接偏紧</span>
            </div>
            <!-- 分步走法：坐几号线/换乘/哪站下/哪个口，每步一个动作图标串成动线 -->
            <ol v-if="row.hop.steps.length" class="hop__steps">
              <li v-for="(s, i) in row.hop.steps" :key="i" class="hop__step">
                <span class="hop__step-ic" v-html="STEP_ICONS[s.icon] ?? STEP_ICONS.walk"></span>
                <span class="hop__step-text">{{ s.text }}</span>
              </li>
            </ol>
            <p v-else-if="row.hop.tip" class="hop__tip">{{ row.hop.tip }}</p>
          </div>
        </div>
      </template>

      <!-- 空当日：显示 AI 生成的当天摘要（trip_days.title）；无摘要时兜底提示 -->
      <div v-if="!dayItems.length" class="tl tl--empty">
        <div class="tl__rail"><span class="tl__dot"></span></div>
        <div class="tl__card">
          <div class="tl__body">
            <p class="tl__time">全天</p>
            <p class="tl__title">{{ emptyDayTitle }}</p>
            <p class="tl__hint">{{ emptyDayHint }}</p>
            <button class="tl__gen" :disabled="dayGenerating" @click="onGenerateDay">
              <van-icon :name="dayGenerating ? 'replay' : 'fire-o'" />
              {{ dayGenerating ? 'AI 正在排这一天的行程…' : '让 AI 补排这一天' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- AI 免责提示：纯文字居中，不占卡片
         （原「N 项安排待你确认」+「去确认」按钮 + 黄色卡已全部下线：
           ai_confidence 一直是 null，永远显示 0 项，按钮点进去只是占位 toast） -->
    <p class="ai-note">AI 时间/地点可能不准，请以实际为准</p>
    </template>

    <!-- 底部留白 -->
    <div class="foot-space"></div>

    <!-- 选中项操作栏（选中某 item 时替换底部操作栏） -->
    <footer v-if="selectedItemId" class="item-actionbar">
      <!-- 边界项（抵达/返程）位置固定，把两个移动按钮换成一句说明；
           普通项则按方向禁用（把第二项上移会顶走「抵达」，那个方向同样关掉） -->
      <span v-if="selectedBoundaryHint" class="item-actionbar__hint">{{ selectedBoundaryHint }}</span>
      <template v-else>
        <button
          class="item-actionbar__btn"
          :disabled="!canMoveSelectedUp"
          @click="onMoveItem('up')"
        >
          <van-icon name="arrow-up" /> 上移
        </button>
        <button
          class="item-actionbar__btn"
          :disabled="!canMoveSelectedDown"
          @click="onMoveItem('down')"
        >
          <van-icon name="arrow-down" /> 下移
        </button>
      </template>
      <button class="item-actionbar__btn item-actionbar__btn--del" @click="onDeleteItem">
        <van-icon name="delete-o" /> 删除
      </button>
      <button class="item-actionbar__btn item-actionbar__btn--cancel" @click="selectedItemId = null">
        取消
      </button>
    </footer>

    <!-- 底部：预算总结（不含预订入口） -->
    <footer v-else class="actionbar">
      <span class="actionbar__label">本次行程总预算</span>
      <span class="actionbar__amount">¥{{ headBudget }}</span>
      <button class="actionbar__ai" :disabled="optimizing" @click="optOpen = true">
        <van-icon name="edit" /> {{ optimizing ? 'AI 调整中…' : 'AI 调整' }}
      </button>
    </footer>

    <!-- 三点菜单：修改日期 / 修改人数 -->
    <van-action-sheet
      v-model:show="moreOpen"
      :actions="moreActions"
      cancel-text="取消"
      @select="onMoreSelect"
    />

    <!-- 修改日期：范围日历（起止同日 = 1 天行程） -->
    <van-calendar
      v-model:show="calOpen"
      type="range"
      title="修改出行日期"
      confirm-text="保存"
      :min-date="calMinDate"
      :max-date="calMaxDate"
      :default-date="calDefault"
      :allow-same-day="true"
      @confirm="onCalConfirm"
    />

    <!-- 修改人数 -->
    <van-popup v-model:show="peopleOpen" position="bottom" round>
      <div class="people">
        <p class="people__title">修改出行人数</p>
        <div class="people__row">
          <div class="people__label">
            <span class="people__name">成人</span>
            <span class="people__hint">12 岁及以上</span>
          </div>
          <van-stepper v-model="adults" :min="1" :max="20" integer />
        </div>
        <div class="people__row">
          <div class="people__label">
            <span class="people__name">儿童</span>
            <span class="people__hint">0 - 11 岁 · 半价</span>
          </div>
          <van-stepper v-model="childrenCount" :min="0" :max="10" integer />
        </div>
        <button class="people__save" :disabled="saving" @click="onSavePeople">保存</button>
      </div>
    </van-popup>

    <!-- 交通方式切换：点击衔接条弹出，主推 + AI 备选，选中即本地生效（零延迟） -->
    <van-popup v-model:show="hopPickerOpen" position="bottom" round :style="{ maxHeight: '60%' }">
      <div class="hop-picker">
        <p class="hop-picker__title">{{ hopPickerTitle }} · 怎么去</p>
        <ul class="hop-picker__list">
          <li
            v-for="opt in hopPickerList"
            :key="opt.mode"
            class="hop-picker__item"
            :class="{ 'is-active': opt.active }"
            @click="onPickHop(opt)"
          >
            <span class="hop-picker__ic" v-html="HOP_ICONS[opt.mode] ?? HOP_ICONS.unknown"></span>
            <div class="hop-picker__body">
              <p class="hop-picker__name">
                {{ opt.label }}
                <span class="hop-picker__meta">
                  {{ opt.meta }}<template v-if="opt.cost !== null"> · 约 ¥{{ opt.cost }}</template>
                </span>
              </p>
              <!-- 一句摘要（第一步走法）；选中后衔接条展开完整步骤 -->
              <p v-if="opt.summary" class="hop-picker__tip">{{ opt.summary }}</p>
            </div>
            <van-icon v-if="opt.active" name="success" class="hop-picker__check" />
          </li>
        </ul>
      </div>
    </van-popup>

    <!-- AI 对话（agent 会话）：一句话说出你想怎么改，AI 自己决定是查天气还是重排行程，
         并把「调用了什么工具」实时显示出来 —— 过程外化，用户看得见 AI 在做什么。
         写操作落库后主动重取详情，底部预算跟着新的行程项重算 -->
    <van-popup v-model:show="optOpen" position="bottom" round :style="{ maxHeight: '78vh' }">
      <div class="opt">
        <p class="opt__title">AI 调整行程</p>
        <p class="opt__hint">用一句话说说你想怎么改 · 如「购物太多，换成亲子项目」</p>

        <!-- 工具调用进度 -->
        <div v-if="agentSteps.length" class="opt__steps">
          <div
            v-for="(s, i) in agentSteps"
            :key="i"
            class="opt__step"
            :class="{ 'is-fail': !s.ok }"
          >
            <van-icon :name="s.ok ? 'passed' : 'warning-o'" />
            <span class="opt__step-name">{{ AGENT_TOOL_LABEL[s.tool] || s.tool }}</span>
            <span class="opt__step-state">{{ s.ok ? '完成' : '失败' }}</span>
          </div>
        </div>

        <!-- 最终答复（流式累积） -->
        <p v-if="agentReply" class="opt__reply">{{ agentReply }}</p>

        <textarea
          v-model="optText"
          class="opt__input"
          rows="3"
          maxlength="120"
          placeholder="例如：加一天当地美食 / 把D2换成亲子乐园 / 这几天会下雨吗"
        ></textarea>
        <div class="opt__row">
          <button class="opt__cancel" :disabled="optimizing" @click="onOptCancel">
            {{ optimizing ? '停止' : (agentReply ? '关闭' : '取消') }}
          </button>
          <button class="opt__go" :disabled="optimizing || !optText.trim()" @click="onOptimize">
            {{ optimizing ? 'AI 处理中…' : '开始调整' }}
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 景点决策卡：回答「为什么值得去、我适不适合、待多久、有什么坑、不去还能去哪」。
         内容来自 /v1/spot/:id 的 brief（AI 生成，带把握度与更新时间），
         brief 为空时显示空态而不是塞假数据 —— 没有依据就不说话。 -->
    <van-popup v-model:show="spotOpen" position="bottom" round :style="{ maxHeight: '82vh' }">
      <div class="spot">
        <header class="spot__head">
          <div>
            <p class="spot__city">{{ spotDetail?.city_name || '—' }}</p>
            <h3 class="spot__title">{{ spotDetail?.name || '景点' }}</h3>
          </div>
          <van-icon name="cross" class="spot__close" @click="spotOpen = false" />
        </header>

        <div v-if="spotLoading" class="spot__loading"><van-loading size="20" /> 正在整理决策依据…</div>

        <template v-else-if="spotBrief">
          <p class="spot__why">{{ spotBrief.why_go }}</p>

          <template v-if="spotBrief.good_for.length">
            <p class="spot__label">适合</p>
            <div class="spot__chips">
              <span v-for="g in spotBrief.good_for" :key="g" class="spot__chip spot__chip--yes">{{ g }}</span>
            </div>
          </template>
          <template v-if="spotBrief.not_good_for.length">
            <p class="spot__label">不适合</p>
            <div class="spot__chips">
              <span v-for="g in spotBrief.not_good_for" :key="g" class="spot__chip spot__chip--no">{{ g }}</span>
            </div>
          </template>

          <div v-if="spotBrief.best_slot || spotBrief.stay_min" class="spot__time">
            <span v-if="spotBrief.best_slot" class="spot__time-item">
              <em>最佳时段</em>{{ spotBrief.best_slot }}
            </span>
            <span v-if="spotBrief.stay_min" class="spot__time-item">
              <em>建议停留</em>{{ stayText(spotBrief.stay_min) }}
            </span>
          </div>

          <div v-if="spotBrief.booking_note || spotBrief.ticket_note" class="spot__note">
            <p v-if="spotBrief.booking_note"><em>预约</em>{{ spotBrief.booking_note }}</p>
            <p v-if="spotBrief.ticket_note"><em>票务</em>{{ spotBrief.ticket_note }}</p>
            <p class="spot__disclaim">票价与预约规则请以景区官方公示为准</p>
          </div>

          <template v-if="spotBrief.avoid.length">
            <p class="spot__label">避坑</p>
            <ul class="spot__list">
              <li v-for="a in spotBrief.avoid" :key="a">{{ a }}</li>
            </ul>
          </template>

          <template v-if="spotBrief.photo.length">
            <p class="spot__label">拍照点</p>
            <ul class="spot__list">
              <li v-for="p in spotBrief.photo" :key="p">{{ p }}</li>
            </ul>
          </template>

          <template v-if="spotDetail?.alts.length">
            <p class="spot__label">不去这里的话</p>
            <div class="spot__alts">
              <button
                v-for="a in spotDetail.alts"
                :key="a.id"
                class="spot__alt"
                @click="openAlt(a.id)"
              >
                <span class="spot__alt-name">{{ a.name }}</span>
                <span class="spot__alt-tags">{{ a.shared_tags.join(' · ') }}</span>
              </button>
            </div>
          </template>

          <!-- 溯源：告诉用户这份依据是什么来的、多新的、模型自己有多大把握。
               排队、实时客流这类【没有数据源】的信息不在这里出现，也不应补 -->
          <p class="spot__foot">
            {{ spotSourceText }}
          </p>
        </template>

        <div v-else class="spot__empty">
          <p>这个点暂时没有决策依据</p>
          <span>景点库还没有覆盖到它，补上后会在这里出现</span>
        </div>
      </div>
    </van-popup>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog, showLoadingToast } from 'vant'
import {
  getTripDetail,
  deleteTripItem,
  moveTripItem,
  updateTrip,
  generateTripDay,
  checkTripItem,
  formatDateRange,
  formatDateCn,
  formatMoney,
  type TripDetail,
  type TripItem,
} from '../api/travel'
import { streamTripAgent, AGENT_TOOL_LABEL, type AgentStep, type AgentTurn } from '../api/agent'
import { getTripWeather, type DayWeather } from '../api/weather'
import { getTripHops, type TripHop, type HopMode, type HopStep } from '../api/hop'
import { HOP_ICONS, STEP_ICONS } from '../utils/hopIcons'
import { weatherAlertText } from '../utils/weatherAlert'
import {
  getCitySpots,
  getSpotDetail,
  requestSpotBrief,
  type CitySpot,
  type SpotDetail,
} from '../api/city'

const route = useRoute()
const router = useRouter()

const trip = ref<TripDetail | null>(null)
const activeDayIndex = ref(1)
/** 详情加载失败标记：true 时渲染错误态（不再向控制台裸抛异常） */
const loadError = ref(false)
/** 当前选中的行程项 ID（用于删除/上移/下移操作） */
const selectedItemId = ref<string | null>(null)
/** 顶部 Tab：今天 / 行程（「今天」只在行中时出现，详见 isTraveling） */
const view = ref<'today' | 'plan'>('plan')

/**
 * 切视图时顺手清掉选中项。
 * 否则在「行程」里选中一项后切到「今天」，底部还挂着上移/删除，
 * 操作的是屏幕上根本看不见的那一项。
 */
function switchView(v: 'today' | 'plan') {
  view.value = v
  if (v !== 'plan') selectedItemId.value = null
}

const tripId = computed(() => String(route.params.id ?? '1001'))

/** 请求序号：/trip/a → /trip/b 快速互跳时组件复用，a 的慢响应不能覆盖 b 的数据 */
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  loadError.value = false
  try {
    const detail = await getTripDetail(tripId.value)
    if (seq !== loadSeq) return // 已经切到别的行程，丢弃这次结果
    trip.value = detail
    // 换行程后日期芯片回到 D1（trip.days 至少 1 天）
    activeDayIndex.value = detail?.days[0]?.day_index ?? 1
    // 天气与交通衔接都是附加信息，不阻塞页面渲染
    void loadWeather(tripId.value)
    void loadHops()
  } catch {
    if (seq !== loadSeq) return
    // 静默接住（无效 id / 接口失败），交给错误态 UI，不打爆控制台
    trip.value = null
    loadError.value = true
  }
}

/** 已请求过的「行程|天」，避免 load 与 watch 同时触发造成重复请求 */
let hopKey = ''
let hopSeq = 0

/**
 * 拉取当天相邻项的交通衔接。
 * 后端缓存优先：命中毫秒级返回；未命中才调 AI（约 1 秒）。
 * 接口失败 / AI 不可用时清空，页面当作没有这段信息，不影响行程主体。
 * force=true 用于删项、移动项之后强制重算（项的顺序变了，缓存的衔接对不上）。
 */
async function loadHops(force = false) {
  const id = tripId.value
  const day = activeDayIndex.value
  const key = `${id}|${day}`
  if (!force && key === hopKey) return
  // 同一天的重拉（移动/删项后）保留旧数据到新响应到达，避免交通条先闪空再出现；
  // 换行程或换天则必须清空，否则会短暂显示上一天的衔接。
  // 旧数据里被移动/删除打乱的那些段，由 timeline 的 to_item_id 校验兜住，不会错位。
  const sameDay = key === hopKey
  hopKey = key
  const seq = ++hopSeq
  if (!sameDay) hops.value = []
  try {
    const res = await getTripHops(id, day)
    if (seq !== hopSeq) return
    hops.value = res.hops
  } catch {
    if (seq !== hopSeq) return
    hops.value = []
  }
}

onMounted(load)
// 详情页之间互跳（/trip/1001 → /trip/1002）组件复用不重建，必须 watch 参数重拉
watch(tripId, load)
// 切换天数时清空选中项，并重新拉当天交通衔接（同行程同天不会重复请求）
watch(activeDayIndex, () => {
  selectedItemId.value = null
  void loadHops()
})

/* ── 顶栏 ─────────────────────────── */
const headTitle = computed(() => trip.value?.title ?? '')
const headDateRange = computed(() =>
  trip.value ? formatDateRange(trip.value.start_date, trip.value.end_date) : '',
)
const headPeople = computed(() => {
  const t = trip.value
  return t ? t.traveler.adults + (t.traveler.children?.length ?? 0) : 0
})
const headBudget = computed(() => (trip.value ? formatMoney(trip.value.budget_total) : '0'))

/* ── 当日 ─────────────────────────── */
const activeDay = computed(
  () => trip.value?.days.find((d) => d.day_index === activeDayIndex.value) ?? trip.value?.days[0] ?? null,
)
const activeDayDate = computed(() => (activeDay.value ? formatDateCn(activeDay.value.date) : ''))

/** 占位标题：日期变长时后端补建的空天，title 只写了 "D3"，不该直接当文案显示 */
const isPlaceholderTitle = (t: string | undefined) => /^D\d+$/.test((t ?? '').trim())

/** 空天卡片标题：有真实摘要就显示摘要，否则给兜底文案 */
const emptyDayTitle = computed(() => {
  const t = activeDay.value?.title
  if (t?.trim() && !isPlaceholderTitle(t)) return t
  return trip.value?.status === 'generating' ? '当天安排生成中…' : '这一天还没有安排'
})
const emptyDayHint = computed(() =>
  trip.value?.status === 'generating'
    ? 'AI 正在排这一天的行程'
    : 'AI 会参考前面几天已排的景点，接着往下排',
)

/** 计费人数权重：成人 1、儿童 0.5（与后端重算总预算的口径一致） */
const billableWeight = computed(() => {
  const t = trip.value?.traveler
  return t ? t.adults + (t.children?.length ?? 0) * 0.5 : 1
})

/**
 * 当日金额 = 当天门票人均价之和 × 计费人数 + 当天交通衔接费。
 * 口径与后端 computeBudget 一致：门票按人头乘权重；hop 是整车/整程的钱（打车/公交），
 * 不随人数翻倍，直接加。原来只算门票，导致当日价格漏掉每段交通费。
 */
const activeDayBudget = computed(() =>
  formatMoney(
    (activeDay.value?.items ?? []).reduce((s, it) => s + (it.price_ref ?? 0), 0) * billableWeight.value
      + hops.value.reduce((s, h) => s + (h.cost_ref ?? 0), 0),
  ),
)

/* ── 天气（后端代理 Open-Meteo，按行程日期取每日预报） ────────── */
const weather = ref<Record<string, DayWeather>>({})

/** 当天天气：按日期取；超出预报范围（未来 15 天外）取不到，模板里自动不显示 */
const activeDayWeather = computed(() =>
  activeDay.value ? weather.value[activeDay.value.date] : undefined,
)

async function loadWeather(id: string) {
  try {
    const res = await getTripWeather(id)
    weather.value = Object.fromEntries(res.days.map((d) => [d.date, d]))
  } catch {
    weather.value = {} // 天气拿不到不影响行程本身
  }
}

/** 天气提醒（规则版）：雨/雪/雾/极端温度才有一句话，正常天气为 null 不渲染 */
const weatherAlert = computed(() => weatherAlertText(activeDayWeather.value))

/** 天气图标：24x24 线性图标，与金刚区同风格（stroke=currentColor） */
const WEATHER_ICONS: Record<string, string> = {
  sunny:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  cloudy:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="8.5" cy="8" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 3.2v1.4M3.7 8h1.4M4.9 4.4l1 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 19h7.5a3.5 3.5 0 0 0 0-7 5.2 5.2 0 0 0-9.8 1.5A3.1 3.1 0 0 0 10 19Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  overcast:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M7 17.5h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4 1.6A3.3 3.3 0 0 0 7 17.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14.5h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4 1.6A3.3 3.3 0 0 0 7 14.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4.5 18h15M6.5 21h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  drizzle:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14.5h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4 1.6A3.3 3.3 0 0 0 7 14.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.5 18v1.6M12.5 18v1.6M15.5 18v1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4 1.6A3.3 3.3 0 0 0 7 14Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 17.2l-1 3.3M13 17.2l-1 3.3M17 17.2l-1 3.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4 1.6A3.3 3.3 0 0 0 7 14Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="9.5" cy="18" r="1" stroke="currentColor" stroke-width="1.4"/><circle cx="13" cy="20" r="1" stroke="currentColor" stroke-width="1.4"/><circle cx="16.5" cy="18" r="1" stroke="currentColor" stroke-width="1.4"/></svg>',
  thunder:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14h10a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.4 1.6A3.3 3.3 0 0 0 7 14Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.4 16.2l-2.6 3.9h2.6l-1.6 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

function weatherIcon(key: string | undefined): string {
  return (key && WEATHER_ICONS[key]) ?? WEATHER_ICONS.overcast
}

/** 当日时间轴数据：按 sort_order 排序 */
const dayItems = computed<TripItem[]>(() =>
  [...(activeDay.value?.items ?? [])].sort((a, b) => a.sort_order - b.sort_order),
)

/* ── 边界项（抵达/返程）：位置固定在当天首/末，不给移动入口 ────────── */

/**
 * 交换 idx 与 swapIdx 之后，抵达是否仍在首位、返程是否仍在末位。
 *
 * 判的是【交换后的整个顺序】，不是「被拖的是不是边界项」——
 * 把第二项往上拖同样会把「抵达」顶到中间，只判被拖项会漏掉这种情况。
 * 与后端 routes/trip.js 的拦截同一条规则（那边是兜底，这边是提前关入口）。
 */
function breaksBoundary(list: TripItem[], idx: number, swapIdx: number): boolean {
  const next = [...list]
  const tmp = next[idx]
  next[idx] = next[swapIdx]
  next[swapIdx] = tmp
  const last = next.length - 1
  if (next.some((it, i) => i !== 0 && it.boundary === 'arrival')) return true
  if (next.some((it, i) => i !== last && it.boundary === 'closing')) return true
  return false
}

const selectedIndex = computed(() => dayItems.value.findIndex((i) => i.id === selectedItemId.value))

const canMoveSelectedUp = computed(
  () => selectedIndex.value > 0 && !breaksBoundary(dayItems.value, selectedIndex.value, selectedIndex.value - 1),
)
const canMoveSelectedDown = computed(
  () =>
    selectedIndex.value >= 0 &&
    selectedIndex.value < dayItems.value.length - 1 &&
    !breaksBoundary(dayItems.value, selectedIndex.value, selectedIndex.value + 1),
)

/**
 * 选中边界项时的说明文案，用它替换两个移动按钮。
 * 光把按钮灰掉不给原因，用户会以为功能坏了。
 */
const selectedBoundaryHint = computed(() => {
  const b = dayItems.value.find((i) => i.id === selectedItemId.value)?.boundary
  if (b === 'arrival') return '抵达固定在第一天'
  if (b === 'closing') return '返程固定在最后一天'
  return ''
})

/* ══════════════════════════════════════════════════════════
   行中模式：今天该干嘛 + 打卡
   心态和「行程」不同 —— 不是「我的计划长什么样」，
   而是「我接下来干嘛」。所以未完成的在前、已完成折叠，预算只看「还要花多少」。
   ══════════════════════════════════════════════════════════ */

/** 时间心跳：每 60s 走一格，保证「已过时」提示准确、跨零点能自己翻篇 */
const nowTick = ref(Date.now())
let tickTimer: number | undefined
onMounted(() => {
  tickTimer = window.setInterval(() => { nowTick.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
})

/** 本地日期 YYYY-MM-DD。不能用 toISOString —— 那是 UTC，东八区下午 4 点后日期会偏一天 */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const todayStr = computed(() => localDate(new Date(nowTick.value)))

/**
 * 是否处于「行中」。纯靠日期推导，不写库、不用用户点「开始旅行」：
 *   today < start_date            → 行前
 *   start_date ≤ today ≤ end_date → 行中
 *   today > end_date              → 已结束
 * 好处是改期后自动跟着变，也不会出现「状态说在旅行、日期却是下周」的脏数据。
 */
const isTraveling = computed(() => {
  const t = trip.value
  if (!t) return false
  return todayStr.value >= t.start_date && todayStr.value <= t.end_date
})

// 进入行中默认落在「今天」；行程被改到未来时把残留的「今天」Tab 收回去。
// 只在 isTraveling 真正翻转时触发，所以用户手动切到地图/行程不会被覆盖。
watch(
  isTraveling,
  (traveling) => {
    if (traveling) view.value = 'today'
    else if (view.value === 'today') view.value = 'plan'
  },
  { immediate: true },
)

/** 「今天」是行程里的第几天；取不到时退回当前选中的那天 */
const todayDayIndex = computed(() => {
  const t = trip.value
  if (!t) return activeDayIndex.value
  return t.days.find((d) => d.date === todayStr.value)?.day_index ?? activeDayIndex.value
})

const todayDay = computed(
  () => trip.value?.days.find((d) => d.day_index === todayDayIndex.value) ?? null,
)
const todayDateText = computed(() => (todayDay.value ? formatDateCn(todayDay.value.date) : ''))
const todayWeather = computed(() => (todayDay.value ? weather.value[todayDay.value.date] : undefined))
/** 当天天气提醒（与「行程」视图同一份规则：只有雨雪雾/极端温度才出现） */
const todayWeatherAlert = computed(() => weatherAlertText(todayWeather.value))

const todayItems = computed<TripItem[]>(() =>
  [...(todayDay.value?.items ?? [])].sort((a, b) => a.sort_order - b.sort_order),
)
const todayPending = computed(() => todayItems.value.filter((i) => !i.done_at))
const todayDone = computed(() => todayItems.value.filter((i) => i.done_at))
/** 下一站 = 第一个还没打卡的项 */
const nextItem = computed(() => todayPending.value[0] ?? null)
/** 下一站之后的待办 */
const todayRest = computed(() => todayPending.value.slice(1))

const todayProgress = computed(() =>
  todayItems.value.length ? Math.round((todayDone.value.length / todayItems.value.length) * 100) : 0,
)
/** 今天还要花多少 = 未打卡项人均价之和 × 计费人数（行中只关心「还要花多少」，不是总额） */
const todayLeftBudget = computed(() =>
  formatMoney(todayPending.value.reduce((s, i) => s + (i.price_ref ?? 0), 0) * billableWeight.value),
)

/** 整条行程已打卡的项数。AI 重排会物理删掉这些记录，重排前拿它做确认 */
const checkedCount = computed(() =>
  (trip.value?.days ?? []).reduce((n, d) => n + d.items.filter((i) => i.done_at).length, 0),
)

/** 已完成项的展开态。默认折叠：走一天后已完成会淹掉「下一站」 */
const doneExpanded = ref(false)

/** 该项的出发时间是否已经过了（只对「今天」有意义，提示别赶不上） */
function isOverdue(item: TripItem): boolean {
  const day = todayDay.value
  if (!item.start_time || !day) return false
  if (day.date !== todayStr.value) return false // 不是今天就不谈过不过时
  const [h, m] = item.start_time.split(':').map(Number)
  const at = new Date(nowTick.value)
  at.setHours(h || 0, m || 0, 0, 0)
  return at.getTime() < nowTick.value
}

/** 打卡时间 → HH:mm */
function checkTimeText(item: TripItem): string {
  if (!item.done_at) return ''
  const d = new Date(item.done_at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 打卡 / 撤销打卡。
 * 【乐观更新】：先改本地立刻出效果，请求在后台飞，失败再回滚 ——
 * 走路时点一下还要等 300ms 网络很难受。后端幂等，重发安全。
 */
async function onCheckItem(item: TripItem) {
  const nextDone = !item.done_at
  const prev = item.done_at
  item.done_at = nextDone ? new Date().toISOString() : null
  try {
    const res = await checkTripItem(tripId.value, item.id, nextDone)
    item.done_at = res.done_at // 以后端时间为准
  } catch {
    item.done_at = prev // 回滚
    showToast(nextDone ? '打卡失败，请重试' : '撤销失败，请重试')
  }
}

/* ── 相邻项的交通衔接（后端缓存优先，首次由 AI 生成；失败静默不显示） ────── */
const hops = ref<TripHop[]>([])

/** 交通方式中文名 */
const HOP_LABELS: Record<HopMode, string> = {
  walk: '步行',
  bus: '公交',
  metro: '地铁',
  taxi: '打车',
  bike: '骑行',
  coach: '城际巴士',
  unknown: '前往',
}

/** 'HH:MM' → 当天分钟数 */
function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** 展示就绪的一段交通 */
interface HopView {
  /** 原始方式（找图标用；unknown →「前往」箭头） */
  mode: HopMode
  /** 这段衔接的起点行程项 id（打开方式切换面板用） */
  from_item_id: string
  label: string
  meta: string
  /** 人均交通费估算（元）；null 时不渲染金额段（模板负责把 ¥ 金额染成 --c-money 红） */
  cost: number | null
  tip: string
  /** 详细分步走法（坐几号线/换乘/哪站下/哪个口）；空则退回单句 tip */
  steps: HopStep[]
  /** 收尾段（最后一站 → 返程）的目标：不是景点而是当地车站/机场，null 则不渲染 */
  dest: string | null
  /** 上一项占用 + 在途时间 > 两站时间差时为 true（衔接偏紧） */
  tight: boolean
}

/** 只有算出来的段（mode 非空）才进表；mode 为 null 说明这段没结果，不展示 */
const hopMap = computed(() => {
  const m = new Map<string, TripHop>()
  for (const h of hops.value) if (h.mode) m.set(h.from_item_id, h)
  return m
})

/** 时间轴渲染模型：每项与它到下一站的交通预先合并好，模板无需非空断言 */
const timeline = computed(() =>
  dayItems.value.map((item, index) => {
    const next = dayItems.value[index + 1]
    const raw = hopMap.value.get(item.id)
    let hop: HopView | null = null
    // 必须确认这段衔接的终点就是当前顺序的下一项。移动/删项后内存里可能还留着
    // 旧段（保留到新响应到达），不校验就会把「去旧下一站」的方式挂在新的下一站上。
    if (raw?.mode && next && raw.to_item_id === next.id) {
      const spare =
        next ? toMinutes(next.start_time) - toMinutes(item.start_time) - (item.duration_min ?? 0) : 0
      hop = {
        mode: raw.mode,
        from_item_id: raw.from_item_id,
        label: HOP_LABELS[raw.mode] ?? '前往',
        meta: raw.duration_min ? `${raw.duration_min} 分钟` : '—',
        cost: raw.cost_ref ? raw.cost_ref : null,
        tip: raw.tip,
        steps: Array.isArray(raw.steps) ? raw.steps : [],
        // 返程项本身没有地名（AI 只知道它是「返程」），后端按「当地车站/机场」估的，
        // 这里把目标显式写出来，否则用户只看到「打车 35 分钟」不知道去哪
        dest: raw.kind === 'return' ? '车站 / 机场' : null,
        tight: !!next && !!raw.duration_min && spare > 0 && spare < raw.duration_min,
      }
    }
    return { item, index, hop }
  }),
)

/* ── 交通方式切换（点击衔接条弹面板，本地切换零延迟，不发请求） ────────── */
const hopPickerOpen = ref(false)
const hopPickerId = ref('')
const hopPickerTitle = ref('')

interface HopOption {
  mode: HopMode
  duration_min: number | null
  cost_ref: number | null
  /** 详细分步走法（选中后顶替衔接条的步骤列表） */
  steps: HopStep[]
  /** 一句摘要（面板第二行）：取第一步走法，没有则取 tip */
  summary: string
  tip: string
  label: string
  meta: string
  cost: number | null
  active: boolean
}
const hopPickerList = ref<HopOption[]>([])

/** 打开方式切换面板：主推 + AI 给的备选，按顺序列出 */
function openHopPicker(fromItemId: string) {
  const h = hops.value.find((x) => x.from_item_id === fromItemId)
  if (!h?.mode) return
  const options: Array<{ mode: HopMode; duration_min: number | null; cost_ref: number | null; tip?: string; steps?: HopStep[] }> = [
    { mode: h.mode, duration_min: h.duration_min, cost_ref: h.cost_ref, tip: h.tip, steps: h.steps ?? [] },
    ...(Array.isArray(h.alts) ? h.alts : []),
  ]
  // 同 mode 只留第一项（AI 偶尔把主选重复写进 alts）
  const seen = new Set<string>()
  const list: HopOption[] = []
  for (const o of options) {
    if (!o?.mode || seen.has(o.mode)) continue
    seen.add(o.mode)
    const steps = Array.isArray(o.steps) ? o.steps : []
    list.push({
      mode: o.mode,
      duration_min: o.duration_min,
      cost_ref: o.cost_ref,
      steps,
      summary: steps[0]?.text ?? o.tip ?? '',
      tip: o.tip ?? '',
      label: HOP_LABELS[o.mode] ?? '前往',
      meta: o.duration_min ? `${o.duration_min} 分钟` : '—',
      cost: o.cost_ref || null,
      active: o.mode === h.mode,
    })
  }
  hopPickerId.value = fromItemId
  hopPickerTitle.value = `${h.from_title} → ${h.to_title}`
  hopPickerList.value = list
  hopPickerOpen.value = true
}

/** 选中一个方式：本地覆盖该段（原主选降级进备选），零延迟生效 */
function onPickHop(opt: HopOption) {
  const h = hops.value.find((x) => x.from_item_id === hopPickerId.value)
  if (!h) return
  if (opt.mode !== h.mode) {
    const prev = {
      mode: h.mode as HopMode,
      duration_min: h.duration_min,
      cost_ref: h.cost_ref,
      steps: h.steps ?? [],
    }
    const alts = (h.alts ?? []).filter((a) => a.mode !== opt.mode)
    if (prev.mode) alts.unshift(prev)
    h.mode = opt.mode
    h.duration_min = opt.duration_min
    h.cost_ref = opt.cost_ref
    // 分步走法跟着换：衔接条的步骤列表显示选中方式的「几号线/哪站下/哪个口」
    h.steps = opt.steps
    h.tip = opt.tip
    h.alts = alts
    // hops 元素是普通对象，直接改字段不触发响应式；浅拷贝数组让 timeline 重算
    hops.value = [...hops.value]
  }
  hopPickerOpen.value = false
}

/** 时间轴圆点三态：已过时刻 past，第一个未到的 now，其余 next */
function dotState(i: number): 'past' | 'now' | 'next' {
  const now = new Date()
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  let firstUpcoming = -1
  for (let k = 0; k < dayItems.value.length; k++) {
    if (dayItems.value[k].start_time > hhmm) {
      firstUpcoming = k
      break
    }
  }
  const isPast = firstUpcoming === -1 ? true : i < firstUpcoming
  if (isPast) return 'past'
  return i === firstUpcoming ? 'now' : 'next'
}

const TYPE_LABEL: Record<TripItem['type'], string> = {
  sight: '观光',
  hotel: '酒店',
  meal: '餐饮',
  transport: '交通',
  note: '备注',
}

/** 卡片副行：类型 · 建议时长 · 补充说明（纯文本 · 连接渲染，见模板 tl__meta）。
 *  subtitle 自身可能带 " · " 且常与 type 重复（"餐饮 · 已预订"），先拆散再去重 */
function tagList(it: TripItem): string[] {
  const parts: string[] = [TYPE_LABEL[it.type]]
  if (it.duration_min) parts.push(`建议${it.duration_min}分钟`)
  if (it.subtitle) parts.push(...it.subtitle.split(' · '))
  return [...new Set(parts)]
}

/* ── 汇总 ─────────────────────────── */
function onBack() {
  router.push('/trip')
}

/* ── 勾选 / 删除 / 移动 ─────────────────── */
/** 切换选中某个行程项 */
function onToggleSelect(it: TripItem) {
  selectedItemId.value = selectedItemId.value === it.id ? null : it.id
}

/** 删除选中的行程项 */
async function onDeleteItem() {
  const id = selectedItemId.value
  if (!id || !trip.value) return
  const t = trip.value
  try {
    const res = await deleteTripItem(t.id, id)
    // 本地移除
    for (const day of t.days) {
      day.items = day.items.filter((it) => it.id !== id)
    }
    // 总预算 = Σ人均价 × 计费人数，是随行程项变化的派生值（后端冗余列）。
    // 删项后它不会自己变，必须同步：优先用接口回带的重算值（后端权威口径），
    // 旧版后端不返回该字段时按同一口径本地兜底，避免显示成 0。
    const personTotal = t.days
      .flatMap((d) => d.items)
      .reduce((s, it) => s + (it.price_ref ?? 0), 0)
    t.budget_total = res.budget_total ?? Math.round(personTotal * billableWeight.value)
    selectedItemId.value = null
    // 相邻关系变了，缓存的交通衔接对不上，强制重拉（后端同步已清掉涉及该项的 hop）
    void loadHops(true)
    showToast('已删除')
  } catch {
    showToast('删除失败')
  }
}

/** 上移/下移选中的行程项 */
async function onMoveItem(dir: 'up' | 'down') {
  const id = selectedItemId.value
  if (!id || !trip.value) return
  const day = trip.value.days.find((d) => d.items.some((it) => it.id === id))
  if (!day) return

  // 先在本地判边界：已到顶/底就直接提示返回。
  // 原来判断写在 await 之后，等于每次移动都先发一个必然 no-op 的请求给后端。
  const sorted = [...day.items].sort((a, b) => a.sort_order - b.sort_order)
  const idx = sorted.findIndex((it) => it.id === id)
  const swapIdx = dir === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= sorted.length) {
    showToast(dir === 'up' ? '已在最前' : '已在最后')
    return
  }

  try {
    await moveTripItem(trip.value.id, id, dir)
    // 只交换顺序；时间不跟着卡片走（与后台逻辑一致）
    const a = sorted[idx]
    const b = sorted[swapIdx]
    const so = a.sort_order
    a.sort_order = b.sort_order
    b.sort_order = so

    // 左侧时间是「时间槽」，按新顺序重新分配，保证时间列递增且不随移动变化
    const ordered = [...day.items].sort((x, y) => x.sort_order - y.sort_order)
    const times = ordered.map((it) => it.start_time).sort()
    ordered.forEach((it, i) => {
      if (times[i] !== undefined) it.start_time = times[i]
    })
    selectedItemId.value = null
    // 顺序变了，相邻配对也变了：强制重拉，旧数据留在屏幕上直到新响应到达（不闪空）
    void loadHops(true)
  } catch {
    // 不在这里再 toast：request.ts 的响应拦截器已经弹过后端的原始 message
    // （如「抵达固定在当天第一位，不能移动」）。再补一句「移动失败」会把它盖掉，
    // 用户只看到笼统的失败原因，不知道到底为什么不能移。
  }
}

/* ── 三点菜单：修改日期 / 修改人数 ───────────────── */
const moreOpen = ref(false)
const calOpen = ref(false)
const peopleOpen = ref(false)
const saving = ref(false)
/** 单天补排请求在飞（空天上的按钮态） */
const dayGenerating = ref(false)

/* ── AI 调整行程（agent 会话） ─────────────────
   与旧实现的区别：不再由前端决定「调哪个后端接口」，而是把要求发给 agent，
   AI 自己决定是查天气还是重排行程（见后端 src/agent/loop.js）。 */
const optOpen = ref(false)
const optText = ref('')
const optimizing = ref(false)
/** 已执行的工具调用，用来把 AI 的「过程」显示给用户 */
const agentSteps = ref<AgentStep[]>([])
/** 最终答复，流式累积 */
const agentReply = ref('')
/**
 * 本次会话的轮次（跨轮记忆）。只存纯文本 —— 工具效果已落库、
 * 行程现状每轮都重新注入 system prompt，不需要回放工具调用。
 * 有了它，AI 问「要不要帮你把27号调成室内」后，用户回一个「好」才接得住。
 */
const agentHistory = ref<AgentTurn[]>([])
/** 历史只留最近 N 轮，别让上下文无限长（与后端 MAX_TURNS 对齐） */
const AGENT_HISTORY_LIMIT = 10
let agentController: AbortController | null = null

function onOptimize() {
  const instruction = optText.value.trim()
  if (!instruction || !trip.value || optimizing.value) return

  // AI 重排走 writeDayPlan → clearDayItems → DELETE trip_items，
  // 已打卡的记录会被【物理删掉】。有进度时先确认，不能静默清空用户走过的路。
  if (checkedCount.value) {
    showConfirmDialog({
      title: '确认调整行程？',
      message: `这次调整会重排整条行程，已打卡的 ${checkedCount.value} 项记录会被清空。`,
      confirmButtonText: '继续调整',
      cancelButtonText: '再想想',
    })
      .then(() => startOptimize(instruction))
      .catch(() => {}) // 用户取消
    return
  }
  void startOptimize(instruction)
}

/** 真正发起 agent 会话（确认通过后） */
function startOptimize(instruction: string) {
  optimizing.value = true
  agentSteps.value = []
  agentReply.value = ''

  agentController = streamTripAgent(
    tripId.value,
    instruction,
    {
      onStep: (s) => agentSteps.value.push(s),
      onToken: (d) => { agentReply.value += d },
      onDone: (e) => {
        optimizing.value = false
        agentController = null
        // 记下这一轮，下一句追问才有上下文。答复为空（报错/超额度）时也要留用户的提问，
        // 否则 AI 下一轮不知道自己刚被问过什么
        agentHistory.value = [
          ...agentHistory.value,
          { role: 'user', text: instruction } as AgentTurn,
          ...(agentReply.value.trim() ? [{ role: 'ai' as const, text: agentReply.value }] : []),
        ].slice(-AGENT_HISTORY_LIMIT)
        // 有写操作落库（AI 重排了行程）才重取详情，纯问天气不必白跑一趟
        if (e.mutations.length) void reloadTripAfterAgent()
        if (e.stop_reason !== 'done') showToast('本次没能完整处理，可以换个说法再试')
      },
      onError: () => {
        optimizing.value = false
        agentController = null
        showToast('AI 服务暂时不可用，请稍后重试')
      },
      onAbort: () => {
        optimizing.value = false
        agentController = null
      },
    },
    agentHistory.value,
  )
}

/** 底部取消/停止/关闭：处理中就是中断，否则收面板 */
function onOptCancel() {
  if (optimizing.value) return agentController?.abort()
  optOpen.value = false
  agentSteps.value = []
  agentReply.value = ''
}

/**
 * agent 改完行程后重新拉【整套】页面数据。
 *
 * 不能只更新 trip.value 就完事：整条重排会删掉一批旧行程项，
 * 而交通衔接是按 (行程|天) 缓存的（见 loadHops 的 hopKey 闸门）——
 * 同一天重排后 key 不变，loadHops 会直接提前返回，衔接条就留着重排前的老数据。
 * 所以先清掉 hopKey 让衔接强制重算，再走 load()：和「进入这个页面」完全同一条路径，
 * 行程 / 天气 / 衔接 / 预算一次全刷，不另写一套逻辑免得日后各处漂移。
 */
async function reloadTripAfterAgent() {
  selectedItemId.value = null // 选中的项可能已在这轮重排里被删掉
  noSpot.value = []           // 重排后标题全变了，旧的「匹配不到」黑名单会让新项按钮被误隐藏
  hopKey = ''                 // 失效衔接缓存，逼 loadHops 重新计算
  await load()
}

// 关面板就中断在途请求，别让模型在后台继续烧额度
watch(optOpen, (open) => {
  if (!open && optimizing.value) agentController?.abort()
})

// 换行程要丢掉旧对话：详情页互跳时组件复用不重建，
// 历史留着会把上一条行程的话题带进新行程，AI 会答非所问
watch(tripId, () => {
  agentHistory.value = []
})

const moreActions: { name: string; key: 'date' | 'people' }[] = [
  { name: '修改日期', key: 'date' },
  { name: '修改人数', key: 'people' },
]

/* 日历只能选今天及以后（今天 0 点起算，之前的日期置灰不可选） */
const calMinDate = (() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
})()
const calMaxDate = new Date(new Date().getFullYear() + 3, 11, 31)
const calDefault = ref<[Date, Date]>([new Date(), new Date()])

/** 行程原日期若早于今天，回落到今天（不能把默认值设到禁用区间） */
function clampToMin(iso: string): Date {
  const d = new Date(`${iso}T12:00:00`)
  return d < calMinDate ? new Date(calMinDate) : d
}

/* 人数：成人 / 儿童计数 */
const adults = ref(1)
const childrenCount = ref(0)

function onMore() {
  moreOpen.value = true
}

function onMoreSelect(action: { name: string; key?: 'date' | 'people' }) {
  const t = trip.value
  if (!t) return
  moreOpen.value = false
  if (action.key === 'date') {
    calDefault.value = [clampToMin(t.start_date), clampToMin(t.end_date)]
    calOpen.value = true
  } else {
    adults.value = t.traveler.adults
    childrenCount.value = t.traveler.children?.length ?? 0
    peopleOpen.value = true
  }
}

/** Date → YYYY-MM-DD（按本地年月日取，避开 toISOString 的时区偏移） */
function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 两个 YYYY-MM-DD 相差的整天数（UTC 正午做锚点，规避时区偏移） */
function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)
}

async function onCalConfirm(dates: Date[]) {
  const t = trip.value
  if (!t) return
  const [s, e] = dates
  const start = toISODate(s)
  const end = toISODate(e)
  calOpen.value = false

  // 缩短行程会连带删掉后面几天及其安排（后端 CASCADE），先让用户确认
  const nextCount = diffDays(start, end) + 1
  if (nextCount < t.day_count) {
    try {
      await showConfirmDialog({
        title: '缩短行程',
        message: `新日期只剩 ${nextCount} 天，最后 ${t.day_count - nextCount} 天及其中的安排会被删除。`,
        confirmButtonText: '继续',
      })
    } catch {
      return
    }
  }
  // 变长时后端会为新多出来的天调 AI 补排行程（几秒），期间要给出等待反馈，
  // 否则日历关掉后页面像卡住了。变长是非破坏操作，不用二次确认。
  const grew = nextCount - t.day_count
  await saveTripPatch({ start_date: start, end_date: end }, '日期已更新', {
    busyText: grew > 0 ? `正在补排新增的 ${grew} 天行程…` : undefined,
  })
}

async function onSavePeople() {
  const t = trip.value
  if (!t) return
  // 儿童年龄沿用原有值，新增的给默认 8 岁（本页暂不做逐人年龄编辑）
  const prev = t.traveler.children ?? []
  const children = Array.from({ length: childrenCount.value }, (_, i) => ({ age: prev[i]?.age ?? 8 }))
  const done = await saveTripPatch({ traveler: { adults: adults.value, children } }, '人数已更新')
  if (done) peopleOpen.value = false
}

/** 统一提交：带当前 revision 走乐观锁，成功后用返回值整体刷新。
 *  busyText：日期变长时后端要调 AI 补排新天（几秒），期间显示不可点断的 loading。 */
async function saveTripPatch(
  params: Parameters<typeof updateTrip>[1],
  tip: string,
  opts: { busyText?: string } = {},
): Promise<boolean> {
  const t = trip.value
  if (!t || saving.value) return false
  saving.value = true
  const busy = opts.busyText
    ? showLoadingToast({ message: opts.busyText, forbidClick: true, duration: 0 })
    : null
  try {
    const next = await updateTrip(t.id, params, t.revision)
    busy?.close()
    trip.value = next
    // 缩短行程后当前选中的天可能已不存在，回落到最后一天
    activeDayIndex.value = Math.min(activeDayIndex.value, next.day_count)

    const datesChanged = params.start_date !== undefined || params.end_date !== undefined
    // 日期变了要按新日期重取天气
    if (datesChanged) void loadWeather(next.id)
    // 天数变了 → 相邻项的配对也变了，交通衔接要重拉（补排失败时空天没有段，重拉也无妨）
    if (datesChanged) void loadHops(true)

    showToast(patchTip(next, tip))
    return true
  } catch {
    busy?.close()
    return false
  } finally {
    saving.value = false
  }
}

/** 保存后的提示文案：优先说清楚「新增的天补排得怎么样、旧的返程有没有被摘掉」，
 *  而不是干巴巴的「日期已更新」 */
function patchTip(next: TripDetail, fallback: string): string {
  const bits: string[] = []
  const fmt = (list: number[]) => list.map((i) => `D${i}`).join('、')

  const filled = next.appended_days ?? []
  if (filled.length) bits.push(`已补排 ${fmt(filled)}`)

  // 天数一变，旧最后一天上的「返程」就不再成立了（不再是边界），后端会摘掉它。
  // 必须说清楚，否则用户会以为自己的安排凭空少了一项。
  const stale = next.stale_closings ?? []
  const staleDays = Array.from(new Set(stale.map((d) => d.day_index)))
  if (staleDays.length && stale[0]) {
    const kind = /返程|回程|送机|送站|离程|散团/.test(stale[0].title) ? '返程' : '抵达安排'
    bits.push(`${fmt(staleDays)} 的${kind}已移除`)
  }

  const refilled = next.refilled_days ?? []
  if (refilled.length) bits.push(`已补齐 ${fmt(refilled)}`)

  if (next.ai_error === 'AI 未配置') {
    return bits.length ? `日期已更新，${bits.join('；')}` : '日期已更新（AI 未配置，新增的天还没排）'
  }
  const head = bits.length ? `日期已更新，${bits.join('；')}` : fallback
  return next.ai_error ? `${head}；有几天没排上，可在那一天点「让 AI 补排」` : head
}

/* ══════════════════════════════════════════════════════════════
   景点决策卡：「行程里为什么要有这一项」的答案
   ──────────────────────────────────────────────────────────────
   行程项 title 是 AI 生成的自由文本（如「故宫博物院（¥60）」），而决策 brief 存在
   city_spots 上，两边靠【名字互包含】对上。规则保守：要求 2 字以上且双向包含之一，
   取名字最长的命中项（避免「故宫」被误配到「故宫角楼咖啡」这类短名）。
   匹配不上的（午餐、某条街）永久记进 noSpot，按钮消失 —— 不留点不开的死入口。 */
const spotOpen = ref(false)
const spotLoading = ref(false)
const spotDetail = ref<SpotDetail | null>(null)
/** 正在查的行程项（只有这一项显示"正在查…"） */
const spotLoadingId = ref<string | null>(null)
/** 已经确认匹配不到景点的行程项标题 */
const noSpot = ref<string[]>([])
const spotBrief = computed(() => spotDetail.value?.brief ?? null)

/** 名字归一：去括号内容、去价格数字与分隔符，只留可比较的主体 */
function normalizeName(t: string): string {
  return String(t)
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/[¥￥\s·、,，\d]/g, '')
    .trim()
}

let spotIndexCache: CitySpot[] | null = null
async function ensureSpotIndex(): Promise<CitySpot[]> {
  if (spotIndexCache) return spotIndexCache
  try {
    spotIndexCache = await getCitySpots()
  } catch {
    spotIndexCache = []
  }
  return spotIndexCache
}

const idByTitle = new Map<string, string | null>()
async function resolveSpotId(title: string): Promise<string | null> {
  if (idByTitle.has(title)) return idByTitle.get(title) ?? null
  const list = await ensureSpotIndex()
  const n = normalizeName(title)
  let best: CitySpot | null = null
  if (n.length >= 2) {
    for (const s of list) {
      const sn = normalizeName(s.name)
      if (sn.length < 2) continue
      if (n.includes(sn) || sn.includes(n)) {
        if (!best || sn.length > normalizeName(best.name).length) best = s
      }
    }
  }
  const id = best?.id ?? null
  idByTitle.set(title, id)
  return id
}

const detailCache = new Map<string, SpotDetail | null>()
async function loadSpot(id: string) {
  spotOpen.value = true
  spotLoading.value = true
  spotDetail.value = null
  try {
    if (detailCache.has(id)) spotDetail.value = detailCache.get(id) ?? null
    else {
      const d = await getSpotDetail(id)
      detailCache.set(id, d)
      spotDetail.value = d
    }
  } catch {
    spotDetail.value = null
  } finally {
    spotLoading.value = false
  }
}

async function openSpot(item: TripItem) {
  if (spotLoadingId.value) return
  spotLoadingId.value = item.id
  try {
    // 两级查找：① 景点库精确匹配（有替代方案等完整数据）；② 库外名字走现生成 + 后端缓存。
    // 两级都失败才把标题记进 noSpot 永久隐藏按钮 —— 不留点不开的死入口。
    const id = await resolveSpotId(item.title)
    if (id) {
      await loadSpot(id)
      return
    }
    await loadGenerated(item.title)
  } finally {
    spotLoadingId.value = null
  }
}

/** 库外名字：POST /v1/spot-brief 现生成（后端按归一化名缓存，同名全站只花一次生成） */
async function loadGenerated(rawTitle: string) {
  spotOpen.value = true
  spotLoading.value = true
  spotDetail.value = null
  try {
    const r = await requestSpotBrief(rawTitle, trip.value?.title ?? '')
    if (r.not_place) {
      noSpot.value = [...noSpot.value, rawTitle]
      spotOpen.value = false
      showToast('这一项不是景点，没有决策卡')
      return
    }
    spotDetail.value = {
      id: '',
      city_id: '',
      city_name: r.city_name || '—',
      name: r.name || rawTitle,
      description: null,
      price: null,
      image: null,
      rating: null,
      tags: [],
      promo: null,
      brief: r.brief,
      brief_source: r.brief_source,
      brief_updated_at: r.brief_updated_at,
      brief_confidence: r.brief_confidence,
      alts: r.alts ?? [],
    }
  } catch {
    // request.ts 已对业务错误弹过 toast；这里收掉抽屉避免停在空态
    spotOpen.value = false
  } finally {
    spotLoading.value = false
  }
}

/** 从替代方案点进去：直接看那一处的决策依据 */
function openAlt(id: string) {
  void loadSpot(id)
}

function stayText(min: number): string {
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/** 溯源行：说清内容来源、更新时间、模型自己的把握度 */
const spotSourceText = computed(() => {
  const d = spotDetail.value
  if (!d) return ''
  const date = d.brief_updated_at ? d.brief_updated_at.slice(0, 10) : '—'
  const conf = d.brief_confidence != null ? `${Math.round(d.brief_confidence * 100)}%` : '—'
  return `内容由 AI 整理 · 更新于 ${date} · 把握度 ${conf}，出行前请对关键信息做二次确认`
})

/** 单天补排（AI 调用）。接口会先清掉该天现有项再重排，所以一次只放一个在飞 */
async function onGenerateDay() {
  const t = trip.value
  if (!t || dayGenerating.value) return
  const dayIndex = activeDayIndex.value
  dayGenerating.value = true
  const busy = showLoadingToast({ message: 'AI 正在排这一天的行程…', forbidClick: true, duration: 0 })
  let tip = '这一天没排上，请稍后重试'
  try {
    const next = await generateTripDay(t.id, dayIndex)
    trip.value = next
    if (next.appended_days?.length) {
      tip = `D${dayIndex} 已排好`
      void loadHops(true) // 这一天的项变了，相邻项的交通衔接作废
    } else if (next.ai_error === 'AI 未配置') {
      tip = 'AI 未配置，暂时不能补排'
    }
  } catch {
    // request.ts 已经把接口错误提示过了，这里只补一句结果
  } finally {
    busy.close()
    dayGenerating.value = false
    showToast(tip)
  }
}
</script>

<style scoped>
.trip-page {
  /* 颜色与字体 token 统一在 src/styles/tokens.css（:root）
     注意：--c-money 已从线框遗留的 teal 统一为品牌深蓝 */
  /* 详情页不再有底部 tabbar（App.vue 只对 /trip 列表页显示 tabbar），
     这里只留安全区，供吸底操作栏与 FAB 定位 */
  --tabbar-h: env(safe-area-inset-bottom, 0px);

  min-height: 100vh;
  min-height: 100dvh;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-sans);
}

/* ---------- 顶栏标题 ---------- */
:deep(.van-nav-bar) { background: var(--c-card); }
:deep(.van-nav-bar::after) { border-color: var(--c-divider); }
:deep(.van-nav-bar .van-icon) { color: var(--c-text); }
.nav-title { text-align: center; }
.nav-title__main { display: block; font-size: 16px; font-weight: 700; color: var(--c-text); }
.nav-title__sub { font-size: 11.5px; color: var(--c-sub); display: inline-flex; gap: 4px; align-items: center; }
.nav-title__sub .dot { color: var(--c-divider); }
.nav-title__budget { color: var(--c-money); font-weight: 600; }

/* ---------- Tab 切换（两枚独立胶囊 · 选中深青实底） ---------- */
.seg {
  display: flex;
  gap: 8px;
  margin: 10px 20px 0;
}
.seg__btn {
  flex: 1;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 36px;
  font-size: 13.5px; font-weight: 600;
  color: var(--c-sub);
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  border-radius: var(--radius-pill);
  transition: all 0.18s;
}
.seg__btn :deep(.van-icon) { font-size: 15px; }
.seg__btn.is-active {
  background: var(--c-brand);
  color: #fff;
  border-color: var(--c-brand);
  box-shadow: 0 4px 12px rgba(14, 124, 134, 0.25);
}

/* ---------- 日期芯片 ---------- */
.days {
  display: flex;
  gap: 8px;
  padding: 14px 20px 4px;
  overflow-x: auto;
}
.days::-webkit-scrollbar { display: none; }
.day {
  flex-shrink: 0;
  min-width: 46px;
  height: 32px;
  padding: 0 14px;
  font-size: 13px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--c-sub);
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  border-radius: var(--radius-pill);
  transition: all 0.15s;
}
.day.is-active {
  background: var(--c-brand);
  color: #fff;
  border-color: var(--c-brand);
  box-shadow: 0 4px 12px rgba(14, 124, 134, 0.25);
}

/* ---------- 当日头部 ---------- */
.dayhead {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px 8px;
  font-size: 12.5px;
  color: var(--c-sub);
}
.dayhead__d { font-size: 15px; font-weight: 800; color: var(--c-text); }
.dayhead__date { color: var(--c-text); font-weight: 600; }
.dayhead__weather { display: inline-flex; align-items: center; gap: 3px; }
.dayhead__wicon { display: flex; color: var(--c-brand); }
.dayhead__wicon svg { width: 15px; height: 15px; }

/* ---------- 天气提醒（规则版，异常天气才渲染） ---------- */
.walert {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 20px 4px;
  padding: 9px 12px;
  background: var(--c-brand-soft);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-brand-deep);
}
.walert__ic { flex-shrink: 0; display: flex; color: var(--c-brand); }
.walert__ic :deep(svg) { width: 17px; height: 17px; }
.dayhead__budget { margin-left: auto; font-variant-numeric: tabular-nums; }

/* ══════════════════════════════════════════════════════════
   行中模式：今天
   完成 = 翻篇（灰化），下一站 = 品牌色高亮。这个对比是整屏的视觉主线，
   不额外引入新颜色 —— tokens 里没有专门的「成功绿」，
   而且「已完成」用灰比用绿更贴语义（事情过去了，不是成就）。
   ══════════════════════════════════════════════════════════ */
.today { padding: 0 20px; }

.today__head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 0 8px;
  font-size: 12.5px; color: var(--c-sub);
}
.today__d { font-size: 15px; font-weight: 800; color: var(--c-text); }
.today__date { color: var(--c-text); font-weight: 600; }
.today__weather { display: inline-flex; align-items: center; gap: 3px; }
.today__wicon { display: flex; color: var(--c-brand); }
.today__wicon :deep(svg) { width: 15px; height: 15px; }
/* 今天的出行日期/天气是核心信息，提醒条在这里要贴边对齐 .today 的内边距 */
.today .walert { margin: 0 0 10px; }

/* ---------- 进度 ---------- */
.prog {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 14px;
}
.prog__track {
  flex: 1; height: 5px;
  background: var(--c-divider);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.prog__fill {
  display: block; height: 100%;
  background: var(--c-brand);
  border-radius: var(--radius-pill);
  transition: width 0.25s ease;
}
.prog__text {
  font-size: 12px; font-weight: 600; color: var(--c-sub);
  font-variant-numeric: tabular-nums;
}

/* ---------- 下一站（整屏的主角） ---------- */
.next {
  padding: 14px 16px;
  margin-bottom: 14px;
  background: var(--c-card);
  border: 1px solid var(--c-brand-line);
  border-left: 3px solid var(--c-brand);
  border-radius: 12px;
}
.next__label {
  margin: 0 0 6px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
  color: var(--c-brand);
}
.next__title {
  margin: 0;
  font-size: 17px; font-weight: 700; line-height: 1.4;
  color: var(--c-text);
}
.next__meta {
  margin: 5px 0 0;
  font-size: 12.5px; color: var(--c-sub);
  font-variant-numeric: tabular-nums;
}
.next__btn {
  width: 100%; height: 44px;
  margin-top: 12px;
  font-size: 15px; font-weight: 700; color: #fff;
  background: var(--c-brand);
  border: none; border-radius: 10px;
  cursor: pointer;
}
.next__btn:active { opacity: 0.85; }

/* ---------- 待办列表 ---------- */
.tlist { display: flex; flex-direction: column; gap: 8px; }
.titem {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  background: var(--c-card);
  border: 1px solid var(--c-divider);
  border-radius: 12px;
}
.titem__body { flex: 1; min-width: 0; }
.titem__title {
  margin: 0;
  font-size: 14px; font-weight: 600; line-height: 1.45;
  color: var(--c-text);
}
.titem__meta {
  margin: 4px 0 0;
  font-size: 12px; color: var(--c-sub);
  font-variant-numeric: tabular-nums;
}
/* 次要打卡按钮走描边：整屏多个实心按钮会吵，实心留给「下一站」 */
.titem__check {
  flex-shrink: 0;
  height: 32px; padding: 0 14px;
  font-size: 13px; font-weight: 600;
  color: var(--c-brand);
  background: transparent;
  border: 1px solid var(--c-brand-line);
  border-radius: var(--radius-pill);
  cursor: pointer;
}
.titem__check:active { background: var(--c-brand-soft); }

/* 已打卡：整条灰化，视觉上「翻篇」 */
.titem--done { background: var(--c-bg); border-color: transparent; }
.titem--done .titem__title { color: var(--c-sub); font-weight: 500; }
.titem__check--undo {
  color: var(--c-sub);
  border-color: var(--c-divider);
}

/* 「已过时」：出发时间已过还没打卡，用强调色轻量提示，别做成报错 */
.late {
  display: inline-block;
  margin-left: 6px; padding: 1px 6px;
  font-size: 11px; font-weight: 600;
  color: var(--c-accent);
  background: var(--c-warn-soft);
  border-radius: 4px;
}

/* ---------- 已完成折叠区 ---------- */
.done { margin-top: 14px; }
.done__head {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 10px 2px;
  font-size: 12.5px; font-weight: 600; color: var(--c-sub);
  background: transparent; border: none;
  cursor: pointer;
}
.done .tlist { margin-top: 4px; }

.today__empty {
  padding: 28px 0;
  text-align: center;
  font-size: 13px; color: var(--c-sub);
}
.today__foot {
  margin: 16px 0 0;
  font-size: 13px; color: var(--c-sub);
  font-variant-numeric: tabular-nums;
}
.today__foot em { font-style: normal; font-weight: 700; color: var(--c-money); }
.dayhead__budget em { font-style: normal; font-weight: 700; color: var(--c-money); }

/* ---------- 时间轴（编号节点 = logo 那条路的展开） ---------- */
.timeline { padding: 8px 20px 0; }
.tl {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 14px;
}
.tl__rail {
  position: relative;
  width: 30px;
  align-self: stretch;
  display: flex; flex-direction: column; align-items: center;
  padding-top: 8px;
}
.tl__node {
  width: 22px; height: 22px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 11px; font-weight: 700;
  font-variant-numeric: tabular-nums;
  background: var(--c-brand);
  color: #fff;
  z-index: 1;
}
/* 三态保留「走到哪了」的信息：now 深青实底，past 浅青，next 白底描边 */
.tl__node.now { box-shadow: 0 0 0 3px var(--c-brand-soft); }
.tl__node.past { background: var(--c-brand-soft); color: var(--c-brand-deep); }
.tl__node.next { background: var(--c-card); color: var(--c-sub); border: 1.5px solid var(--c-divider); }
.tl__line {
  flex: 1;
  width: 2px;
  margin-top: 3px;
  background-image: linear-gradient(var(--c-brand-line) 55%, transparent 55%);
  background-size: 2px 7px;
  background-repeat: repeat-y;
}
/* 空当日仍用无编号小圆点 */
.tl__dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  border: 2px solid var(--c-brand);
  background: var(--c-card);
  z-index: 1;
}

/* ---------- 相邻项之间的交通衔接（虚线「路」+ 行内信息） ---------- */
.tl--linked { margin-bottom: 2px; }
.hop {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  margin-bottom: 12px;
}
.hop__rail {
  position: relative;
  align-self: stretch;
}
/* 上下探出，接住两端的编号节点 */
.hop__dash {
  position: absolute;
  top: -12px; bottom: -12px;
  left: 50%;
  border-left: 2px dashed var(--c-brand-line);
}
.hop__main { padding: 3px 2px; box-sizing: border-box; }
.hop__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
/* 交通方式（图标 + 名称 + 下拉箭头）：可点，弹出切换面板 */
.hop__mode {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  font-weight: 700;
  color: var(--c-brand-deep);
  cursor: pointer;
}
.hop__mode:active { opacity: 0.7; }
.hop__mode :deep(.van-icon) { font-size: 10px; color: var(--c-brand-line); }
.hop__ic { display: inline-flex; }
.hop__ic :deep(svg) { width: 15px; height: 15px; }
.hop__dest { font-size: 12px; font-weight: 700; color: var(--c-brand-deep); }
.hop__meta { font-size: 12px; color: var(--c-sub); font-variant-numeric: tabular-nums; }
.hop__cost { font-style: normal; font-weight: 700; color: var(--c-money); }
.hop__warn { font-size: 11px; color: var(--c-accent); }
.hop__tip {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--c-muted);
}

/* 分步走法：动作图标沿细竖线串成导航式动线，比序号圆点更直观 */
.hop__steps {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.hop__step {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
/* 除最后一步外，图标下方接一条细短线（连接动线） */
.hop__step:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 9px;
  top: calc(50% + 8px);
  width: 1px;
  height: calc(100% - 2px);
  background: var(--c-brand-line);
}
.hop__step-ic {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  color: var(--c-brand-deep);
  z-index: 1;
}
.hop__step-ic :deep(svg) { width: 16px; height: 16px; }
.hop__step-text {
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--c-muted);
  overflow-wrap: anywhere;
}

/* ---------- 交通方式切换面板（van-popup 底部弹层） ---------- */
.hop-picker {
  padding: 16px 18px calc(16px + env(safe-area-inset-bottom));
  box-sizing: border-box;
}
.hop-picker__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-sub);
}
.hop-picker__list { list-style: none; margin: 0; padding: 0; }
.hop-picker__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 4px;
  border-bottom: 1px solid var(--c-divider);
  cursor: pointer;
}
.hop-picker__item:last-child { border-bottom: 0; }
.hop-picker__item:active { opacity: 0.7; }
.hop-picker__item.is-active .hop-picker__name { color: var(--c-brand); }
.hop-picker__ic {
  flex: none;
  display: inline-flex;
  color: var(--c-brand-deep);
}
.hop-picker__ic :deep(svg) { width: 20px; height: 20px; }
.hop-picker__body { flex: 1; min-width: 0; }
.hop-picker__name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-text);
}
.hop-picker__meta {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--c-sub);
  font-variant-numeric: tabular-nums;
}
/* 每个方式「怎么走」的说明：弱化小字，不抢方式名 */
.hop-picker__tip {
  margin: 3px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--c-muted);
}
.hop-picker__check { font-size: 16px; color: var(--c-brand); }

/* ---------- 行程卡片（紧凑型：时间 / 标题 / 标签 chips / 右侧价格） ---------- */
.tl__card {
  display: flex;
  gap: 10px;
  align-items: center;
  background: var(--c-card);
  border: 1.5px solid transparent;
  border-radius: var(--radius-card);
  padding: 12px 14px;
  box-shadow: var(--shadow-card);
  position: relative;
  cursor: pointer;
}
.tl__body { flex: 1; min-width: 0; }
.tl__time {
  font-size: 11.5px; font-weight: 600;
  color: var(--c-muted);
  font-variant-numeric: tabular-nums;
}
.tl__title { font-size: 15px; font-weight: 700; color: var(--c-text); margin-top: 2px; }
/* 元信息用纯文本 · 连接（chip 是筛选语言，不是展示语言） */
.tl__meta { margin-top: 5px; font-size: 12px; color: var(--c-sub); }
/* 决策卡入口：不做成 chip/图标，做成一句会说话的链接 —— 用户点它是带着问题的 */
.tl__why {
  margin: 7px 0 0;
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-brand);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.tl__why:active { opacity: 0.6; }
.tl__side { flex-shrink: 0; text-align: right; }
.tl__price {
  font-size: 16px; font-weight: 800;
  color: var(--c-money);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.tl__price em { font-style: normal; font-size: 11px; font-weight: 700; margin-right: 1px; }
.tl__card.is-selected {
  border-color: var(--c-brand);
  box-shadow: var(--shadow-card), 0 0 0 3px var(--c-brand-soft);
}
.tl__lock { position: absolute; top: 8px; right: 8px; color: var(--c-brand); font-size: 16px !important; }

/* ---------- 空当日兜底 ---------- */
.tl--empty { min-height: 56px; }
.tl__hint { font-size: 11.5px; color: var(--c-sub); margin-top: 4px; }

/* 空天上的「让 AI 补排这一天」：日期变长后自动补排失败时的重试入口 */
.tl__gen {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  padding: 8px 16px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-brand-deep);
  background: var(--c-brand-soft);
  border: none;
  border-radius: 16px;
  transition: transform 0.15s, opacity 0.15s;
}
.tl__gen:disabled { opacity: 0.6; }
.tl__gen:not(:disabled):active { transform: scale(0.97); }

/* ---------- AI 免责提示（纯文字居中：黄底卡 + 图标已下线，只剩这一句） ---------- */
.ai-note {
  margin: 0 20px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-sub);
  text-align: center;
}

/* ---------- 错误态（id 无效 / 加载失败） ---------- */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 96px 32px 0;
  text-align: center;
}
.error-state__ic {
  width: 56px; height: 56px;
  border-radius: 50%;
  background: var(--c-brand-soft);
  color: var(--c-brand);
  display: grid; place-items: center;
  margin-bottom: 6px;
}
.error-state__ic :deep(.van-icon) { font-size: 28px; }
.error-state__title { font-size: 16px; font-weight: 700; color: var(--c-text); }
.error-state__sub { font-size: 12.5px; color: var(--c-sub); }
.error-state__btn {
  margin-top: 16px;
  padding: 10px 32px;
  font-size: 14px; font-weight: 700;
  color: #fff;
  background: var(--c-brand);
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(14, 124, 134, 0.28);
}
.error-state__btn:active { transform: scale(0.97); }
.error-state__link {
  margin-top: 4px;
  padding: 8px;
  font-size: 13px;
  color: var(--c-sub);
}

/* ---------- FAB ---------- */
/* ---------- 底部：预算总结（不含预订入口） ---------- */
.foot-space { height: calc(var(--tabbar-h) + 62px); }
.actionbar {
  position: fixed;
  left: 0; right: 0;
  bottom: var(--tabbar-h);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  background: var(--c-card);
  border-top: 1px solid var(--c-divider);
  box-shadow: 0 -2px 12px rgba(10, 26, 43, 0.05);
  z-index: 9;
}
.actionbar__label { font-size: 13px; color: var(--c-sub); }
.actionbar__amount {
  font-size: 24px; font-weight: 800; color: var(--c-money);
  line-height: 1.1; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.actionbar__ai {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: auto;
  padding: 8px 14px;
  font-size: 13px; font-weight: 600; color: #fff;
  background: var(--c-brand);
  border: none; border-radius: 999px;
  cursor: pointer;
}
.actionbar__ai:disabled { opacity: 0.6; cursor: default; }

/* ---------- AI 调整整条行程 ---------- */
.opt {
  padding: 20px 20px calc(20px + env(safe-area-inset-bottom));
}
.opt__title { font-size: 16px; font-weight: 700; color: var(--c-text); margin: 0; }
.opt__hint { font-size: 12px; color: var(--c-sub); margin: 6px 0 12px; }
.opt__input {
  width: 100%; box-sizing: border-box;
  padding: 12px 14px;
  font-size: 14px; line-height: 1.6; color: var(--c-text);
  background: var(--c-bg); border: 1px solid var(--c-divider); border-radius: 10px;
  resize: none; outline: none;
}
.opt__input:focus { border-color: var(--c-brand); }
.opt__row { display: flex; gap: 12px; margin-top: 14px; }
.opt__cancel, .opt__go {
  flex: 1; padding: 11px 0; font-size: 14px; font-weight: 600;
  border: none; border-radius: 10px; cursor: pointer;
}
.opt__cancel { color: var(--c-sub); background: var(--c-bg); border: 1px solid var(--c-divider); }
.opt__go { color: #fff; background: var(--c-brand); }
.opt__cancel:disabled, .opt__go:disabled { opacity: 0.6; cursor: default; }

/* agent 工具调用进度：把 AI 的「过程」外化，用户看得见它在查什么、改什么 */
.opt__steps {
  display: flex; flex-direction: column; gap: 6px;
  margin-bottom: 12px; padding: 10px 12px;
  background: var(--c-brand-soft);
  border-radius: 10px;
}
.opt__step {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: var(--c-brand-deep);
}
.opt__step .van-icon { color: var(--c-brand); }
.opt__step-name { flex: 1; font-weight: 600; }
.opt__step-state { font-size: 12px; color: var(--c-brand); opacity: 0.75; }
.opt__step.is-fail, .opt__step.is-fail .van-icon { color: var(--c-sub); }
.opt__step.is-fail .opt__step-state { color: var(--c-sub); opacity: 1; }

/* agent 最终答复：与输入框区分开，读完不用再找输入位置 */
.opt__reply {
  margin: 0 0 12px; padding: 12px 14px;
  font-size: 14px; line-height: 1.7; color: var(--c-text);
  background: var(--c-bg); border-radius: 10px;
  white-space: pre-wrap;
}

/* ---------- 选中项操作栏 ---------- */
.item-actionbar {
  position: fixed;
  left: 0; right: 0;
  bottom: var(--tabbar-h);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: var(--c-card);
  border-top: 1px solid var(--c-divider);
  box-shadow: 0 -2px 12px rgba(10, 26, 43, 0.08);
  z-index: 9;
}
.item-actionbar__btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 40px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-divider);
  border-radius: 20px;
  transition: all 0.15s;
}
.item-actionbar__btn :deep(.van-icon) { font-size: 16px; }
/* 不可移动的方向直接置灰（把第二项上移会顶走「抵达」时，上移就灰掉） */
.item-actionbar__btn:disabled {
  color: var(--c-sub);
  opacity: 0.45;
  cursor: default;
}
/* 边界项的说明文案，占掉两个移动按钮的位置 */
.item-actionbar__hint {
  flex: 1;
  display: inline-flex;
  align-items: center;
  height: 40px;
  padding: 0 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-brand-deep);
  background: var(--c-brand-soft);
  border-radius: 10px;
}
.item-actionbar__btn--del { color: #ff4d4f; border-color: #ffccc7; background: #fff1f0; }
.item-actionbar__btn--cancel { flex: 0 0 auto; padding: 0 16px; color: var(--c-sub); }
.item-actionbar__btn:active { transform: scale(0.97); }

/* ---------- 修改人数面板 ---------- */
.people {
  padding: 20px 20px calc(env(safe-area-inset-bottom, 0px) + 20px);
}
.people__title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 700;
  color: var(--c-text);
}
.people__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--c-divider);
}
.people__label { display: flex; flex-direction: column; gap: 2px; }
.people__name { font-size: 14px; font-weight: 600; color: var(--c-text); }
.people__hint { font-size: 11.5px; color: var(--c-sub); }
.people__save {
  width: 100%;
  height: 44px;
  margin-top: 18px;
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  background: var(--c-brand);
  border-radius: 22px;
  transition: transform 0.15s, opacity 0.15s;
}
.people__save:disabled { opacity: 0.5; }
.people__save:not(:disabled):active { transform: scale(0.97); }

/* ══════════════════════════════════════════════
   景点决策卡（底部抽屉）
   ──────────────────────────────────────────────
   排版纪律：一屏只回答一个问题，用 12px 小标题分节，不用卡片套卡片。
   品牌色只出现在「为什么值得去」这句主判断和最后一条溯源上，其余全是中性色 ——
   决策信息的重心是内容，不是装饰。 */
.spot { padding: 18px 20px calc(env(safe-area-inset-bottom) + 88px); overflow-y: auto; }
.spot__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.spot__city { font-size: 11.5px; color: var(--c-sub); letter-spacing: 0.04em; }
.spot__title { margin-top: 2px; font-size: 19px; font-weight: 800; color: var(--c-text); letter-spacing: -0.01em; }
.spot__close { flex-shrink: 0; font-size: 18px; color: var(--c-muted); margin-top: 2px; }
.spot__loading { padding: 28px 0; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; color: var(--c-sub); }
/* 主判断：全卡唯一一处品牌色填充区（浅底 + 品牌描边），进窄<ul>先看这句 */
.spot__why {
  margin-top: 14px;
  padding: 11px 13px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--c-brand-deep);
  background: var(--c-brand-soft);
  border-left: 2px solid var(--c-brand);
  border-radius: 0 8px 8px 0;
}
.spot__label {
  margin-top: 16px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--c-muted);
  letter-spacing: 0.06em;
}
.spot__chips { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.spot__chip {
  padding: 4px 9px;
  font-size: 12px;
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
}
.spot__chip--yes { color: var(--c-brand-deep); background: var(--c-brand-soft); border-color: var(--c-brand-line); }
.spot__chip--no { color: var(--c-sub); background: var(--c-bg); border-color: var(--c-divider); }
/* 时间一行两格：最佳时段 / 建议停留，tabular-nums 让数字对齐 */
.spot__time { margin-top: 16px; display: flex; gap: 10px; }
.spot__time-item {
  flex: 1;
  padding: 10px 12px;
  background: var(--c-bg);
  border-radius: 10px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}
.spot__time-item em { display: block; font-style: normal; font-size: 11px; font-weight: 500; color: var(--c-muted); margin-bottom: 3px; }
.spot__note { margin-top: 12px; padding: 10px 12px; border: 1px dashed var(--c-divider); border-radius: 10px; }
.spot__note p { font-size: 13px; color: var(--c-text); line-height: 1.6; }
.spot__note em { font-style: normal; font-size: 11.5px; color: var(--c-muted); margin-right: 6px; }
/* 「以官方公示为准」：门票/预约是半衰期最短的一类，这条免责不是客套话 */
.spot__disclaim { margin-top: 6px !important; font-size: 11.5px !important; color: var(--c-muted) !important; }
.spot__list { margin-top: 6px; padding-left: 16px; }
.spot__list li { font-size: 13px; color: var(--c-text); line-height: 1.7; }
.spot__list li::marker { color: var(--c-brand-line); }
.spot__alts { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.spot__alt {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 11px 13px; text-align: left;
  background: var(--c-card); border: 1px solid var(--c-divider); border-radius: 12px;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  transition: border-color 0.2s var(--ease-motion);
}
.spot__alt:active { border-color: var(--c-brand-line); }
.spot__alt-name { font-size: 14px; font-weight: 600; color: var(--c-text); }
.spot__alt-tags { flex-shrink: 0; font-size: 11.5px; color: var(--c-muted); }
.spot__foot { margin-top: 18px; font-size: 11px; line-height: 1.6; color: var(--c-muted); }
.spot__empty { padding: 30px 0 20px; text-align: center; }
.spot__empty p { font-size: 14px; font-weight: 600; color: var(--c-sub); }
.spot__empty span { display: block; margin-top: 6px; font-size: 12px; color: var(--c-muted); }
</style>
