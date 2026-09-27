import { Router } from 'express'
import { queryAll, run } from '../db.js'
import { ok, err } from '../utils/response.js'
import { authMiddleware } from '../utils/auth.js'

const router = Router()
router.use(authMiddleware)

/** GET /v1/messages?category=  消息列表 */
router.get('/messages', (req, res) => {
  const { category } = req.query
  let sql = 'SELECT * FROM messages WHERE user_id = ?'
  const params = [req.user.id]
  if (category && category !== 'all') {
    sql += ' AND type = ?'
    params.push(category)
  }
  sql += ' ORDER BY created_at DESC'
  const rows = queryAll(sql, params)
  ok(res, rows.map((m) => ({
    id: m.id,
    type: m.type,
    icon: m.icon,
    iconBg: m.icon_bg,
    title: m.title,
    preview: m.preview,
    time: m.time,
    unread: !!m.unread,
    cta: m.cta_label ? { label: m.cta_label, kind: m.cta_kind } : null,
    // 前端要按真实日期分组（今天/本周/更早），只给格式化后的 time 没法判断日期
    createdAt: m.created_at,
  })))
})

/** PATCH /v1/messages/read-all  全部已读 */
router.patch('/messages/read-all', (req, res) => {
  run('UPDATE messages SET unread = 0 WHERE user_id = ? AND unread = 1', [req.user.id])
  ok(res, null, '已全部标为已读')
})

/** PATCH /v1/messages/:id/read  单条已读（点击消息卡片时调用） */
router.patch('/messages/:id/read', (req, res) => {
  const { id } = req.params
  const row = queryAll('SELECT id FROM messages WHERE id = ? AND user_id = ?', [id, req.user.id])
  if (!row.length) return err(res, '消息不存在', 404)
  run('UPDATE messages SET unread = 0 WHERE id = ? AND user_id = ?', [id, req.user.id])
  ok(res, null, '已标为已读')
})

/** DELETE /v1/messages/:id  删除单条消息（左滑删除） */
router.delete('/messages/:id', (req, res) => {
  const { id } = req.params
  const row = queryAll('SELECT id FROM messages WHERE id = ? AND user_id = ?', [id, req.user.id])
  if (!row.length) return err(res, '消息不存在', 404)
  run('DELETE FROM messages WHERE id = ? AND user_id = ?', [id, req.user.id])
  ok(res, { id })
})

/** DELETE /v1/messages  一键清空当前用户的全部消息（前端二次确认后调用） */
router.delete('/messages', (req, res) => {
  run('DELETE FROM messages WHERE user_id = ?', [req.user.id])
  ok(res, null, '消息已清空')
})

/** GET /v1/messages/unread-count  未读数 */
router.get('/messages/unread-count', (req, res) => {
  const row = queryAll('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND unread = 1', [req.user.id])
  ok(res, { count: row[0]?.n ?? 0 })
})

export default router
