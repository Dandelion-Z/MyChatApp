import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { getSession } from '../auth/session'

const DEFAULT_SOCKET_URL = 'http://localhost:3000'
// StrictMode 下 effect 会立刻卸载再挂载，延迟销毁可避免无意义的重连
const DISPOSE_DELAY_MS = 100
const MESSAGE_ACK_TIMEOUT_MS = 10_000

export type SocketStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unauthorized'
  // 同一账号在其他位置登录，服务端主动替换了这条连接
  | 'replaced'

export type PresenceSnapshot = {
  onlineFriendIds: string[]
}

export type ChatMessage = {
  id: string
  messageId: string
  senderId: string
  receiverId: string
  content: string
  createdAt: string
}

export type SendMessageInput = {
  toUserId: string
  messageId: string
  content: string
}

export type SendMessageAck =
  { ok: true; message: ChatMessage } | { ok: false; code: string; message: string }

type StatusListener = (status: SocketStatus) => void
type PresenceListener = (snapshot: PresenceSnapshot | null) => void
type MessageListener = (message: ChatMessage) => void

let socket: Socket | null = null
let status: SocketStatus = 'idle'
let refCount = 0
let disposeTimer: ReturnType<typeof setTimeout> | null = null
let presenceSnapshot: PresenceSnapshot | null = null
const statusListeners = new Set<StatusListener>()
const presenceListeners = new Set<PresenceListener>()
const messageListeners = new Set<MessageListener>()

function notifyStatus(nextStatus: SocketStatus): void {
  status = nextStatus

  for (const listener of statusListeners) {
    listener(nextStatus)
  }
}

function notifyPresence(snapshot: PresenceSnapshot | null): void {
  presenceSnapshot = snapshot

  for (const listener of presenceListeners) {
    listener(snapshot)
  }
}

function notifyMessage(message: ChatMessage): void {
  for (const listener of messageListeners) {
    listener(message)
  }
}

function parseChatMessage(payload: unknown): ChatMessage | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }

  const value = payload as Record<string, unknown>

  if (
    typeof value.id !== 'string' ||
    typeof value.messageId !== 'string' ||
    typeof value.senderId !== 'string' ||
    typeof value.receiverId !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return null
  }

  return {
    id: value.id,
    messageId: value.messageId,
    senderId: value.senderId,
    receiverId: value.receiverId,
    content: value.content,
    createdAt: value.createdAt
  }
}

function isSendMessageAck(payload: unknown): payload is SendMessageAck {
  if (typeof payload !== 'object' || payload === null) {
    return false
  }

  const value = payload as Record<string, unknown>

  if (value.ok === true) {
    return parseChatMessage(value.message) !== null
  }

  if (value.ok === false) {
    return typeof value.code === 'string' && typeof value.message === 'string'
  }

  return false
}

function parsePresenceSnapshot(payload: unknown): PresenceSnapshot | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }

  const ids = (payload as { onlineFriendIds?: unknown }).onlineFriendIds

  if (!Array.isArray(ids)) {
    return null
  }

  return {
    onlineFriendIds: ids.filter((id): id is string => typeof id === 'string')
  }
}

function getSocketUrl(): string {
  const baseUrl = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_SOCKET_URL
  return baseUrl.replace(/\/+$/, '')
}

function createSocket(): Socket {
  const instance = io(getSocketUrl(), {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    // 每次握手都重新读取当前 Session，避免使用创建连接时的旧 Token
    auth: (callback) => {
      const session = getSession()
      callback({ token: session?.accessToken ?? '' })
    }
  })

  instance.on('connect', () => {
    notifyStatus('connected')
  })

  // 被其他登录替换：先标记，再断开，确保不被 disconnect 处理器覆盖成普通断开
  let replacedByOtherSession = false

  instance.on('session:replaced', () => {
    replacedByOtherSession = true
    notifyPresence(null)
    // 服务端已断开旧连接，这里同时停止自动重连，避免旧客户端反复顶掉新客户端
    instance.io.reconnection(false)
    instance.disconnect()
    notifyStatus('replaced')
  })

  instance.on('disconnect', () => {
    notifyPresence(null)

    // 认证失败/被替换时保持专用状态，不要被普通断开覆盖
    if (status === 'unauthorized' || replacedByOtherSession) {
      return
    }

    notifyStatus('disconnected')
  })

  instance.on('connect_error', (error) => {
    notifyPresence(null)

    if (error.message === 'unauthorized') {
      // 身份认证失败：停止自动重连，避免用无效 Token 无限尝试
      notifyStatus('unauthorized')
      instance.io.reconnection(false)
      instance.disconnect()
      return
    }

    // 网络错误：交给 Socket.IO 自动重连
    notifyStatus('disconnected')
  })

  instance.on('presence:snapshot', (payload: unknown) => {
    const snapshot = parsePresenceSnapshot(payload)

    if (snapshot) {
      notifyPresence(snapshot)
    }
  })

  instance.on('message:new', (payload: unknown) => {
    const message = parseChatMessage(payload)

    if (message) {
      notifyMessage(message)
    }
  })

  instance.io.on('reconnect_attempt', () => {
    if (status !== 'unauthorized' && status !== 'replaced') {
      notifyStatus('connecting')
    }
  })

  return instance
}

