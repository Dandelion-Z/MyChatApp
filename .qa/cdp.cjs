// 极简 CDP 客户端：连接已启动的 Electron 调试端口，提供 evaluate/waitFor/screenshot。
const fs = require('fs')

function connect(port = 9222) {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .then((list) => {
        const page = list.find((item) => item.type === 'page')
        if (!page) throw new Error('no page target')
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        let id = 0
        const pending = new Map()
        const api = {
          send(method, params = {}) {
            return new Promise((res, rej) => {
              const messageId = ++id
              pending.set(messageId, { res, rej })
              socket.send(JSON.stringify({ id: messageId, method, params }))
            })
          },
          async evaluate(expression) {
            const result = await api.send('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true
            })
            if (result.exceptionDetails) {
              throw new Error(
                result.exceptionDetails.exception?.description || 'evaluate failed'
              )
            }
            return result.result.value
          },
          async waitFor(expression, timeoutMs = 10000) {
            const started = Date.now()
            while (Date.now() - started < timeoutMs) {
              const value = await api.evaluate(expression).catch(() => false)
              if (value) return true
              await new Promise((r) => setTimeout(r, 120))
            }
            return false
          },
          async screenshot(path) {
            const result = await api.send('Page.captureScreenshot', { format: 'png' })
            fs.writeFileSync(path, Buffer.from(result.data, 'base64'))
          },
          close() {
            socket.close()
          }
        }
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.id && pending.has(message.id)) {
            const { res, rej } = pending.get(message.id)
            pending.delete(message.id)
            if (message.error) rej(new Error(message.error.message))
            else res(message.result)
          }
        }
        socket.onerror = () => reject(new Error('cdp socket error'))
        socket.onopen = () => resolve(api)
      })
      .catch(reject)
  })
}

module.exports = { connect }
