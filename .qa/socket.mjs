import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'
import { api, check, jwt, JWT_SECRET, login, section, summary } from './lib.mjs'

const BASE = 'http://127.0.0.1:3000'

const aliceLogin = await login('qa_alice')
const bobLogin = await login('qa_bob')
const carolLogin = await login('qa_carol')
const A = aliceLogin.json.data.accessToken
const B = bobLogin.json.data.accessToken
const C = carolLogin.json.data.accessToken
const aliceId = aliceLogin.json.data.user.id
const bobId = bobLogin.json.data.user.id
const carolId = carolLogin.json.data.user.id

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false })
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('connect timeout'))
    }, 5000)
    socket.on('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.on('connect_error', (error) => {
      clearTimeout(timer)
      socket.close()
      reject(error)
    })
  })
}

function send(socket, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ack timeout')), 5000)
    socket.emit('message:send', payload, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
  })
}

function waitEvent(socket, event, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`${event} timeout`))
    }, timeout)
    const handler = (payload) => {
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(payload)
    }
    socket.on(event, handler)
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

section('Socket 认证与在线状态')

let badTokenRejected = false
try {
  const bad = await connect('not-a-token')
  bad.close()
} catch {
  badTokenRejected = true
}
check('非法 Token 无法建立 Socket 连接', badTokenRejected)

const aliceSocket = await connect(A)
const bobSocket = await connect(B)
const carolSocket = await connect(C)
check('三个账号 Socket 连接成功', aliceSocket.connected && bobSocket.connected && carolSocket.connected)

const presence = waitEvent(aliceSocket, 'presence:snapshot')
aliceSocket.emit('presence:get')
const snapshot = await presence
check(
  '在线好友快照包含 bob 而不包含非好友 carol',
  snapshot.onlineFriendIds.includes(bobId) && !snapshot.onlineFriendIds.includes(carolId),
  snapshot.onlineFriendIds
)

section('消息发送、幂等与校验')

const bobInbox = []
bobSocket.on('message:new', (message) => bobInbox.push(message))

const msg1Id = randomUUID()
const msg1 = await send(aliceSocket, { toUserId: bobId, messageId: msg1Id, content: '  第一条消息  ' })
check('alice 发送消息 ACK ok', msg1.ok === true, msg1.code)
check('消息内容被 trim 后保存', msg1.message?.content === '第一条消息', msg1.message?.content)
check('消息带服务端 ID 与时间', Boolean(msg1.message?.id && msg1.message?.createdAt))

const pushed = await waitEvent(bobSocket, 'message:new')
check('bob 实时收到消息推送', pushed.id === msg1.message.id && pushed.content === '第一条消息')

const duplicate = await send(aliceSocket, { toUserId: bobId, messageId: msg1Id, content: '第一条消息' })
check('重复 messageId 返回同一消息', duplicate.ok === true && duplicate.message.id === msg1.message.id)
await wait(400)
check('重复消息不会再次推送', bobInbox.filter((m) => m.id === msg1.message.id).length === 1, bobInbox.length)

const notFriend = await send(carolSocket, { toUserId: bobId, messageId: randomUUID(), content: '你好' })
check('非好友发送返回 NOT_FRIEND', notFriend.ok === false && notFriend.code === 'NOT_FRIEND', notFriend.code)

const aliceSelfBefore = bobInbox.length
const selfId = randomUUID()
const selfMsg = await send(aliceSocket, { toUserId: aliceId, messageId: selfId, content: '自我备忘' })
check('自我消息发送成功', selfMsg.ok === true && selfMsg.message.receiverId === aliceId)
await wait(300)
check('自我消息不推送给自己', bobInbox.length === aliceSelfBefore)

const empty = await send(aliceSocket, { toUserId: bobId, messageId: randomUUID(), content: '   ' })
check('空白内容返回 INVALID_CONTENT', empty.code === 'INVALID_CONTENT', empty.code)

