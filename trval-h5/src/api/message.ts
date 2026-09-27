import { request } from '../utils/request'

export interface MessageCta { label: string; kind: 'pay' | 'view' }
export interface Message {
  id: string
  type: 'trade' | 'trip' | 'social' | 'system'
  icon: string
  iconBg: string
  title: string
  preview: string
  time: string
  unread: boolean
  cta: MessageCta | null
  /** 创建时间（ISO 字符串），前端按它做「今天 / 本周 / 更早」分组 */
  createdAt: string
}

/** 消息列表（category: all | trade | trip | social | system） */
export function getMessages(category = 'all'): Promise<Message[]> {
  return request<Message[]>({
    url: '/v1/messages',
    method: 'GET',
    params: { category },
  })
}

/** 全部已读 */
export function readAllMessages(): Promise<void> {
  return request({ url: '/v1/messages/read-all', method: 'PATCH' })
}

/** 单条已读（点击消息卡片时调用） */
export function readMessage(id: string): Promise<void> {
  return request({ url: `/v1/messages/${id}/read`, method: 'PATCH' })
}

/** 删除单条消息（左滑删除） */
export function deleteMessage(id: string): Promise<void> {
  return request({ url: `/v1/messages/${id}`, method: 'DELETE' })
}

/** 一键清空全部消息（不可恢复，调用前需弹确认框） */
export function clearAllMessages(): Promise<void> {
  return request({ url: '/v1/messages', method: 'DELETE' })
}
