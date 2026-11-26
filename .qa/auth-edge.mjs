import { api, check, login, register, section, summary } from './lib.mjs'

section('注册与登录参数校验')

const badName = await register('ab', '短')
check('非法用户名返回 400', badName.status === 400 && badName.json?.success === false, badName.status)

const badPwd = await api('POST', '/api/auth/register', {
  body: { username: 'qa_shortpwd', password: 'short', nickname: '短密码' }
})
check('过短密码返回 400', badPwd.status === 400, badPwd.status)

const badNickname = await api('POST', '/api/auth/register', {
  body: { username: 'qa_badnick', password: 'QaTestPass123!', nickname: '   ' }
})
check('空白昵称返回 400', badNickname.status === 400, badNickname.status)

const unknown = await login('qa_nobody')
check('不存在用户登录返回 401', unknown.status === 401, unknown.status)

const emptyLogin = await api('POST', '/api/auth/login', { body: {} })
check('空登录参数返回 400', emptyLogin.status === 400, emptyLogin.status)

const refreshNoBody = await api('POST', '/api/auth/refresh', { body: {} })
check('缺少 refreshToken 返回 400', refreshNoBody.status === 400, refreshNoBody.status)

const refreshBad = await api('POST', '/api/auth/refresh', { body: { refreshToken: 'nope' } })
check('非法 refreshToken 返回 401', refreshBad.status === 401, refreshBad.status)

summary('认证-参数校验')
