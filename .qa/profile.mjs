/**
 * 个人资料与头像接口 QA：字段、资料更新校验、省市联动、生日/年龄、头像处理、好友资料、越权。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, BASE, check, login, PASSWORD, register, section, summary } from './lib.mjs'

const qaDir = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(qaDir, '..', 'server', 'package.json'))
const sharp = require('sharp')

const aliceLogin = await login('qa_alice')
const bobLogin = await login('qa_bob')
const aliceToken = aliceLogin.json?.data?.accessToken
const bobToken = bobLogin.json?.data?.accessToken
const aliceId = aliceLogin.json?.data?.user?.id

section('资料字段')

const me = await api('GET', '/api/profile/me', { token: aliceToken })
const profile = me.json?.data
check('读取自己资料 200', me.status === 200, me.status)
check(
  '资料字段完整',
  [
    'id',
    'uid',
    'nickname',
    'signature',
    'countryCode',
    'provinceCode',
    'cityCode',
    'gender',
    'birthDate',
    'age',
    'level',
    'activityPoints',
    'avatarUrl'
  ].every((key) => key in (profile ?? {})),
  Object.keys(profile ?? {})
)
check('资料不包含 username/密码', !me.text.includes('username') && !me.text.includes('password'))

const options = await api('GET', '/api/profile/options', { token: aliceToken })
const optionsData = options.json?.data
check('国家选项 250 个', optionsData?.countries?.length === 250, optionsData?.countries?.length)
check('省级选项 34 个', optionsData?.provinces?.length === 34, optionsData?.provinces?.length)
check(
  '地级市共 337 个',
  optionsData?.provinces?.reduce((sum, province) => sum + province.cities.length, 0) === 337
)
const cn = optionsData?.countries?.find((country) => country.code === 'CN')
check('国家包含中英文名', cn?.name === '中国' && cn?.nameEn === 'China', {
  name: cn?.name,
  nameEn: cn?.nameEn
})
check(
  '选项包含数据版本',
  Boolean(optionsData?.versions?.country?.version && optionsData?.versions?.region?.version)
)

section('资料更新校验')

const patch = (body, token = aliceToken) => api('PATCH', '/api/profile/me', { token, body })

const unknownField = await patch({ userId: '1' })
check('禁止修改 userId 等未知字段 400', unknownField.status === 400, unknownField.status)

const emptyPatch = await patch({})
check('空 PATCH 返回 400', emptyPatch.status === 400, emptyPatch.status)

const badNickname = await patch({ nickname: '   ' })
check('空白昵称 400', badNickname.status === 400, badNickname.status)

const longSignature = await patch({ signature: '😀'.repeat(51) })
check('超长签名 400', longSignature.status === 400, longSignature.status)

const badCountry = await patch({ countryCode: 'ZZ' })
check('非法国家代码 400', badCountry.status === 400, badCountry.status)

const badCity = await patch({ countryCode: 'CN', provinceCode: '130000', cityCode: '440300' })
check('城市不属于省份 400', badCity.status === 400, badCity.status)

const provinceWithoutCn = await patch({ countryCode: 'US', provinceCode: '130000' })
check('非中国不允许填写省市 400', provinceWithoutCn.status === 400, provinceWithoutCn.status)

const badBirthday = await patch({ birthDate: '2026-02-30' })
check('不存在的日期 400', badBirthday.status === 400, badBirthday.status)

const futureBirthday = await patch({ birthDate: '2999-01-01' })
check('未来日期 400', futureBirthday.status === 400, futureBirthday.status)

const badGender = await patch({ gender: 'unknown' })
check('非法性别 400', badGender.status === 400, badGender.status)

const changeUid = await patch({ uid: '10001' })
check('UID 不允许修改 400', changeUid.status === 400, changeUid.status)
check('UID 注入式取值 400', (await patch({ uid: "10001' OR '1'='1" })).status === 400)

section('资料更新成功')

const updated = await patch({
  nickname: 'QA 爱丽丝',
  signature: '永夜 QA 签名 😀',
  countryCode: 'cn',
  provinceCode: '130000',
  cityCode: '130100',
  gender: 'female',
  birthDate: '1995-06-15'
})
const updatedProfile = updated.json?.data
check('合法资料更新 200', updated.status === 200, updated.status)
check('国家代码归一为大写 CN', updatedProfile?.countryCode === 'CN', updatedProfile?.countryCode)
check(
  '省市保存成功',
  updatedProfile?.provinceCode === '130000' && updatedProfile?.cityCode === '130100'
)
check(
  '生日以 YYYY-MM-DD 返回',
  updatedProfile?.birthDate === '1995-06-15',
  updatedProfile?.birthDate
)
check('年龄按服务端计算', updatedProfile?.age === 31, updatedProfile?.age)

const leap = await patch({ birthDate: '2000-02-29' })
check(
  '闰年生日可保存且年龄正确',
  leap.status === 200 && leap.json?.data?.birthDate === '2000-02-29' && leap.json?.data?.age === 26,
  { status: leap.status, birthDate: leap.json?.data?.birthDate, age: leap.json?.data?.age }
)

const switchCountry = await patch({ countryCode: 'US' })
check(
  '切换国家清空省市',
  switchCountry.status === 200 &&
    switchCountry.json?.data?.provinceCode === null &&
    switchCountry.json?.data?.cityCode === null,
  switchCountry.json?.data
)

const cleared = await patch({
  signature: null,
  countryCode: null,
  provinceCode: null,
  cityCode: null,
  gender: null,
  birthDate: null
})
check(
  '可清空全部可选字段',
  cleared.status === 200 &&
    cleared.json?.data?.signature === null &&
    cleared.json?.data?.countryCode === null &&
    cleared.json?.data?.age === null,
  cleared.json?.data
)

section('好友资料')

// 确保 alice 与 bob 是好友
const bobUid = (await api('GET', '/api/profile/me', { token: bobToken })).json?.data?.uid
let alreadyFriends = (await api('GET', '/api/friends', { token: aliceToken })).json?.friends?.some(
  (friend) => friend.id === bobLogin.json?.data?.user?.id
)

if (!alreadyFriends) {
  await api('POST', '/api/friends/requests', { token: aliceToken, body: { uid: bobUid } })
  const requests =
    (await api('GET', '/api/friends/requests', { token: bobToken })).json?.requests ?? []
  const incoming = requests.find((item) => item.direction === 'incoming')
  if (incoming) {
    await api('POST', `/api/friends/requests/${incoming.id}/accept`, { token: bobToken })
  }
}

const bobId = bobLogin.json?.data?.user?.id
const friendProfile = await api('GET', `/api/profile/${bobId}`, { token: aliceToken })
check('读取好友资料 200', friendProfile.status === 200, friendProfile.status)
check('好友资料包含 remark 字段', 'remark' in (friendProfile.json?.data ?? {}))
check('好友资料不包含 username', !friendProfile.text.includes('username'))

await api('PATCH', `/api/friends/${bobId}/remark`, {
  token: aliceToken,
  body: { remark: 'QA 备注' }
})
const friendWithRemark = await api('GET', `/api/profile/${bobId}`, { token: aliceToken })
check(
  '好友资料返回备注',
  friendWithRemark.json?.data?.remark === 'QA 备注',
  friendWithRemark.json?.data?.remark
)
await api('PATCH', `/api/friends/${bobId}/remark`, { token: aliceToken, body: { remark: null } })

const stranger = await register('qa_prof_x', 'QA 陌生人')
check('注册陌生人 201', stranger.status === 201, stranger.status)
const strangerLogin = await login('qa_prof_x')
const strangerId = strangerLogin.json?.data?.user?.id
const strangerProfile = await api('GET', `/api/profile/${strangerId}`, { token: aliceToken })
check('非好友资料 404', strangerProfile.status === 404, strangerProfile.status)
check(
  '非法用户 ID 400',
  (await api('GET', '/api/profile/abc', { token: aliceToken })).status === 400
)

section('头像')

async function upload(buffer, filename, type = 'image/png') {
  const form = new FormData()
  form.append('avatar', new Blob([buffer], { type }), filename)
  const response = await fetch(`${BASE}/api/profile/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: form
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null, text }
}

const horizontal = await sharp({
  create: { width: 600, height: 400, channels: 3, background: '#ff8800' }
})
  .png()
  .toBuffer()
const uploaded = await upload(horizontal, 'h.png')
const avatarUrl = uploaded.json?.data?.avatarUrl
check('上传合法 PNG 200', uploaded.status === 200, uploaded.status)
check(
  '返回 /uploads/avatars/*.webp 地址',
  /^\/uploads\/avatars\/[a-z0-9-]+\.webp$/.test(avatarUrl ?? ''),
  avatarUrl
)

if (avatarUrl) {
  const fileResponse = await fetch(BASE + avatarUrl)
  const bytes = Buffer.from(await fileResponse.arrayBuffer())
  const metadata = await sharp(bytes).metadata()
  check(
    '静态头像可访问且为 WebP',
    fileResponse.status === 200 && fileResponse.headers.get('content-type') === 'image/webp',
    {
      status: fileResponse.status,
      type: fileResponse.headers.get('content-type')
    }
  )
  check('横图按比例缩小到 512 宽', metadata.width === 512 && metadata.height === 341, {
    width: metadata.width,
    height: metadata.height
  })
  check(
    '静态响应带长期缓存头',
    (fileResponse.headers.get('cache-control') ?? '').includes('immutable'),
    fileResponse.headers.get('cache-control')
  )

  const friends = await api('GET', '/api/friends', { token: aliceToken })
  const selfInBobList = await api('GET', '/api/friends', { token: bobToken })
  check(
    '好友列表返回本人头像',
    selfInBobList.json?.friends?.some((friend) => friend.avatarUrl === avatarUrl),
    selfInBobList.json?.friends?.map((friend) => friend.avatarUrl)
  )

  const friendView = await api('GET', `/api/profile/${aliceId}`, { token: bobToken })
  check(
    '好友资料返回本人头像',
    friendView.json?.data?.avatarUrl === avatarUrl,
    friendView.json?.data?.avatarUrl
  )
}

const vertical = await sharp({
  create: { width: 300, height: 600, channels: 3, background: '#0088ff' }
})
  .png()
  .toBuffer()
const verticalUpload = await upload(vertical, 'v.png')
const verticalUrl = verticalUpload.json?.data?.avatarUrl
if (verticalUrl) {
  const bytes = Buffer.from(await (await fetch(BASE + verticalUrl)).arrayBuffer())
  const metadata = await sharp(bytes).metadata()
  check('竖图按比例缩小到 512 高', metadata.width === 256 && metadata.height === 512, {
    width: metadata.width,
    height: metadata.height
  })
}

const small = await sharp({
  create: { width: 300, height: 200, channels: 3, background: '#22aa66' }
})
  .png()
  .toBuffer()
const smallUpload = await upload(small, 'small.png')
const smallUrl = smallUpload.json?.data?.avatarUrl
if (smallUrl) {
  const bytes = Buffer.from(await (await fetch(BASE + smallUrl)).arrayBuffer())
  const metadata = await sharp(bytes).metadata()
  check('小尺寸图片不放大', metadata.width === 300 && metadata.height === 200, {
    width: metadata.width,
    height: metadata.height
  })
}

const gif = Buffer.from('GIF89a' + '\u0000'.repeat(20), 'binary')
const gifUpload = await upload(gif, 'a.gif', 'image/gif')
check('拒绝 GIF 400', gifUpload.status === 400, gifUpload.status)

const tiny = await sharp({
  create: { width: 127, height: 200, channels: 3, background: '#000000' }
})
  .png()
  .toBuffer()
const tinyUpload = await upload(tiny, 'tiny.png')
check('短边小于 128 拒绝 400', tinyUpload.status === 400, tinyUpload.status)

const corrupt = Buffer.from('not an image')
const corruptUpload = await upload(corrupt, 'x.png')
check('损坏图片拒绝 400', corruptUpload.status === 400, corruptUpload.status)

const big = Buffer.alloc(6 * 1024 * 1024, 1)
const bigUpload = await upload(big, 'big.png')
check('超过 5MB 拒绝 400', bigUpload.status === 400, bigUpload.status)

const deleted = await api('DELETE', '/api/profile/me/avatar', { token: aliceToken })
check(
  '删除头像 200 且 avatarUrl 为 null',
  deleted.status === 200 && deleted.json?.data?.avatarUrl === null
)
if (avatarUrl) {
  const gone = await fetch(BASE + avatarUrl)
  check('删除后文件不可访问', gone.status === 404, gone.status)
}

const noFile = await fetch(`${BASE}/api/profile/me/avatar`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${aliceToken}` },
  body: new FormData()
})
check('缺少文件返回 400', noFile.status === 400, noFile.status)

section('权限')

check('未登录读取自己资料 401', (await api('GET', '/api/profile/me')).status === 401)
check('未登录读取好友资料 401', (await api('GET', `/api/profile/${bobId}`)).status === 401)
check(
  '未登录修改资料 401',
  (await api('PATCH', '/api/profile/me', { body: { nickname: 'x' } })).status === 401
)
check(
  '未登录上传头像 401',
  (await api('POST', '/api/profile/me/avatar', { token: '' })).status === 401
)

const loginInjection = await api('POST', '/api/auth/login', {
  body: { username: "' OR 1=1 --", password: PASSWORD }
})
check(
  '登录不接受注入式用户名',
  loginInjection.status === 400 || loginInjection.status === 401,
  loginInjection.status
)

const preflight = await fetch(`${BASE}/api/profile/me`, {
  method: 'OPTIONS',
  headers: {
    Origin: 'http://localhost:5173',
    'Access-Control-Request-Method': 'PATCH',
    'Access-Control-Request-Headers': 'authorization,content-type'
  }
})
const allowMethods = preflight.headers.get('access-control-allow-methods') ?? ''
check(
  'CORS 预检允许 PATCH/PUT',
  preflight.status < 400 && allowMethods.includes('PATCH') && allowMethods.includes('PUT'),
  { status: preflight.status, allowMethods }
)

const traversal = await fetch(`${BASE}/uploads/avatars/..%2f..%2fserver%2f.env`)
check('头像静态路由拒绝路径穿越', traversal.status === 404, traversal.status)

summary('个人资料')