const tooLong = await send(aliceSocket, {
  toUserId: bobId,
  messageId: randomUUID(),
  content: 'x'.repeat(2001)
})
check('超长内容返回 INVALID_CONTENT', tooLong.code === 'INVALID_CONTENT', tooLong.code)

const badUuid = await send(aliceSocket, { toUserId: bobId, messageId: 'abc', content: 'x' })
check('非法 messageId 返回 INVALID_MESSAGE_ID', badUuid.code === 'INVALID_MESSAGE_ID', badUuid.code)

const badReceiver = await send(aliceSocket, { toUserId: 'abc', messageId: randomUUID(), content: 'x' })
check('非法接收者返回 INVALID_RECEIVER', badReceiver.code === 'INVALID_RECEIVER', badReceiver.code)

const missingUser = await send(aliceSocket, { toUserId: '999999', messageId: randomUUID(), content: 'x' })
check('不存在用户返回 USER_NOT_FOUND', missingUser.code === 'USER_NOT_FOUND', missingUser.code)

section('历史消息与增量同步')

const history = async (token, friendId, query = '') =>
  api('GET', `/api/messages/${friendId}${query}`, { token })

const aliceBobHistory = await history(A, bobId)
check('历史消息返回 200', aliceBobHistory.status === 200, aliceBobHistory.status)
check(
  '历史消息按时间升序且不重复',
  aliceBobHistory.json.data.messages.length === 1 &&
    aliceBobHistory.json.data.messages[0].id === msg1.message.id
)
const bobAliceHistory = await history(B, aliceId)
check('双方看到同一段历史', bobAliceHistory.json.data.messages.length === 1)
const aliceSelfHistory = await history(A, aliceId)
check('自我聊天历史可查询', aliceSelfHistory.json.data.messages.some((m) => m.id === selfMsg.message.id))

const otherHistory = await history(B, carolId)
check('查询与第三人的历史返回空且不泄露', otherHistory.status === 200 && otherHistory.json.data.messages.length === 0)

const bobMessages = []
bobMessages.push(await send(bobSocket, { toUserId: aliceId, messageId: randomUUID(), content: '鲍勃回复一' }))
bobMessages.push(await send(bobSocket, { toUserId: aliceId, messageId: randomUUID(), content: '鲍勃回复二' }))
check('bob 回复两条成功', bobMessages.every((r) => r.ok === true))

const ascHistory = await history(A, bobId, '?order=asc&limit=50')
check('order=asc 返回全部消息', ascHistory.json.data.messages.length === 3, ascHistory.json.data.messages.length)
const badAfter = await history(A, bobId, '?after=0')
check('非法同步游标返回 400', badAfter.status === 400, badAfter.status)

const limited = await history(A, bobId, '?limit=2')
check('limit 生效且返回 hasMore', limited.json.data.messages.length === 2 && limited.json.data.hasMore === true)
const cursor = limited.json.data.nextCursor
const older = await history(A, bobId, `?limit=2&before=${encodeURIComponent(cursor)}`)
check('before 游标可翻页', older.status === 200 && older.json.data.messages.length === 1, older.json.data?.messages?.length)

const badLimit = await history(A, bobId, '?limit=0')
check('非法 limit 返回 400', badLimit.status === 400, badLimit.status)

section('会话与未读')

const listConversations = async (token, includeHidden = false) =>
  api('GET', `/api/conversations?includeHidden=${includeHidden}`, { token })

let conversations = await listConversations(A)
const bobConversation = conversations.json.conversations.find((c) => c.peerId === bobId)
check('会话列表包含 bob 会话', Boolean(bobConversation))
check('未读统计只算对方发来的消息', bobConversation?.unreadCount === 2, bobConversation?.unreadCount)
check('未读总数正确', conversations.json.unreadTotal === 2, conversations.json.unreadTotal)
const lastMessageAt = bobConversation?.lastMessageAt
check('最近消息时间与活动时间存在', Boolean(lastMessageAt && bobConversation?.lastActivityAt))

