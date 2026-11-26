import { readFileSync } from 'node:fs'
import { api, check, login, section, summary } from './lib.mjs'

const state = JSON.parse(readFileSync('.qa/state.json', 'utf8'))
const { alice, bob, carol, dave } = state

const aliceLogin = await login('qa_alice')
const bobLogin = await login('qa_bob')
const carolLogin = await login('qa_carol')
const daveLogin = await login('qa_dave')
check('四个账号登录成功', [aliceLogin, bobLogin, carolLogin, daveLogin].every((r) => r.status === 200))

const A = aliceLogin.json.data.accessToken
const B = bobLogin.json.data.accessToken
const C = carolLogin.json.data.accessToken
const D = daveLogin.json.data.accessToken

const uidOf = async (token) => (await api('GET', '/api/profile/me', { token })).json?.data?.uid
alice.uid = await uidOf(A)
bob.uid = await uidOf(B)
carol.uid = await uidOf(C)
dave.uid = await uidOf(D)
check('四个账号 uid 均已分配', [alice.uid, bob.uid, carol.uid, dave.uid].every(Boolean), [
  alice.uid,
  bob.uid,
  carol.uid,
  dave.uid
])

section('好友申请')

const send = await api('POST', '/api/friends/requests', { token: A, body: { uid: bob.uid } })
check('alice 向 bob 发送申请返回 201', send.status === 201, send.status)
const request = send.json?.data
check(
  '申请方向为 outgoing 且带对方昵称',
  request?.direction === 'outgoing' && request?.status === 'pending' && request?.user?.nickname === 'QA 鲍勃'
)
check('申请对象不暴露 username', !send.text.includes('username'))

const duplicate = await api('POST', '/api/friends/requests', { token: A, body: { uid: bob.uid } })
check('同方向重复申请返回 409', duplicate.status === 409, duplicate.status)

const reverse = await api('POST', '/api/friends/requests', { token: B, body: { uid: alice.uid } })
check('反向待处理申请返回 409', reverse.status === 409, reverse.status)

const self = await api('POST', '/api/friends/requests', { token: A, body: { uid: alice.uid } })
check('向自己发送申请返回 400', self.status === 400, self.status)

const missing = await api('POST', '/api/friends/requests', { token: A, body: { uid: '99999999' } })
check('不存在的 UID 返回 404', missing.status === 404, missing.status)

const badUid = await api('POST', '/api/friends/requests', { token: A, body: { uid: '010001' } })
check('非法 UID 格式返回 400', badUid.status === 400, badUid.status)

const bobInbox = await api('GET', '/api/friends/requests', { token: B })
const incoming = bobInbox.json?.requests?.find((item) => item.id === request.id)
check('接收方能看到待处理申请', incoming?.direction === 'incoming' && incoming?.status === 'pending')
check('接收方待处理数量为 1', bobInbox.json?.pendingIncomingCount === 1, bobInbox.json?.pendingIncomingCount)

const aliceOutbox = await api('GET', '/api/friends/requests', { token: A })
check('发送方列表显示等待验证', aliceOutbox.json?.requests?.some((item) => item.direction === 'outgoing'))
check('发送方待处理数为 0', aliceOutbox.json?.pendingIncomingCount === 0, aliceOutbox.json?.pendingIncomingCount)

const acceptBySender = await api('POST', `/api/friends/requests/${request.id}/accept`, { token: A })
check('发送方不能同意申请（403）', acceptBySender.status === 403, acceptBySender.status)

const accept = await api('POST', `/api/friends/requests/${request.id}/accept`, { token: B })
check('接收方同意申请返回 200', accept.status === 200 && accept.json?.data?.status === 'accepted', accept.status)
check('同意后记录 handledAt', Boolean(accept.json?.data?.handledAt))

const acceptAgain = await api('POST', `/api/friends/requests/${request.id}/accept`, { token: B })
check('重复同意幂等返回 200', acceptAgain.status === 200, acceptAgain.status)

const aliceFriends = await api('GET', '/api/friends', { token: A })
const bobFriends = await api('GET', '/api/friends', { token: B })
check('alice 好友列表包含 bob', aliceFriends.json?.friends?.some((f) => f.id === bob.id))
check('bob 好友列表包含 alice', bobFriends.json?.friends?.some((f) => f.id === alice.id))
const friendItem = aliceFriends.json.friends.find((f) => f.id === bob.id)
check(
  '好友列表字段完整且不含 username',
  friendItem &&
    !('username' in friendItem) &&
    'avatarUrl' in friendItem &&
    'remark' in friendItem &&
    'isStarred' in friendItem,
  Object.keys(friendItem ?? {})
)

