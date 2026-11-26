const path = require('path')
const { connect } = require('./cdp.cjs')

const PORT = Number(process.env.CDP_PORT || 9229)
const USER = process.env.QA_USER || 'qa_alice'
const PASSWORD = process.env.QA_PASS || 'QaTestPass123!'
const SHOT = process.env.SHOT || path.join(__dirname, 'gui-login.png')

;(async () => {
  const cdp = await connect(PORT)
  const state = await cdp.evaluate(`({
    hasLogin: !!document.querySelector('input[type=password]'),
    title: document.title,
    text: document.body.innerText.slice(0, 120)
  })`)
  console.log('initial', JSON.stringify(state))
  if (!state.hasLogin) {
    console.log('already logged in')
    return cdp.close()
  }
  await cdp.evaluate(`(() => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(document.querySelector('input[placeholder="用户名"]'), ${JSON.stringify(USER)})
    setValue(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
    Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '登录').click()
    return 'submitted'
  })()`)
  const ok = await cdp.waitFor("!!document.querySelector('.rail')", 20000)
  console.log('logged-in:', ok)
  await new Promise((r) => setTimeout(r, 2500))
  await cdp.screenshot(SHOT)
  const info = await cdp.evaluate(`({
    entries: Array.from(document.querySelectorAll('.chat-entry')).map(e => e.innerText.replace(/\\n/g, ' | ')),
    contacts: document.querySelectorAll('.friend-row').length,
    rail: document.querySelector('.rail')?.innerText.replace(/\\s+/g, ' ')
  })`)
  console.log(JSON.stringify(info))
  cdp.close()
})().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
