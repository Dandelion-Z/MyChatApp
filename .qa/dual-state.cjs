// 读取指定客户端当前的会话列表 / 未读 / 聊天头部 / 气泡，用于双端断言。
const path = require('path')
const { connect } = require('./cdp.cjs')

const PORT = Number(process.env.CDP_PORT || 9229)
const SHOT = process.env.SHOT || path.join(__dirname, `state-${PORT}.png`)

;(async () => {
  const cdp = await connect(PORT)
  const info = await cdp.evaluate(`({
    entries: Array.from(document.querySelectorAll('.chat-entry')).map((e) => ({
      text: e.innerText.replace(/\\n/g, ' | '),
      active: e.classList.contains('active'),
      badge: e.querySelector('.badge')?.textContent ?? null
    })),
    railBadge: document.querySelectorAll('.rail-item')[0]?.querySelector('.badge')?.textContent ?? null,
    header: document.querySelector('.chat-name')?.textContent ?? null,
    online: !!document.querySelector('.chat-online-dot'),
    bubbles: Array.from(document.querySelectorAll('.bubble')).slice(-2).map((b) => b.innerText),
    contacts: Array.from(document.querySelectorAll('.friend-name')).map((n) => n.textContent)
  })`)
  console.log(JSON.stringify(info, null, 1))
  await cdp.screenshot(SHOT)
  cdp.close()
})().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