const acceptedList = await api('GET', '/api/friends/requests', { token: B })
const acceptedItem = acceptedList.json.requests.find((item) => item.id === request.id)
check('已同意的申请保留状态', acceptedItem?.status === 'accepted')
check('同意后待处理数量归零', acceptedList.json.pendingIncomingCount === 0, acceptedList.json.pendingIncomingCount)

section('拒绝流程')

const carolSend = await api('POST', '/api/friends/requests', { token: C, body: { uid: alice.uid } })
check('carol 向 alice 发送申请', carolSend.status === 201, carolSend.status)
const carolRequest = carolSend.json.data

const rejectBySender = await api('POST', `/api/friends/requests/${carolRequest.id}/reject`, { token: C })
check('发送方不能拒绝申请（403）', rejectBySender.status === 403, rejectBySender.status)

const reject = await api('POST', `/api/friends/requests/${carolRequest.id}/reject`, { token: A })
check('接收方拒绝返回 200 且状态为 rejected', reject.json?.data?.status === 'rejected', reject.status)

const noFriend = await api('GET', '/api/friends', { token: C })
check('拒绝后未建立好友关系', !noFriend.json.friends.some((f) => f.id === alice.id))

const resend = await api('POST', '/api/friends/requests', { token: C, body: { uid: alice.uid } })
check('被拒绝后允许重新申请', resend.status === 201, resend.status)

const acceptRejected = await api('POST', `/api/friends/requests/${carolRequest.id}/accept`, { token: A })
check('已拒绝的申请不能再同意（409）', acceptRejected.status === 409, acceptRejected.status)

const badRequestId = await api('POST', '/api/friends/requests/abc/accept', { token: A })
check('非法申请 ID 返回 400', badRequestId.status === 400, badRequestId.status)

const missingRequest = await api('POST', '/api/friends/requests/999999/accept', { token: A })
check('不存在的申请返回 404', missingRequest.status === 404, missingRequest.status)

section('好友星标与备注')

const star = await api('PUT', `/api/friends/${bob.id}/star`, { token: A, body: { starred: true } })
check('alice 标记 bob 星标成功', star.status === 200 && star.json?.data?.isStarred === true, star.status)

const bobStarOfAlice = await api('GET', '/api/friends', { token: B })
check(
  '星标只影响自己一侧',
  bobStarOfAlice.json.friends.find((f) => f.id === alice.id)?.isStarred === false
)

const unstar = await api('PUT', `/api/friends/${bob.id}/star`, { token: A, body: { starred: false } })
check('取消星标成功且 starredAt 清空', unstar.json?.data?.isStarred === false && unstar.json?.data?.starredAt === null)

const remark = await api('PATCH', `/api/friends/${bob.id}/remark`, { token: A, body: { remark: '工作伙伴' } })
check('设置好友备注成功', remark.status === 200 && remark.json?.data?.remark === '工作伙伴', remark.status)

const bobView = await api('GET', '/api/friends', { token: B })
check(
  '备注不影响对方一侧',
  bobView.json.friends.find((f) => f.id === alice.id)?.remark === null
)

const remarkLong = await api('PATCH', `/api/friends/${bob.id}/remark`, {
  token: A,
  body: { remark: '😀'.repeat(51) }
})
check('备注超过 50 个字符返回 400', remarkLong.status === 400, remarkLong.status)

const remarkClear = await api('PATCH', `/api/friends/${bob.id}/remark`, { token: A, body: { remark: null } })
check('清空备注成功', remarkClear.json?.data?.remark === null)

const remarkNotFound = await api('PATCH', `/api/friends/${dave.id}/remark`, {
  token: A,
  body: { remark: 'x' }
})
check('非好友设置备注返回 404', remarkNotFound.status === 404, remarkNotFound.status)

section('删除好友与数据级联（消息部分稍后由 socket 脚本验证）')

const notFriend = await api('DELETE', `/api/friends/${dave.id}`, { token: A })
check('删除非好友返回 404', notFriend.status === 404, notFriend.status)

const selfDelete = await api('DELETE', `/api/friends/${alice.id}`, { token: A })
check('不能删除自己（400）', selfDelete.status === 400, selfDelete.status)

summary('好友')
