import { writeFileSync } from 'node:fs'
import {
  api,
  check,
  jwt,
  JWT_SECRET,
  login,
  PASSWORD,
  register,
  section,
  summary
} from './lib.mjs'

section('注册')

const aliceReg = await register('qa_alice', 'QA 爱丽丝')
const alice = aliceReg.json?.data
check('注册 qa_alice 返回 201', aliceReg.status === 201, aliceReg.status)
check('注册响应不泄露密码/哈希', !aliceReg.text.includes('password') && !aliceReg.text.includes('argon2'))
check('首个用户注册返回 id', Boolean(alice?.id), alice?.id)

const bobReg = await register('qa_bob', 'QA 鲍勃')
const bob = bobReg.json?.data
check('qa_bob 注册成功', bobReg.status === 201 && Boolean(bob?.id), bobReg.status)

const carolReg = await register('qa_carol', 'QA 卡罗尔')
const carol = carolReg.json?.data
check('qa_carol 注册成功', carolReg.status === 201, carolReg.status)

const daveReg = await register('qa_dave', 'QA 戴夫')
const dave = daveReg.json?.data
check('qa_dave 注册成功', daveReg.status === 201, daveReg.status)

const dup = await register('qa_alice', 'QA 爱丽丝')
check('重复用户名返回 409', dup.status === 409, dup.status)

section('登录与令牌校验')

const aliceLogin = await login('qa_alice')
check('正确密码登录返回 200', aliceLogin.status === 200, aliceLogin.status)
const aliceTokens = aliceLogin.json?.data
check(
  '登录返回 access/refresh/user',
  typeof aliceTokens?.accessToken === 'string' &&
    typeof aliceTokens?.refreshToken === 'string' &&
    aliceTokens?.user?.nickname === 'QA 爱丽丝'
)
check('登录响应不包含密码哈希', !aliceLogin.text.includes('$argon2'))

const bobLogin = await login('qa_bob')
const carolLogin = await login('qa_carol')
const bobTokens = bobLogin.json?.data
const carolTokens = carolLogin.json?.data
check('其余账号登录正常', bobLogin.status === 200 && carolLogin.status === 200)

const wrong = await login('qa_alice', 'WrongPassword123!')
check('错误密码返回 401', wrong.status === 401, wrong.status)

const me = await api('GET', '/api/profile/me', { token: aliceTokens.accessToken })
check('Access Token 访问受保护接口成功', me.status === 200, me.status)
const aliceUid = me.json?.data?.uid
check('alice 资料含 5–19 位数字 UID', typeof aliceUid === 'string' && /^[1-9]\d{4,18}$/.test(aliceUid), aliceUid)
const bobMe = await api('GET', '/api/profile/me', { token: bobTokens.accessToken })
const bobUid = bobMe.json?.data?.uid
check('bob 的 UID 在 alice 之后连续分配', Number(bobUid) === Number(aliceUid) + 1, {
  aliceUid,
  bobUid
})
check('资料不含 username/密码', !me.text.includes('username') && !me.text.includes('password'))

const noToken = await api('GET', '/api/profile/me')
check('缺少 Token 返回 401', noToken.status === 401, noToken.status)

const badToken = await api('GET', '/api/profile/me', { token: 'not-a-jwt' })
check('非法 Token 返回 401', badToken.status === 401, badToken.status)

const expired = jwt.sign({ sub: alice.id, username: 'qa_alice' }, JWT_SECRET, {
  algorithm: 'HS256',
  expiresIn: -60
})
const expiredRes = await api('GET', '/api/profile/me', { token: expired })
check('过期 Access Token 返回 401', expiredRes.status === 401, expiredRes.status)

const wrongSig = jwt.sign({ sub: alice.id, username: 'qa_alice' }, 'wrong-secret', {
  algorithm: 'HS256',
  expiresIn: '15m'
})
const wrongSigRes = await api('GET', '/api/profile/me', { token: wrongSig })
check('错误签名 Token 返回 401', wrongSigRes.status === 401, wrongSigRes.status)

section('Refresh Token 轮换与重放')

