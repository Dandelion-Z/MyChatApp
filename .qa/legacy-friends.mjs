/**
 * 遗留接口回归：服务端不得存在“按 UID 直接建立好友关系”的入口。
 * 好友关系只能通过好友申请 + 对方同意建立。
 */
import { api, check, login, PASSWORD, register, section, summary } from './lib.mjs'

section('遗留接口已移除')

const aReg = await register('qa_legacy_a', 'QA 旧接口甲')
const bReg = await register('qa_legacy_b', 'QA 旧接口乙')
check('注册甲 201', aReg.status === 201, aReg.status)
check('注册乙 201', bReg.status === 201, bReg.status)

const aLogin = await login('qa_legacy_a')
const bLogin = await login('qa_legacy_b')
const aToken = aLogin.json?.data?.accessToken
const bToken = bLogin.json?.data?.accessToken
check('登录拿到令牌', Boolean(aToken) && Boolean(bToken))

const aMe = await api('GET', '/api/profile/me', { token: aToken })
const bMe = await api('GET', '/api/profile/me', { token: bToken })
check('读取双方 UID', Boolean(aMe.json?.data?.uid) && Boolean(bMe.json?.data?.uid), {
  a: aMe.json?.data?.uid,
  b: bMe.json?.data?.uid
})

const legacy = await api('POST', '/api/friends', { token: aToken, body: { uid: bMe.json?.data?.uid } })
check('旧接口 POST /api/friends 已不存在（404）', legacy.status === 404, legacy.status)

section('申请制仍可用')

const before = await api('GET', '/api/friends', { token: aToken })
check('建立关系前好友列表为空', before.status === 200 && before.json?.friends?.length === 0, {
  friends: before.json?.friends?.length
})

const openBefore = await api('POST', `/api/conversations/${bMe.json?.data?.id}/open`, { token: aToken })
check('建立关系前不能打开会话（400 非好友）', openBefore.status === 400, openBefore.status)

const sent = await api('POST', '/api/friends/requests', {
  token: aToken,
  body: { uid: bMe.json?.data?.uid }
})
check('发送好友申请返回 201', sent.status === 201, sent.status)

const afterRequest = await api('GET', '/api/friends', { token: aToken })
check('仅发申请不会建立好友关系', afterRequest.json?.friends?.length === 0, {
  friends: afterRequest.json?.friends?.length
})

const requests = await api('GET', '/api/friends/requests', { token: bToken })
const incoming = requests.json?.requests?.find((item) => item.direction === 'incoming')
check('接收方看到待处理申请', Boolean(incoming), incoming?.id)

const accepted = await api('POST', `/api/friends/requests/${incoming.id}/accept`, { token: bToken })
check('同意申请 200', accepted.status === 200, accepted.status)

const aFriends = await api('GET', '/api/friends', { token: aToken })
const bFriends = await api('GET', '/api/friends', { token: bToken })
check('同意后双方互为好友', aFriends.json?.friends?.length === 1 && bFriends.json?.friends?.length === 1)

section('拒绝不建立关系')

const bMe2 = bMe.json?.data
const cReg = await register('qa_legacy_c', 'QA 旧接口丙')
check('注册丙 201', cReg.status === 201, cReg.status)
const cLogin = await login('qa_legacy_c', PASSWORD)
const cToken = cLogin.json?.data?.accessToken
const cMe = await api('GET', '/api/profile/me', { token: cToken })
const cUid = cMe.json?.data?.uid

const sent2 = await api('POST', '/api/friends/requests', { token: bToken, body: { uid: cUid } })
check('乙向丙发送申请 201', sent2.status === 201, sent2.status)
const cIncoming = (await api('GET', '/api/friends/requests', { token: cToken })).json?.requests?.find(
  (item) => item.direction === 'incoming'
)
const rejected = await api('POST', `/api/friends/requests/${cIncoming.id}/reject`, { token: cToken })
check('拒绝申请 200', rejected.status === 200, rejected.status)
const bFriendsAfterReject = await api('GET', '/api/friends', { token: bToken })
check('拒绝后好友数量不变', bFriendsAfterReject.json?.friends?.length === 1, {
  friends: bFriendsAfterReject.json?.friends?.length
})

summary('遗留好友接口')
