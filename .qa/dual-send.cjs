// 双端消息测试：在指定客户端打开与对方的会话，输入并发送一条消息。
const path = require('path')
const { connect } = require('./cdp.cjs')

const PORT = Number(process.env.CDP_PORT || 9230)
const TEXT = process.env.MSG || '双端实时测试消息'
const SHOT = process.env.SHOT || path.join(__dirname, `dual-${PORT}.png`)

;(async () => {
  const cdp = await connect(PORT)
  const opened = await cdp.evaluate(`(() => {
    const row = document.querySelector('.chat-entry')
    if (!row) return 'no-entry'
    row.click()
    return 'opened'
  })()`)
  console.log('open:', opened)
  const ready = await cdp.waitFor("!!document.querySelector('.composer-input')", 8000)
  console.log('composer:', ready)
  if (!ready) return cdp.close()

  const sent = await cdp.evaluate(`(() => {
    const input = document.querySelector('.composer-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(TEXT)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'sent'
  })()`)
  console.log('send:', sent)
  await new Promise((r) => setTimeout(r, 1800))
  await cdp.screenshot(SHOT)
  const info = await cdp.evaluate(`({
    bubbles: Array.from(document.querySelectorAll('.bubble')).slice(-3).map(b => b.innerText),
    header: document.querySelector('.chat-name')?.textContent
  })`)
  console.log(JSON.stringify(info))
  cdp.close()
})().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
