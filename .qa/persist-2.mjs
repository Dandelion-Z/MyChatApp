import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'
import { api, check, login, section, summary } from './lib.mjs'

const expected = JSON.parse(readFileSync('.qa/persist.json', 'utf8'))
const aliceLogin = await login('qa_alice')
const A = aliceLogin.json.data.accessToken

section('服务端重启后的恢复')

const history = await api('GET', `/api/messages/${expected.bobId}`, { token: A })
check('重启后历史消息仍存在', history.json.data.messages.length === expected.count, {
  before: expected.count,
  after: history.json.data.messages.length
})
check(
  '最后一条消息 ID 未变化',
  history.json.data.messages.some((m) => m.id === expected.lastId)
)

const conversations = await api('GET', '/api/conversations', { token: A })
const bobConversation = conversations.json.conversations.find((c) => c.peerId === expected.bobId)
check('重启后会话与未读数据保留', Boolean(bobConversation) && bobConversation.unreadCount >= 2, bobConversation?.unreadCount)

const socket = await new Promise((resolve, reject) => {
  const s = io('http://127.0.0.1:3000', {
    auth: { token: A },
    transports: ['websocket'],
    reconnection: false
  })
  s.on('connect', () => resolve(s))
  s.on('connect_error', reject)
})
check('重启后可重新建立 Socket 连接', socket.connected)

const ack = await new Promise((resolve) =>
  socket.emit(
    'message:send',
    { toUserId: expected.bobId, messageId: randomUUID(), content: '重启后消息' },
    (response) => resolve(response)
  )
)
check('重启后消息发送正常', ack.ok === true, ack.code)

socket.close()
summary('重启后恢复')
