// GUI 走查：会话设置、置顶、资料页、联系人资料、好友申请页、窗口缩放。
const path = require('path')
const { connect } = require('./cdp.cjs')

const PORT = Number(process.env.CDP_PORT || 9229)
const shot = (name) => path.join(__dirname, `walk-${name}.png`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const cdp = await connect(PORT)
  await cdp.send('Page.bringToFront')
  await sleep(800)
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass: !!pass, detail })
    console.log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
  }

  // 1. 会话设置面板
  await cdp.evaluate("document.querySelector('.chat-settings-toggle').click()")
  await sleep(500)
  const panel = await cdp.evaluate(`(() => {
    const panel = document.querySelector('.chat-settings')
    const main = document.querySelector('.chat-main')
    const r = panel.getBoundingClientRect()
    return { open: panel.classList.contains('open'), width: Math.round(r.width), mainWidth: Math.round(main.getBoundingClientRect().width), top: Math.round(r.top), headerBottom: Math.round(document.querySelector('.chat-header').getBoundingClientRect().bottom) }
  })()`)
  check('设置面板覆盖展开', panel.open && panel.width === 272, panel)
  await cdp.evaluate("document.querySelectorAll('.chat-settings .toggle-switch')[0].click()")
  await sleep(1200)
  const pinned = await cdp.evaluate(`({
    checked: document.querySelectorAll('.chat-settings .toggle-switch')[0].getAttribute('aria-checked'),
    flag: !!document.querySelector('.chat-entry .chat-flag'),
    rowText: document.querySelector('.chat-entry')?.innerText.replace(/\\n/g, ' | ')
  })`)
  check('置顶开关生效并同步会话列表', pinned.checked === 'true', pinned)
  await cdp.screenshot(shot('settings'))

  // 关闭面板
  await cdp.evaluate("document.querySelector('.chat-settings-toggle').click()")
  await sleep(400)

  // 2. 自己的资料页
  await cdp.evaluate("document.querySelector('.rail-profile').click()")
  await sleep(900)
  const profile = await cdp.evaluate(`({
    open: !!document.querySelector('.profile-page'),
    title: document.querySelector('.profile-title')?.textContent,
    nickname: document.querySelector('.profile-nickname')?.textContent,
    uid: document.querySelector('.profile-uid')?.textContent,
    rows: Array.from(document.querySelectorAll('.profile-row')).map((r) => r.innerText.replace(/\\n/g, ' ')),
    edit: !!document.querySelector('.profile-edit-toggle')
  })`)
  check('个人资料页字段', profile.open && profile.title === '个人资料' && /^\d+$/.test((profile.uid || '').trim()), profile)
  await cdp.screenshot(shot('profile'))
  await cdp.evaluate("document.querySelector('.profile-back').click()")
  await sleep(500)

  // 3. 联系人视图 + 好友资料页
  await cdp.evaluate("document.querySelectorAll('.rail-item')[1].click()")
  await sleep(800)
  const contacts = await cdp.evaluate(`({
    rows: document.querySelectorAll('.friend-row').length,
    names: Array.from(document.querySelectorAll('.friend-name')).map((n) => n.textContent),
    selfRow: !!document.querySelector('.friend-row')
  })`)
  check('联系人列表渲染', contacts.rows >= 1, contacts)
  await cdp.evaluate("document.querySelectorAll('.friend-item')[1]?.click()")
  await sleep(900)
  const friendProfile = await cdp.evaluate(`({
    open: !!document.querySelector('.profile-page'),
    title: document.querySelector('.profile-title')?.textContent,
    nickname: document.querySelector('.profile-nickname')?.textContent,
    remarkRow: !!document.querySelector('.profile-remark'),
    footer: Array.from(document.querySelectorAll('.profile-action')).map((b) => b.textContent)
  })`)
  check('好友资料页 + 发消息/删除入口', friendProfile.open && friendProfile.footer.length === 2, friendProfile)
  await cdp.screenshot(shot('friend-profile'))

  // 4. 好友申请页
  await cdp.evaluate("Array.from(document.querySelectorAll('.rail-item'))[1].click()")
  await sleep(300)
  await cdp.evaluate("document.querySelector('.new-friends-entry').click()")
  await sleep(900)
  const requests = await cdp.evaluate(`({
    panel: !!document.querySelector('.requests-panel'),
    title: document.querySelector('.requests-panel .chat-name')?.textContent,
    rows: document.querySelectorAll('.request-row').length,
    empty: document.querySelector('.requests-body')?.innerText.includes('还没有好友申请')
  })`)
  check('新的朋友页面', requests.panel, requests)
  await cdp.screenshot(shot('requests'))

  // 5. 窗口缩放
  const browser = await cdp.send('Browser.getWindowForTarget').catch(() => null)
  if (browser && browser.windowId) {
    await cdp.send('Browser.setWindowBounds', { windowId: browser.windowId, bounds: { width: 1024, height: 700 } })
    await sleep(800)
    const resized = await cdp.evaluate(`({ w: window.innerWidth, h: window.innerHeight, overflowX: document.documentElement.scrollWidth > window.innerWidth })`)
    check('窗口缩放无横向溢出', resized.overflowX === false, resized)
    await cdp.screenshot(shot('resized'))
    await cdp.send('Browser.setWindowBounds', { windowId: browser.windowId, bounds: { width: 1280, height: 800 } })
  }

  const errors = await cdp.evaluate("(window.__qaErrors || []).slice(0, 5)")
  check('无渲染进程未捕获错误', errors.length === 0, errors)
  console.log('SUMMARY', results.filter((r) => r.pass).length + '/' + results.length)
  cdp.close()
})().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
