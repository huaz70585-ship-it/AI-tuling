/**
 * 消息通知工具 —— 全站唯一写 messages 表的地方。
 *
 * 收敛规则：路由里不再内联 INSERT INTO messages，都走这里，id/图标/底色/
 * 未读态统一生成。触发标准是「用户不在场时发生、或需要事后确认」的事件；
 * 写入失败一律静默兜底（通知是锦上添花，不该拖垮主流程）。
 */
import { run } from '../db.js'

function insert(userId, { type, icon, title, preview, cta }) {
  const now = new Date().toISOString()
  try {
    run(
      'INSERT INTO messages (id, user_id, type, icon, icon_bg, title, preview, time, unread, cta_label, cta_kind, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        userId,
        type,
        icon,
        type === 'trip' ? '#0e7c86' : '#8a939f', // 品牌青/中性灰，与消息页头像配色口径一致
        title,
        preview,
        now.slice(11, 16),
        1,
        cta?.label ?? null,
        cta?.kind ?? null,
        now,
      ],
    )
  } catch (e) {
    console.error('[notify]', e.message)
  }
}

/** 行程事件：带「查看行程」落点 */
export function notifyTrip(userId, { title, preview }) {
  insert(userId, { type: 'trip', icon: 'calendar-o', title, preview, cta: { label: '查看行程', kind: 'view' } })
}

/** 系统通知：纯信息，无按钮 */
export function notifySystem(userId, { icon, title, preview }) {
  insert(userId, { type: 'system', icon, title, preview, cta: null })
}

/** 天气预警：行程期间有雨/雪/雷等天气时提醒 */
export function notifyWeatherAlert(userId, tripTitle, dayLabel, text) {
  notifySystem(userId, {
    icon: 'flower-o',
    title: '出行天气提醒',
    preview: `「${tripTitle}」${dayLabel} ${text}，出行前留意天气`,
  })
}

/** AI 免责声明：首次生成行程时弹一次 */
export function notifyDisclaimer(userId) {
  notifySystem(userId, {
    icon: 'info-o',
    title: 'AI 生成内容仅供参考',
    preview: '时间与地点可能不准，出行前请核实',
  })
}