/** 建立连接（引用计数，重复调用不会创建多个 Socket） */
export function connectSocket(): void {
  if (disposeTimer !== null) {
    clearTimeout(disposeTimer)
    disposeTimer = null
  }

  refCount += 1

  if (!socket) {
    socket = createSocket()
  }

  // 认证失败后不再自动尝试，等待下一次登录建立新连接
  if (status === 'unauthorized') {
    return
  }

  notifyStatus('connecting')
  socket.connect()
}

/** 断开连接（引用计数归零后延迟销毁，兼容 StrictMode） */
export function disconnectSocket(): void {
  refCount = Math.max(0, refCount - 1)

  if (refCount > 0) {
    return
  }

  if (disposeTimer !== null) {
    clearTimeout(disposeTimer)
  }

  disposeTimer = setTimeout(() => {
    disposeTimer = null

    if (refCount > 0) {
      return
    }

    if (socket) {
      socket.removeAllListeners()
      socket.disconnect()
      socket = null
    }

    notifyPresence(null)
    notifyStatus('idle')
  }, DISPOSE_DELAY_MS)
}

export function getSocketStatus(): SocketStatus {
  return status
}

export function subscribeSocketStatus(listener: StatusListener): () => void {
  statusListeners.add(listener)
  listener(status)

  return () => {
    statusListeners.delete(listener)
  }
}

/** 请求在线好友快照；未连接时清空本地快照 */
export function requestPresenceSnapshot(): void {
  if (!socket || !socket.connected || status !== 'connected') {
    notifyPresence(null)
    return
  }

  socket.emit('presence:get')
} /**
 * Access Token 刷新成功后重建连接。
 *
 * 服务端会在握手所用 Token 到期时主动断开 Socket，因此在刷新后用新 Token
 * 重新握手，保持在线状态与消息补拉机制不变。
 */
export function refreshSocketAuth(): void {
  if (!socket) {
    return
  }

  const wasUnauthorized = status === 'unauthorized'

  if (wasUnauthorized) {
    // 之前因 Token 失效停止了自动重连，刷新成功后恢复
    socket.io.reconnection(true)
  }

  if (socket.connected) {
    notifyStatus('connecting')
    socket.disconnect()
    socket.connect()
    return
  }

  if (wasUnauthorized) {
    notifyStatus('connecting')
    socket.connect()
  }
}

export function getPresenceSnapshot(): PresenceSnapshot | null {
  return presenceSnapshot
}

export function subscribePresence(listener: PresenceListener): () => void {
  presenceListeners.add(listener)
  listener(presenceSnapshot)

  return () => {
    presenceListeners.delete(listener)
  }
}

/** 订阅接收方的新消息事件；返回取消订阅函数 */
export function subscribeMessages(listener: MessageListener): () => void {
  messageListeners.add(listener)

  return () => {
    messageListeners.delete(listener)
  }
}

/**
 * 发送消息并等待服务端 ACK。
 *
 * 不生成新的 messageId；断线/超时后重试必须由调用方复用原 messageId。
 */
export function sendChatMessage(input: SendMessageInput): Promise<SendMessageAck> {
  const activeSocket = socket

  if (!activeSocket || !activeSocket.connected || status !== 'connected') {
    return Promise.resolve({
      ok: false,
      code: 'DISCONNECTED',
      message: '当前未连接到服务器，请稍后重试'
    })
  }

  return new Promise((resolve) => {
    let settled = false

    const finish = (result: SendMessageAck): void => {
      if (settled) {
        return
      }

      settled = true
      activeSocket.off('disconnect', onDisconnect)
      resolve(result)
    }

    const onDisconnect = (): void => {
      finish({
        ok: false,
        code: 'DISCONNECTED',
        message: '连接已断开，请重试（请复用同一 messageId）'
      })
    }

    activeSocket.once('disconnect', onDisconnect)

    activeSocket
      .timeout(MESSAGE_ACK_TIMEOUT_MS)
      .emit('message:send', input, (error: Error | null, response: unknown) => {
        activeSocket.off('disconnect', onDisconnect)

        if (settled) {
          return
        }

        if (error) {
          finish({
            ok: false,
            code: 'TIMEOUT',
            message: '发送确认超时，请重试（请复用同一 messageId）'
          })
          return
        }

        if (!isSendMessageAck(response)) {
          finish({
            ok: false,
            code: 'INVALID_ACK',
            message: '服务器返回了无法识别的发送结果'
          })
          return
        }

        finish(response)
      })
  })
}