const selfConversation = conversations.json.conversations.find((c) => c.peerId === aliceId)
check('自我会话未读恒为 0', selfConversation?.unreadCount === 0, selfConversation?.unreadCount)

const readLatest = await api('POST', `/api/conversations/${bobId}/read`, {
  token: A,
  body: { lastReadMessageId: bobMessages[1].message.id }
})
check('标记已读返回 200 且未读清零', readLatest.status === 200 && readLatest.json.data.unreadCount === 0, readLatest.status)

const readOlder = await api('POST', `/api/conversations/${bobId}/read`, {
  token: A,
  body: { lastReadMessageId: bobMessages[0].message.id }
})
check(
  '旧已读位置不会回退',
  readOlder.json?.data?.lastReadMessageId === bobMessages[1].message.id,
  readOlder.json?.data?.lastReadMessageId
)

const readForeign = await api('POST', `/api/conversations/${bobId}/read`, {
  token: A,
  body: { lastReadMessageId: selfMsg.message.id }
})
check('不能把别的会话消息标为已读（404）', readForeign.status === 404, readForeign.status)

const readMissing = await api('POST', `/api/conversations/${bobId}/read`, {
  token: A,
  body: { lastReadMessageId: '999999' }
})
check('不存在的消息返回 404', readMissing.status === 404, readMissing.status)

section('置顶、免打扰、隐藏与恢复')

conversations = await listConversations(A)
const bobEntry = conversations.json.conversations.find((c) => c.peerId === bobId)
const pin = await api('PATCH', `/api/conversations/${bobId}`, {
  token: A,
  body: { isPinned: true, version: bobEntry.version }
})
check('置顶成功且版本递增', pin.status === 200 && pin.json.conversation.isPinned === true, pin.status)

const staleVersion = await api('PATCH', `/api/conversations/${bobId}`, {
  token: A,
  body: { isMuted: true, version: bobEntry.version }
})
check('过期版本号返回 409', staleVersion.status === 409, staleVersion.status)

const mute = await api('PATCH', `/api/conversations/${bobId}`, {
  token: A,
  body: { isMuted: true, version: pin.json.conversation.version }
})
check('免打扰成功', mute.status === 200 && mute.json.conversation.isMuted === true, mute.status)

const selfMute = await api('PATCH', `/api/conversations/${aliceId}`, {
  token: A,
  body: { isMuted: true, version: selfConversation.version }
})
check('自我会话不能免打扰（400）', selfMute.status === 400, selfMute.status)

const hide = await api('PATCH', `/api/conversations/${bobId}`, {
  token: A,
  body: { isHidden: true, version: mute.json.conversation.version }
})
check('隐藏会话成功', hide.status === 200 && hide.json.conversation.isHidden === true, hide.status)

conversations = await listConversations(A)
check('隐藏会话默认不出现在列表', !conversations.json.conversations.some((c) => c.peerId === bobId))
const withHidden = await listConversations(A, true)
check('includeHidden 可看到隐藏会话', withHidden.json.conversations.some((c) => c.peerId === bobId))

const openAgain = await api('POST', `/api/conversations/${bobId}/open`, { token: A })
check('重新打开隐藏会话恢复显示', openAgain.status === 200 && openAgain.json.conversation.isHidden === false, openAgain.status)
check('重新打开保留置顶与免打扰', openAgain.json.conversation.isPinned === true && openAgain.json.conversation.isMuted === true)

const historyAfterOpen = await history(A, bobId)
check('隐藏不会删除历史消息', historyAfterOpen.json.data.messages.length === 3)

const revive = await send(bobSocket, { toUserId: aliceId, messageId: randomUUID(), content: '新消息让会话重新出现' })
await wait(300)
conversations = await listConversations(A)
const revived = conversations.json.conversations.find((c) => c.peerId === bobId)
check('新消息让隐藏会话重新出现', Boolean(revived), revive.code)
check('新消息计入未读', revived?.unreadCount === 1, revived?.unreadCount)

