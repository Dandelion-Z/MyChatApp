import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'
import { api, check, login, section, summary } from './lib.mjs'

const aliceLogin = await login('qa_alice')
const bobLogin = await login('qa_bob')
const A = aliceLogin.json.data.accessToken
const B = bobLogin.json.data.accessToken

const socket = await new Promise((resolve, reject) => {
  const s = io('http://127.0.0.1:3000', {
    auth: { token: B },
    transports: ['websocket'],
    reconnection: false
  })
  s.on('connect', () => resolve(s))
  s.on('connect_error', reject)
})

const send = (payload) =>
  new Promise((resolve) => socket.emit('message:send', payload, (response) => resolve(response)))

const first = await send({ toUserId: aliceLogin.json.data.user.id, messageId: randomUUID(), content: '重启前消息一' })
const second = await send({ toUserId: aliceLogin.json.data.user.id, messageId: randomUUID(), content: '重启前消息二' })
check('重启前发送两条消息成功', first.ok === true && second.ok === true)

const before = await api('GET', `/api/messages/${aliceLogin.json.data.user.id}`, { token: B })
check('重启前历史可读', before.json.data.messages.length >= 2, before.json.data.messages.length)

writeFileSync(
  '.qa/persist.json',
  JSON.stringify(
    {
      aliceId: aliceLogin.json.data.user.id,
      bobId: bobLogin.json.data.user.id,
      count: before.json.data.messages.length,
      lastId: second.message.id
    },
    null,
    2
  )
)

socket.close()
summary('重启前准备')
