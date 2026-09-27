import type { HopMode } from '../api/hop'

/**
 * 交通方式线性图标（全站一份：行程页衔接条 / 方式切换面板共用）。
 * 语言与天气图标一致：24×24 viewBox、fill none、stroke=currentColor、线宽 1.6、圆角端点。
 */
export const HOP_ICONS: Record<HopMode, string> = {
  // 步行：侧面人物（头 + 躯干 + 摆臂 + 迈步）
  walk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="3.5" r="1.8"/><path d="M12 5.5V10"/><path d="M9.5 7.5 12 10l4-1"/><path d="M12 10l-1.5 3.5L9.5 17"/><path d="M12 10l2.5 2.5L15 17"/></svg>',
  // 公交：侧视车身 + 车窗分割线 + 两轮
  bus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5.5" width="16" height="10" rx="2.5"/><path d="M4 10.5h16"/><circle cx="8.5" cy="17.5" r="1.2"/><circle cx="15.5" cy="17.5" r="1.2"/></svg>',
  // 地铁：车头正视 + 三扇窗 + 底边
  metro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="12" rx="2.5"/><rect x="6.5" y="7.5" width="3" height="4" rx="0.7"/><rect x="10.5" y="7.5" width="3" height="4" rx="0.7"/><rect x="14.5" y="7.5" width="3" height="4" rx="0.7"/><path d="M7 19.5h10"/></svg>',
  // 打车：侧视轿车（车身 + 车顶 + 两轮）
  taxi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 13h15a1 1 0 0 1 1 1v2.5h-17V14a1 1 0 0 1 1-1Z"/><path d="M8.5 13l1.3-3a1 1 0 0 1 .9-.6h2.6a1 1 0 0 1 .9.6l1.3 3"/><circle cx="7.5" cy="17" r="1.4"/><circle cx="16.5" cy="17" r="1.4"/></svg>',
  // 骑行：自行车侧视（两轮 + 车架 + 车把）
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="14" r="3.2"/><circle cx="18.5" cy="14" r="3.2"/><path d="M8.7 14h4.3"/><path d="M13 14 10.5 7h4"/><path d="M13.5 14l4-3.5"/><path d="M17.5 10.5l1 3.5"/></svg>',
  // 城际巴士：长途车身 + 通长大前窗 + 两轮
  coach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="9.5" rx="2.5"/><rect x="13.5" y="7.5" width="6" height="2.5" rx="1"/><path d="M3 11.5h18"/><circle cx="8" cy="17.5" r="1.3"/><circle cx="16" cy="17.5" r="1.3"/></svg>',
  // 未知：箭头 →（「前往」占位）
  unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14"/><path d="M13 6l6 6-6 6"/></svg>',
}

/** 分步走法的一步：动作类型 → 图标。复用 6 个交通图标 + 2 个动作图标（出站口 / 换乘） */
export const STEP_ICONS: Record<string, string> = {
  walk: HOP_ICONS.walk,
  metro: HOP_ICONS.metro,
  bus: HOP_ICONS.bus,
  taxi: HOP_ICONS.taxi,
  bike: HOP_ICONS.bike,
  coach: HOP_ICONS.coach,
  // 出站口：门框 + 向上箭头（「哪个口出」）
  exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v16"/><path d="M12 16V8"/><path d="M9.5 10.5 12 8l2.5 2.5"/></svg>',
  // 换乘：两个反向箭头（上下错位 = 换乘）
  transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7h9M8 7l2.5-2.5M8 7l2.5 2.5"/><path d="M16 17H7M16 17l-2.5 2.5M16 17l-2.5-2.5"/></svg>',
}