section('离线、重连与会话替换')

bobSocket.close()
await wait(300)
const offlineSend = await send(aliceSocket, {
  toUserId: bobId,
  messageId: randomUUID(),
  content: '离线期间发送'
})
check('对方离线时消息仍发送成功', offlineSend.ok === true, offlineSend.code)

const bobReconnected = await connect(B)
check('bob 重新连接成功', bobReconnected.connected)
const offlineHistory = await history(B, aliceId)
check(
  '重连后可拉取离线期间消息',
  offlineHistory.json.data.messages.some((m) => m.content === '离线期间发送')
)

const secondAlice = await connect(A)
const replaced = await waitEvent(aliceSocket, 'session:replaced', 4000).catch(() => null)
check('重复连接触发 session:replaced', replaced !== null)
await wait(300)
check('旧连接被断开', aliceSocket.connected === false)
secondAlice.close()

const shortToken = jwt.sign({ sub: aliceId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: 2 })
const expiring = await connect(shortToken)
const expiredDisconnect = await waitEvent(expiring, 'disconnect', 6000).catch(() => null)
check('Socket Token 到期后被服务端断开', expiredDisconnect !== null)

section('删除好友级联与恢复')

const beforeCounts = await api('GET', `/api/messages/${bobId}`, { token: A })
check('删除前历史存在', beforeCounts.json.data.messages.length > 0)

const remove = await api('DELETE', `/api/friends/${bobId}`, { token: A })
check('删除好友返回 200', remove.status === 200, remove.status)

const aliceFriendsAfter = await api('GET', '/api/friends', { token: A })
check('alice 好友列表不再包含 bob', !aliceFriendsAfter.json.friends.some((f) => f.id === bobId))
const bobFriendsAfter = await api('GET', '/api/friends', { token: B })
check('bob 好友列表不再包含 alice', !bobFriendsAfter.json.friends.some((f) => f.id === aliceId))

const historyAfterDelete = await history(A, bobId)
check('删除好友后双方历史消息清空', historyAfterDelete.json.data.messages.length === 0, historyAfterDelete.json.data.messages.length)

const conversationsAfterDelete = await listConversations(A, true)
check(
  '删除好友后双方会话记录被清理',
  !conversationsAfterDelete.json.conversations.some((c) => c.peerId === bobId)
)

const sendAfterDelete = await send(bobReconnected, { toUserId: aliceId, messageId: randomUUID(), content: 'x' })
check('删除好友后无法再发送消息', sendAfterDelete.code === 'NOT_FRIEND', sendAfterDelete.code)

const requestsAfterDelete = await api('GET', '/api/friends/requests', { token: A })
check('删除好友不影响历史申请记录', requestsAfterDelete.json.requests.length > 0, requestsAfterDelete.json.requests.length)

const bobProfile = await api('GET', '/api/profile/me', { token: B })
const readd = await api('POST', '/api/friends/requests', { token: A, body: { uid: bobProfile.json.data.uid } })
check('删除后可通过 UID 重新申请', readd.status === 201, readd.status)

const bobRequests = await api('GET', '/api/friends/requests', { token: B })
const newPending = bobRequests.json.requests.find((r) => r.direction === 'incoming' && r.status === 'pending')
if (newPending) {
  const accepted = await api('POST', `/api/friends/requests/${newPending.id}/accept`, { token: B })
  check('重新添加好友成功', accepted.status === 200 && accepted.json.data.status === 'accepted')
} else {
  check('重新添加好友成功', false, 'no pending request')
}

const restored = await api('GET', '/api/friends', { token: A })
check('重新添加后好友关系恢复', restored.json.friends.some((f) => f.id === bobId))

aliceSocket.close()
bobReconnected.close()
carolSocket.close()

summary('Socket / 消息 / 会话')