const refresh1 = await api('POST', '/api/auth/refresh', {
  body: { refreshToken: aliceTokens.refreshToken }
})
check('刷新成功返回 200', refresh1.status === 200, refresh1.status)
const rotated = refresh1.json?.data
check('刷新返回新的 refreshToken', Boolean(rotated?.refreshToken) && rotated.refreshToken !== aliceTokens.refreshToken)

const replay = await api('POST', '/api/auth/refresh', {
  body: { refreshToken: aliceTokens.refreshToken }
})
check('旧 Refresh Token 重放返回 401', replay.status === 401, replay.status)

const rotatedAccess = await api('GET', '/api/profile/me', { token: rotated.accessToken })
check('轮换后的 Access Token 可用', rotatedAccess.status === 200, rotatedAccess.status)

section('修改密码与多设备凭证')

const deviceA = await login('qa_alice')
const deviceB = await login('qa_alice')
check('同账号再次登录成功', deviceA.status === 200 && deviceB.status === 200)

const wrongCurrent = await api('PATCH', '/api/profile/me/password', {
  token: deviceA.json.data.accessToken,
  body: { currentPassword: 'WrongCurrent1!', newPassword: 'NewQaPass123!' }
})
check('原密码错误返回 400', wrongCurrent.status === 400, wrongCurrent.status)

const shortNew = await api('PATCH', '/api/profile/me/password', {
  token: deviceA.json.data.accessToken,
  body: { currentPassword: PASSWORD, newPassword: 'short' }
})
check('新密码过短返回 400', shortNew.status === 400, shortNew.status)

const sameNew = await api('PATCH', '/api/profile/me/password', {
  token: deviceA.json.data.accessToken,
  body: { currentPassword: PASSWORD, newPassword: PASSWORD }
})
check('新旧密码相同返回 400', sameNew.status === 400, sameNew.status)

const changed = await api('PATCH', '/api/profile/me/password', {
  token: deviceA.json.data.accessToken,
  body: {
    currentPassword: PASSWORD,
    newPassword: 'NewQaPass123!',
    currentRefreshToken: deviceA.json.data.refreshToken
  }
})
check('修改密码成功返回 200', changed.status === 200 && changed.json?.success === true, changed.status)

const oldLogin = await login('qa_alice')
check('旧密码登录失败', oldLogin.status === 401, oldLogin.status)

const newLogin = await login('qa_alice', 'NewQaPass123!')
check('新密码登录成功', newLogin.status === 200, newLogin.status)

const currentDeviceRefresh = await api('POST', '/api/auth/refresh', {
  body: { refreshToken: deviceA.json.data.refreshToken }
})
check('当前设备 Refresh Token 仍有效', currentDeviceRefresh.status === 200, currentDeviceRefresh.status)

const otherDeviceRefresh = await api('POST', '/api/auth/refresh', {
  body: { refreshToken: deviceB.json.data.refreshToken }
})
check('其他设备 Refresh Token 被撤销', otherDeviceRefresh.status === 401, otherDeviceRefresh.status)

const restore = await api('PATCH', '/api/profile/me/password', {
  token: newLogin.json.data.accessToken,
  body: {
    currentPassword: 'NewQaPass123!',
    newPassword: PASSWORD,
    currentRefreshToken: newLogin.json.data.refreshToken
  }
})
check('恢复原密码成功', restore.status === 200, restore.status)

section('退出登录')

const logoutRes = await api('POST', '/api/auth/logout', {
  body: { refreshToken: carolTokens.refreshToken }
})
check('退出登录返回 200', logoutRes.status === 200, logoutRes.status)
const afterLogout = await api('POST', '/api/auth/refresh', {
  body: { refreshToken: carolTokens.refreshToken }
})
check('退出后 Refresh Token 失效', afterLogout.status === 401, afterLogout.status)

writeFileSync(
  '.qa/state.json',
  JSON.stringify(
    {
      alice: { id: alice.id, uid: alice.uid, nickname: 'QA 爱丽丝' },
      bob: { id: bob.id, uid: bob.uid, nickname: 'QA 鲍勃' },
      carol: { id: carol.id, uid: carol.uid, nickname: 'QA 卡罗尔' },
      dave: { id: dave.id, uid: dave.uid, nickname: 'QA 戴夫' }
    },
    null,
    2
  )
)

summary('认证-主流程')
