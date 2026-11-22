import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from '../api/client'
import { addFriend, getFriends, removeFriend } from '../api/friends'
import type { Friend } from '../api/friends'
import { getMessageHistory } from '../api/messages'
import type { MessageItem } from '../api/messages'
import { useAuth } from '../auth/AuthContext'
import {
  connectSocket,
  disconnectSocket,
  getSocketStatus,
  requestPresenceSnapshot,
  sendChatMessage,
  subscribeMessages,
  subscribePresence,
  subscribeSocketStatus
} from '../socket/socketClient'
import type { SocketStatus } from '../socket/socketClient'

type MessageStatus = 'sending' | 'sent' | 'failed'

type ChatMessage = {
  /** 客户端生成的 UUID，服务端以此做幂等去重 */
  messageId: string
  text: string
  /** 服务端 createdAt；本地待发送消息使用本地时间占位 */
  createdAt: string
  mine: boolean
  status: MessageStatus
  /** 发送失败时的提示文案 */
  error?: string
  /** 服务端自增主键，只用于同一毫秒内按服务端顺序兜底排序；本地待发送消息没有 */
  serverId?: string
}

type ListStatus = 'loading' | 'ready' | 'error'
type HistoryStatus = 'loading' | 'ready' | 'error'

/** 历史分页状态，按 friendId 隔离 */
type PaginationState = {
  hasMore: boolean
  nextCursor: string | null
  loadingMore: boolean
  /** 加载更早消息失败时的提示；成功后清空 */
  error: string
}

const AVATAR_COLORS = ['#4f7cf7', '#ef8b4a', '#2fb3a3', '#9a6ff2']
const MESSAGE_PAGE_SIZE = 30

function getAvatarText(friend: Friend): string {
  return (friend.nickname.trim().charAt(0) || friend.username.charAt(0) || '?').toUpperCase()
}

function getAvatarColor(friend: Friend): string {
  let total = 0
  for (let index = 0; index < friend.id.length; index += 1) {
    total += friend.id.charCodeAt(index)
  }
  return AVATAR_COLORS[total % AVATAR_COLORS.length]
}

function getDisplayName(friend: Friend): string {
  return friend.nickname || friend.username
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// 数据库游标是微秒精度 ISO 文本，JS Date 只认毫秒，截断多余精度再解析
function parseMessageTime(value: string): number {
  const time = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(time) ? 0 : time
}

function formatMessageTime(value: string): string {
  const time = parseMessageTime(value)
  return time === 0 ? '' : formatTime(new Date(time))
}

/**
 * 把服务端微秒时间归一化成固定宽度文本，便于精确比较。
 * 本地待发送消息只有毫秒（.123Z），补齐成 .123000Z 后仍可参与比较。
 */
function normalizeMessageTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value)

  if (!match) {
    return value
  }

  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0').slice(0, 6)}Z`
}

/** 服务端按 (created_at, id) 排序；时间完全相同时才用自增 id 兜底 */
function compareServerId(left: ChatMessage, right: ChatMessage): number {
  if (!left.serverId || !right.serverId) {
    return 0
  }

  const leftId = Number(left.serverId)
  const rightId = Number(right.serverId)

  if (!Number.isFinite(leftId) || !Number.isFinite(rightId)) {
    return 0
  }

  return leftId - rightId
}

function sortChatMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((left, right) => {
    // 用微秒文本比较，不能用 Date 毫秒：并发事务下 id 顺序可能与 created_at 顺序相反
    const leftTime = normalizeMessageTime(left.createdAt)
    const rightTime = normalizeMessageTime(right.createdAt)

    if (leftTime !== rightTime) {
      return leftTime < rightTime ? -1 : 1
    }

    return compareServerId(left, right)
  })
}

function toChatMessage(item: MessageItem, myUserId: string): ChatMessage {
  return {
    messageId: item.messageId,
    text: item.content,
    createdAt: item.createdAt,
    mine: item.senderId === myUserId,
    status: 'sent',
    serverId: item.id
  }
}

/** 合并历史消息与本地状态：按 messageId 去重，服务端结果覆盖同 ID 的本地占位 */
function mergeChatMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()

  for (const message of existing) {
    byId.set(message.messageId, message)
  }

  for (const message of incoming) {
    byId.set(message.messageId, message)
  }

  return sortChatMessages([...byId.values()])
}

/**
 * 重连补拉专用合并：历史结果不覆盖仍在发送中/发送失败的本地消息，
 * 避免把用户尚未确认的结果直接改成已发送，或丢掉可重试状态。
 */
function mergeSyncedMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()

  for (const message of existing) {
    byId.set(message.messageId, message)
  }

  for (const message of incoming) {
    const local = byId.get(message.messageId)

    if (local && local.status !== 'sent') {
      continue
    }

    byId.set(message.messageId, message)
  }

  return sortChatMessages([...byId.values()])
}

/**
 * 分页加载更早消息：服务端按时间升序返回一整页，直接前插即可保持顺序，
 * 不用客户端毫秒时间重新排序（同毫秒内会错序）。
 * 已存在的 messageId 直接跳过，因此本地 sending/failed 状态不会被覆盖。
 */
function mergeOlderMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const existingIds = new Set(existing.map((message) => message.messageId))
  const older = incoming.filter((message) => !existingIds.has(message.messageId))

  return older.length === 0 ? existing : [...older, ...existing]
}

/** 只改某个好友的分页状态，其他好友保持原样 */
function updatePagination(
  previous: Record<string, PaginationState>,
  friendId: string,
  patch: Partial<PaginationState>
): Record<string, PaginationState> {
  const current = previous[friendId] ?? {
    hasMore: false,
    nextCursor: null,
    loadingMore: false,
    error: ''
  }

  return { ...previous, [friendId]: { ...current, ...patch } }
}

function updateConversation(
  previous: Record<string, ChatMessage[]>,
  friendId: string,
  update: (list: ChatMessage[]) => ChatMessage[]
): Record<string, ChatMessage[]> {
  return { ...previous, [friendId]: update(previous[friendId] ?? []) }
}

function getAddFriendErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return '无法连接服务器，请确认后端服务已启动后重试。'
    }

    if (error.status === 500) {
      return '服务器内部错误，请稍后重试。'
    }

    // 400/404/409 等业务错误优先使用后端返回的明确文案
    return error.message
  }

  return '添加失败，请稍后重试。'
}

function getDeleteFriendErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return '无法连接服务器，请确认后端服务已启动后重试。'
    }

    if (error.status === 500) {
      return '服务器内部错误，请稍后重试。'
    }

    return error.message
  }

  return '删除失败，请稍后重试。'
}

// 与服务端 messageHandler 的限制保持一致（按 UTF-16 长度计算）
const MAX_MESSAGE_LENGTH = 2000

type ConnectionTone = 'online' | 'pending' | 'offline'

function getConnectionState(status: SocketStatus): { text: string; tone: ConnectionTone } {
  switch (status) {
    case 'connected':
      return { text: '已连接', tone: 'online' }
    case 'idle':
    case 'connecting':
      return { text: '正在连接…', tone: 'pending' }
    default:
      // disconnected / unauthorized / replaced 都表现为连接中断
      return { text: '连接中断', tone: 'offline' }
  }
}

function ChatScreen(): React.JSX.Element {
  const { user, logout, requestWithAuth } = useAuth()

  const [friends, setFriends] = useState<Friend[]>([])
  const [activeFriendId, setActiveFriendId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  // 每个好友会话的历史加载状态与错误，按好友 ID 分开保存
  const [historyStatus, setHistoryStatus] = useState<Record<string, HistoryStatus>>({})
  const [historyError, setHistoryError] = useState<Record<string, string>>({})
  // 历史分页状态（hasMore / nextCursor / loadingMore / error），按好友 ID 分开保存
  const [pagination, setPagination] = useState<Record<string, PaginationState>>({})
  // 每个好友独立保存草稿，只在内存中；切换好友互不影响
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  // 在线好友 ID 集合，只用于好友列表的绿色圆点
  const [onlineFriendIds, setOnlineFriendIds] = useState<Set<string>>(new Set())
  // 连接状态只用于界面提示，实际收发仍由 socketClient 控制
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>(getSocketStatus())

  // 添加好友表单状态
  const [addOpen, setAddOpen] = useState<boolean>(false)
  const [addUsername, setAddUsername] = useState<string>('')
  const [addSubmitting, setAddSubmitting] = useState<boolean>(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addNotice, setAddNotice] = useState<string | null>(null)
  const [addNoticeWarning, setAddNoticeWarning] = useState<boolean>(false)
  // 用 ref 做同步防重入，避免连续点击在 React 状态更新前重复提交
  const addSubmittingRef = useRef<boolean>(false)
  const isMountedRef = useRef<boolean>(true)

  // 删除好友状态
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deleteSubmittingId, setDeleteSubmittingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null)
  const [deleteNoticeWarning, setDeleteNoticeWarning] = useState<boolean>(false)
  const deleteSubmittingRef = useRef<boolean>(false)

  const messageListRef = useRef<HTMLDivElement>(null)
  // 请求序号 + AbortController：卸载或重复请求时丢弃过期结果
  const requestSeqRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  // 已成功加载过历史的好友：切回同一好友时不再重复请求
  const loadedHistoryRef = useRef<Set<string>>(new Set())
  const historyControllersRef = useRef<Map<string, AbortController>>(new Map())

  // 分页加载更早消息：同一好友的请求互斥，用 ref 做同步防重入
  const loadMoreControllersRef = useRef<Map<string, AbortController>>(new Map())
  const paginationRef = useRef<Record<string, PaginationState>>({})
  const messagesRef = useRef<Record<string, ChatMessage[]>>({})
  const activeFriendIdRef = useRef<string | null>(null)
  // 前插更早消息后要恢复的滚动位置（scrollHeight / scrollTop），按好友 ID 记录
  const scrollRestoreRef = useRef<Map<string, { height: number; top: number }>>(new Map())
  // 每次切换会话递增，用于判断分页响应是否还属于发起请求时的那次会话查看
  const activeSessionRef = useRef(0)

  // 重连补拉：以“连接代次”隔离不同连接周期的请求，旧代次结果直接丢弃
  const friendsRef = useRef<Friend[]>([])
  const listStatusRef = useRef<ListStatus>('loading')
  const syncGenerationRef = useRef(0)
  const syncAbortRef = useRef<AbortController | null>(null)
  // 当前连接周期内已经补拉成功 / 正在补拉的好友（避免重复请求）
  const syncedFriendIdsRef = useRef<Set<string>>(new Set())
  const syncingFriendIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    friendsRef.current = friends
  }, [friends])

  useEffect(() => {
    listStatusRef.current = listStatus
  }, [listStatus])

  useEffect(() => {
    paginationRef.current = pagination
  }, [pagination])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    activeFriendIdRef.current = activeFriendId
  }, [activeFriendId])

  const loadFriends = useCallback(
    async (preferredFriendId?: string): Promise<boolean> => {
      controllerRef.current?.abort()

      const controller = new AbortController()
      controllerRef.current = controller
      const seq = ++requestSeqRef.current

      setListStatus('loading')
      setListError(null)

      try {
        const list = await getFriends(requestWithAuth, controller.signal)

        // 组件已卸载或已有更新的请求：丢弃本次结果
        if (seq !== requestSeqRef.current || controller.signal.aborted) {
          return false
        }

        setFriends(list)
        setListStatus('ready')
        setActiveFriendId((previousId) => {
          // 新添加的好友优先选中；否则保留原选择；原好友不存在则选第一个
          if (preferredFriendId && list.some((friend) => friend.id === preferredFriendId)) {
            return preferredFriendId
          }
          if (previousId && list.some((friend) => friend.id === previousId)) {
            return previousId
          }
          return list[0]?.id ?? null
        })

        // 好友列表刷新后重新查询在线状态
        requestPresenceSnapshot()

        return true
      } catch (error) {
        if (seq !== requestSeqRef.current || controller.signal.aborted) {
          return false
        }

        // 401 由 AuthContext 统一登出，这里不再展示列表错误
        if (error instanceof ApiError && error.status === 401) {
          return false
        }

        setListStatus('error')
        setListError(error instanceof ApiError ? error.message : '好友列表加载失败，请稍后重试。')
        return false
      }
    },
    [requestWithAuth]
  )

  const loadHistory = useCallback(
    async (friendId: string): Promise<void> => {
      const myUserId = user?.id

      if (!myUserId) {
        return
      }

      // 同一好友的旧请求作废，避免切换/重试时结果乱序
      historyControllersRef.current.get(friendId)?.abort()

      const controller = new AbortController()
      historyControllersRef.current.set(friendId, controller)

      setHistoryStatus((previous) => ({ ...previous, [friendId]: 'loading' }))
      setHistoryError((previous) => ({ ...previous, [friendId]: '' }))

      try {
        const page = await getMessageHistory(requestWithAuth, friendId, {
          limit: MESSAGE_PAGE_SIZE,
          signal: controller.signal
        })

        if (controller.signal.aborted) {
          return
        }

        if (page.messages.length > 0) {
          const incoming = page.messages.map((item) => toChatMessage(item, myUserId))

          setMessages((previous) =>
            updateConversation(previous, friendId, (list) => mergeChatMessages(list, incoming))
          )
        }

        loadedHistoryRef.current.add(friendId)
        setHistoryStatus((previous) => ({ ...previous, [friendId]: 'ready' }))

        // 首次成功加载才初始化分页游标；重新添加好友等场景保留已翻过页的游标
        setPagination((previous) =>
          previous[friendId]
            ? previous
            : updatePagination(previous, friendId, {
                hasMore: page.hasMore,
                nextCursor: page.nextCursor,
                loadingMore: false,
                error: ''
              })
        )
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        // 401 由 AuthContext 统一登出
        if (error instanceof ApiError && error.status === 401) {
          return
        }

        loadedHistoryRef.current.delete(friendId)
        setHistoryStatus((previous) => ({ ...previous, [friendId]: 'error' }))
        setHistoryError((previous) => ({
          ...previous,
          [friendId]: error instanceof ApiError ? error.message : '历史消息加载失败，请稍后重试。'
        }))
      } finally {
        if (historyControllersRef.current.get(friendId) === controller) {
          historyControllersRef.current.delete(friendId)
        }
      }
    },
    [requestWithAuth, user?.id]
  )

  /**
   * 向上翻页加载更早的消息。
   *
   * - 只合并到对应好友的会话，切换好友不会串数据；
   * - 同一好友同时只允许一个请求，重复滚动不会重复发请求；
   * - 失败保留已有消息与游标，用户可以重试同一页。
   */
  const loadOlderMessages = useCallback(
    async (friendId: string): Promise<void> => {
      const myUserId = user?.id
      const state = paginationRef.current[friendId]

      if (!myUserId || !state || !state.hasMore || !state.nextCursor) {
        return
      }

      // ref 同步占位，避免连续 scroll 事件在状态更新前重复请求
      if (loadMoreControllersRef.current.has(friendId)) {
        return
      }

      const controller = new AbortController()
      loadMoreControllersRef.current.set(friendId, controller)

      // 记录发起请求时所处的会话，切换好友后再返回的结果不恢复滚动位置
      const session = activeSessionRef.current

      setPagination((previous) =>
        updatePagination(previous, friendId, { loadingMore: true, error: '' })
      )

      try {
        const page = await getMessageHistory(requestWithAuth, friendId, {
          limit: MESSAGE_PAGE_SIZE,
          before: state.nextCursor,
          signal: controller.signal
        })

        if (controller.signal.aborted) {
          return
        }

        const incoming = page.messages.map((item) => toChatMessage(item, myUserId))
        const previousList = messagesRef.current[friendId] ?? []
        const previousIds = new Set(previousList.map((message) => message.messageId))
        const hasNewMessages = incoming.some((message) => !previousIds.has(message.messageId))

        // 只在消息列表里前插之前记录高度；渲染后按高度差把视口拉回原来的阅读位置。
        // 没有真正新增消息（例如重复页）时不记录，避免遗留错误的恢复位置。
        if (
          hasNewMessages &&
          activeFriendIdRef.current === friendId &&
          activeSessionRef.current === session &&
          messageListRef.current
        ) {
          scrollRestoreRef.current.set(friendId, {
            height: messageListRef.current.scrollHeight,
            top: messageListRef.current.scrollTop
          })
        }

        setMessages((previous) =>
          updateConversation(previous, friendId, (list) => mergeOlderMessages(list, incoming))
        )
        setPagination((previous) =>
          updatePagination(previous, friendId, {
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            loadingMore: false,
            error: ''
          })
        )
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }

        // 401 由 AuthContext 统一登出，这里只结束加载状态
        if (error instanceof ApiError && error.status === 401) {
          setPagination((previous) => updatePagination(previous, friendId, { loadingMore: false }))
          return
        }

        setPagination((previous) =>
          updatePagination(previous, friendId, {
            loadingMore: false,
            error: error instanceof ApiError ? error.message : '更早的消息加载失败，请稍后重试。'
          })
        )
      } finally {
        if (loadMoreControllersRef.current.get(friendId) === controller) {
          loadMoreControllersRef.current.delete(friendId)
        }
      }
    },
    [requestWithAuth, user?.id]
  )

  const handleMessagesScroll = useCallback((): void => {
    const friendId = activeFriendIdRef.current
    const list = messageListRef.current

    if (!friendId || !list) {
      return
    }

    // 接近顶部才触发；是否真的有下一页由 loadOlderMessages 内部再校验
    if (list.scrollTop > 24) {
      return
    }

    // 加载失败后不随滚动自动重试，交给浮层上的“重试”按钮
    if (paginationRef.current[friendId]?.error) {
      return
    }

    void loadOlderMessages(friendId)
  }, [loadOlderMessages])

  // 切换到某个好友时按需加载历史消息
  useEffect(() => {
    if (
      !activeFriendId ||
      loadedHistoryRef.current.has(activeFriendId) ||
      syncingFriendIdsRef.current.has(activeFriendId)
    ) {
      return
    }

    void loadHistory(activeFriendId)
  }, [activeFriendId, loadHistory])

  /** 让当前连接周期的补拉请求全部作废（断线/重连/卸载时调用） */
  const resetConversationSync = useCallback((): void => {
    syncGenerationRef.current += 1
    syncAbortRef.current?.abort()
    syncAbortRef.current = null
    syncedFriendIdsRef.current.clear()
    syncingFriendIdsRef.current.clear()
  }, [])

  /**
   * Socket 连接成功后补拉当前好友列表里每个好友最近 30 条消息。
   * 同一连接周期内每个好友最多同步一次；请求按连接代次作废，旧结果不会污染新周期。
   */
  const syncConversations = useCallback(async (): Promise<void> => {
    const myUserId = user?.id

    // 好友列表还没就绪时先不同步，等列表加载完成后的 effect 再次触发
    if (!myUserId || listStatusRef.current !== 'ready') {
      return
    }

    const generation = syncGenerationRef.current

    if (!syncAbortRef.current) {
      syncAbortRef.current = new AbortController()
    }

    const signal = syncAbortRef.current.signal
    const friendIds = friendsRef.current
      .map((friend) => friend.id)
      .filter((id) => !syncedFriendIdsRef.current.has(id) && !syncingFriendIdsRef.current.has(id))

    if (friendIds.length === 0) {
      return
    }

    let cursor = 0

    const syncOne = async (friendId: string): Promise<void> => {
      syncingFriendIdsRef.current.add(friendId)

      try {
        const page = await getMessageHistory(requestWithAuth, friendId, {
          limit: MESSAGE_PAGE_SIZE,
          signal
        })

        if (signal.aborted || generation !== syncGenerationRef.current) {
          return
        }

        const incoming = page.messages.map((item) => toChatMessage(item, myUserId))

        setMessages((previous) =>
          updateConversation(previous, friendId, (list) => mergeSyncedMessages(list, incoming))
        )
        loadedHistoryRef.current.add(friendId)
        syncedFriendIdsRef.current.add(friendId)
        setHistoryStatus((previous) => ({ ...previous, [friendId]: 'ready' }))
        setHistoryError((previous) => ({ ...previous, [friendId]: '' }))

        // 补拉只拿最近 30 条，不能覆盖分页已经记录的最旧消息游标
        setPagination((previous) =>
          previous[friendId]
            ? previous
            : updatePagination(previous, friendId, {
                hasMore: page.hasMore,
                nextCursor: page.nextCursor,
                loadingMore: false,
                error: ''
              })
        )
      } catch (error) {
        if (signal.aborted || generation !== syncGenerationRef.current) {
          return
        }

        // 401 由 AuthContext 统一登出
        if (error instanceof ApiError && error.status === 401) {
          return
        }

        // 失败时保留已有本地消息；只有从未加载成功过才展示错误和重试入口
        if (!loadedHistoryRef.current.has(friendId)) {
          setHistoryStatus((previous) => ({ ...previous, [friendId]: 'error' }))
          setHistoryError((previous) => ({
            ...previous,
            [friendId]: error instanceof ApiError ? error.message : '消息同步失败，请稍后重试。'
          }))
        }
      } finally {
        if (generation === syncGenerationRef.current) {
          syncingFriendIdsRef.current.delete(friendId)
        }
      }
    }

    const worker = async (): Promise<void> => {
      while (cursor < friendIds.length) {
        const friendId = friendIds[cursor]
        cursor += 1

        if (!friendId) {
          return
        }

        await syncOne(friendId)
      }
    }

    // 好友数量有限，限制 3 个并发，避免重连瞬间同时打出大量请求
    const workerCount = Math.min(3, friendIds.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }, [requestWithAuth, user?.id])

  useEffect(() => {
    // 数据获取 effect：挂载时立即进入 loading 并请求好友列表
    void loadFriends()

    return () => {
      requestSeqRef.current += 1
      controllerRef.current?.abort()
    }
  }, [loadFriends])

  useEffect(() => {
    isMountedRef.current = true
    const historyControllers = historyControllersRef.current
    const loadMoreControllers = loadMoreControllersRef.current

    return () => {
      isMountedRef.current = false

      for (const controller of historyControllers.values()) {
        controller.abort()
      }
      historyControllers.clear()

      for (const controller of loadMoreControllers.values()) {
        controller.abort()
      }
      loadMoreControllers.clear()
    }
  }, [])

  // Socket 连接成功（首次连接或自动重连）后补拉所有好友的离线消息；
  // 每次断开/重连都作废旧连接周期的请求，避免旧结果覆盖新周期
  useEffect(() => {
    const unsubscribe = subscribeSocketStatus((nextStatus) => {
      if (nextStatus === 'connected') {
        void syncConversations()
      } else {
        resetConversationSync()
      }
    })

    return () => {
      unsubscribe()
      resetConversationSync()
    }
  }, [syncConversations, resetConversationSync])

  // 好友列表加载完成或新增好友后，如果 Socket 已连上就补一次（已同步的好友会自动跳过）
  useEffect(() => {
    if (listStatus === 'ready' && getSocketStatus() === 'connected') {
      void syncConversations()
    }
  }, [friends, listStatus, syncConversations])

  // 登录状态下挂载 ChatScreen 时建立 Socket，退出/卸载时断开
  useEffect(() => {
    connectSocket()

    return () => {
      disconnectSocket()
    }
  }, [])

  useEffect(() => subscribeSocketStatus(setConnectionStatus), [])

  // 在线好友快照：连接/重连/刷新好友列表时请求，每 30 秒刷新一次
  useEffect(() => {
    const unsubscribePresence = subscribePresence((snapshot) => {
      setOnlineFriendIds(new Set(snapshot?.onlineFriendIds ?? []))
    })

    const unsubscribeStatus = subscribeSocketStatus((socketStatus) => {
      if (socketStatus === 'connected') {
        requestPresenceSnapshot()
      } else {
        setOnlineFriendIds(new Set())
      }
    })

    const intervalId = setInterval(() => {
      requestPresenceSnapshot()
    }, 30_000)

    requestPresenceSnapshot()

    return () => {
      unsubscribePresence()
      unsubscribeStatus()
      clearInterval(intervalId)
    }
  }, [])

  // 接收方通过 message:new 实时收到新消息；按 messageId 去重合并
  useEffect(() => {
    const myUserId = user?.id

    if (!myUserId) {
      return
    }

    return subscribeMessages((incoming) => {
      // 会话以“对方 ID”为键：自己发的按接收者归类，收到的按发送者归类
      const conversationId =
        incoming.senderId === myUserId ? incoming.receiverId : incoming.senderId

      setMessages((previous) =>
        updateConversation(previous, conversationId, (list) =>
          mergeChatMessages(list, [toChatMessage(incoming, myUserId)])
        )
      )
    })
  }, [user?.id])

  const activeFriend = useMemo(
    () => friends.find((friend) => friend.id === activeFriendId) ?? null,
    [friends, activeFriendId]
  )

  const activeMessages = useMemo(
    () => (activeFriendId ? (messages[activeFriendId] ?? []) : []),
    [messages, activeFriendId]
  )

  const activeHistoryStatus = activeFriendId ? historyStatus[activeFriendId] : undefined
  const activeHistoryError = activeFriendId ? (historyError[activeFriendId] ?? '') : ''
  const activePagination = activeFriendId ? pagination[activeFriendId] : undefined

  useLayoutEffect(() => {
    // 切换会话：丢弃其他会话遗留的滚动恢复记录，并开始新的会话代次
    activeSessionRef.current += 1
    scrollRestoreRef.current.clear()
  }, [activeFriendId])

  // 切换好友或新增消息后滚到底部；前插更早消息时改为恢复原阅读位置，避免视口跳动
  useLayoutEffect(() => {
    const list = messageListRef.current

    if (!list) {
      return
    }

    const restore = activeFriendId ? scrollRestoreRef.current.get(activeFriendId) : undefined

    if (restore && activeFriendId) {
      scrollRestoreRef.current.delete(activeFriendId)
      list.scrollTop = restore.top + (list.scrollHeight - restore.height)
      return
    }

    list.scrollTop = list.scrollHeight
  }, [activeFriendId, activeMessages])

  /**
   * 发送（或按原 messageId 重发）一条消息。
   *
   * 不生成新的 messageId：超时/断线后重试必须复用同一个 ID，服务端才能幂等。
   */
  const deliverMessage = useCallback(
    async (friendId: string, messageId: string, text: string): Promise<void> => {
      setMessages((previous) =>
        updateConversation(previous, friendId, (list) =>
          list.map((message): ChatMessage =>
            message.messageId === messageId
              ? { ...message, status: 'sending', error: undefined }
              : message
          )
        )
      )

      const ack = await sendChatMessage({ toUserId: friendId, messageId, content: text })

      if (!isMountedRef.current) {
        return
      }

      if (ack.ok) {
        const confirmed: ChatMessage = {
          messageId,
          text: ack.message.content,
          createdAt: ack.message.createdAt,
          mine: true,
          status: 'sent',
          serverId: ack.message.id
        }

        setMessages((previous) =>
          updateConversation(previous, friendId, (list) => mergeChatMessages(list, [confirmed]))
        )
        return
      }

      setMessages((previous) =>
        updateConversation(previous, friendId, (list) =>
          list.map((message): ChatMessage =>
            message.messageId === messageId
              ? { ...message, status: 'failed', error: ack.message }
              : message
          )
        )
      )
    },
    []
  )

  const sendMessage = (): void => {
    if (!activeFriendId) {
      return
    }

    const friendId = activeFriendId
    const text = (drafts[friendId] ?? '').trim()

    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      return
    }
    const messageId = crypto.randomUUID()
    const pending: ChatMessage = {
      messageId,
      text,
      createdAt: new Date().toISOString(),
      mine: true,
      status: 'sending'
    }

    // 消息按好友 id 分开保存，切换好友不会串线
    setMessages((previous) => updateConversation(previous, friendId, (list) => [...list, pending]))
    // 只清空当前好友的草稿，其他好友草稿保留
    setDrafts((previous) => {
      const next = { ...previous }
      delete next[friendId]
      return next
    })
    void deliverMessage(friendId, messageId, text)
  }

  const retryMessage = (friendId: string, message: ChatMessage): void => {
    if (message.status !== 'failed') {
      return
    }

    void deliverMessage(friendId, message.messageId, message.text)
  }

  const handleDraftChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    if (!activeFriendId) {
      return
    }

    const friendId = activeFriendId
    const value = event.target.value.slice(0, MAX_MESSAGE_LENGTH)

    setDrafts((previous) => ({ ...previous, [friendId]: value }))
  }

  // 按 Enter 发送；使用中文输入法选词时（isComposing 为 true）不发送
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      sendMessage()
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    sendMessage()
  }

  const openAddFriend = (): void => {
    setAddOpen(true)
    setAddUsername('')
    setAddError(null)
    setAddNotice(null)
    setAddNoticeWarning(false)
  }

  const closeAddFriend = (): void => {
    if (addSubmittingRef.current) {
      return
    }

    setAddOpen(false)
    setAddUsername('')
    setAddError(null)
  }

  const handleAddFriend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    // ref 抢占，防止连续点击/回车在状态更新前重复提交
    if (addSubmittingRef.current) {
      return
    }

    const username = addUsername.trim()

    if (!username) {
      setAddError('请输入用户名')
      return
    }

    addSubmittingRef.current = true
    setAddSubmitting(true)
    setAddError(null)
    setAddNotice(null)
    setAddNoticeWarning(false)

    try {
      const added = await addFriend(requestWithAuth, username)

      if (!isMountedRef.current) {
        return
      }

      setAddOpen(false)
      setAddUsername('')

      // 重新添加的好友要重新从服务端拉历史；已有本地记录会按 messageId 合并保留
      loadedHistoryRef.current.delete(added.id)
      syncedFriendIdsRef.current.delete(added.id)
      syncingFriendIdsRef.current.delete(added.id)

      // 以服务端返回的最新列表为准，并优先选中新好友
      const refreshed = await loadFriends(added.id)

      if (!isMountedRef.current) {
        return
      }

      if (refreshed) {
        setAddNotice(`已添加好友：${added.nickname || added.username}`)
        setAddNoticeWarning(false)
      } else {
        setAddNotice('添加成功，但好友列表刷新失败，请点击“重新加载”。')
        setAddNoticeWarning(true)
      }
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      // 401 由 AuthContext 统一登出
      if (error instanceof ApiError && error.status === 401) {
        return
      }

      setAddError(getAddFriendErrorMessage(error))
    } finally {
      addSubmittingRef.current = false

      if (isMountedRef.current) {
        setAddSubmitting(false)
      }
    }
  }

  const requestDeleteFriend = (friendId: string): void => {
    if (deleteSubmittingRef.current) {
      return
    }

    setPendingDeleteId(friendId)
    setDeleteError(null)
  }

  const cancelDeleteFriend = (): void => {
    if (deleteSubmittingRef.current) {
      return
    }

    setPendingDeleteId(null)
    setDeleteError(null)
  }

  const confirmDeleteFriend = async (friend: Friend): Promise<void> => {
    if (deleteSubmittingRef.current) {
      return
    }

    deleteSubmittingRef.current = true
    setDeleteSubmittingId(friend.id)
    setDeleteError(null)
    setDeleteNotice(null)
    setDeleteNoticeWarning(false)

    try {
      await removeFriend(requestWithAuth, friend.id)

      if (!isMountedRef.current) {
        return
      }

      setPendingDeleteId(null)

      // 已删除好友不再参与当前连接周期的自动同步；历史消息仍保留在本地
      syncedFriendIdsRef.current.delete(friend.id)
      syncingFriendIdsRef.current.delete(friend.id)
      loadedHistoryRef.current.delete(friend.id)

      // 以服务端重新返回的列表为准；当前好友被删时自动选中第一个剩余好友
      const refreshed = await loadFriends()

      if (!isMountedRef.current) {
        return
      }

      if (refreshed) {
        setDeleteNotice(`已删除好友：${getDisplayName(friend)}`)
        setDeleteNoticeWarning(false)
      } else {
        setDeleteNotice('好友已删除，但好友列表刷新失败，请重新加载。')
        setDeleteNoticeWarning(true)
      }
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      // 401 由 AuthContext 统一登出
      if (error instanceof ApiError && error.status === 401) {
        return
      }

      setDeleteError(getDeleteFriendErrorMessage(error))
    } finally {
      deleteSubmittingRef.current = false

      if (isMountedRef.current) {
        setDeleteSubmittingId(null)
      }
    }
  }

  const friendCountText = listStatus === 'ready' ? String(friends.length) : '…'
  const connectionState = getConnectionState(connectionStatus)

  return (
    <div className="app">
      {/* 左侧：好友列表 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1 className="brand">MyChatApp</h1>
          <div className="current-user">
            <span className="current-user-name" title={user?.nickname ?? ''}>
              {user?.nickname ?? '当前用户'}
            </span>
            <button className="logout-button" type="button" onClick={logout}>
              退出登录
            </button>
          </div>
          <p className="brand-subtitle">我的好友 · {friendCountText}</p>
          <p className={`connection-status ${connectionState.tone}`} role="status">
            <span className="connection-dot" />
            {connectionState.text}
          </p>
        </div>

        <div className="sidebar-tools">
          {!addOpen ? (
            <>
              <button className="add-friend-button" type="button" onClick={openAddFriend}>
                ＋ 添加好友
              </button>
              {addNotice && (
                <p className={`add-friend-notice ${addNoticeWarning ? 'warning' : 'success'}`}>
                  {addNotice}
                </p>
              )}
            </>
          ) : (
            <form className="add-friend-form" onSubmit={handleAddFriend}>
              <input
                className="add-friend-input"
                type="text"
                value={addUsername}
                onChange={(event) => setAddUsername(event.target.value)}
                placeholder="输入对方用户名"
                aria-label="好友用户名"
                autoFocus
                disabled={addSubmitting}
              />

              <div className="add-friend-actions">
                <button
                  className="add-friend-submit"
                  type="submit"
                  disabled={addSubmitting || addUsername.trim() === ''}
                >
                  {addSubmitting ? '添加中…' : '添加'}
                </button>
                <button
                  className="add-friend-cancel"
                  type="button"
                  onClick={closeAddFriend}
                  disabled={addSubmitting}
                >
                  取消
                </button>
              </div>

              {addError && <p className="add-friend-message error">{addError}</p>}
            </form>
          )}

          {deleteNotice && (
            <p className={`add-friend-notice ${deleteNoticeWarning ? 'warning' : 'success'}`}>
              {deleteNotice}
            </p>
          )}
        </div>

        <div className="friend-list">
          {listStatus === 'loading' && <p className="list-state">正在加载好友…</p>}

          {listStatus === 'error' && (
            <div className="list-state list-state-error">
              <p>{listError ?? '好友列表加载失败'}</p>
              <button className="list-retry" type="button" onClick={() => void loadFriends()}>
                重新加载
              </button>
            </div>
          )}

          {listStatus === 'ready' && friends.length === 0 && (
            <p className="list-state">还没有好友</p>
          )}

          {listStatus === 'ready' &&
            friends.map((friend) => {
              const friendMessages = messages[friend.id] ?? []
              const lastMessage = friendMessages[friendMessages.length - 1]
              const displayName = getDisplayName(friend)

              return (
                <div className="friend-block" key={friend.id}>
                  <div className="friend-row">
                    <button
                      type="button"
                      className={
                        friend.id === activeFriendId ? 'friend-item active' : 'friend-item'
                      }
                      onClick={() => setActiveFriendId(friend.id)}
                    >
                      <span className="avatar" style={{ backgroundColor: getAvatarColor(friend) }}>
                        {getAvatarText(friend)}
                        {onlineFriendIds.has(friend.id) && (
                          <span className="online-dot" aria-label="在线" />
                        )}
                      </span>
                      <span className="friend-info">
                        <span className="friend-name">{displayName}</span>
                        <span className="friend-preview">
                          {lastMessage ? lastMessage.text : '还没有消息'}
                        </span>
                      </span>
                    </button>

                    <button
                      className="friend-delete"
                      type="button"
                      aria-label={`删除好友 ${displayName}`}
                      onClick={() => requestDeleteFriend(friend.id)}
                      disabled={deleteSubmittingId !== null}
                    >
                      ×
                    </button>
                  </div>

                  {pendingDeleteId === friend.id && (
                    <div className="friend-confirm">
                      <p>确定删除“{displayName}”吗？</p>
                      <div className="friend-confirm-actions">
                        <button
                          className="friend-confirm-delete"
                          type="button"
                          onClick={() => void confirmDeleteFriend(friend)}
                          disabled={deleteSubmittingId !== null}
                        >
                          {deleteSubmittingId === friend.id ? '删除中…' : '确认删除'}
                        </button>
                        <button
                          className="friend-confirm-cancel"
                          type="button"
                          onClick={cancelDeleteFriend}
                          disabled={deleteSubmittingId !== null}
                        >
                          取消
                        </button>
                      </div>
                      {deleteError && <p className="friend-delete-error">{deleteError}</p>}
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      </aside>

      {/* 右侧：聊天区域 */}
      <main className="chat">
        {activeFriend ? (
          <>
            <header className="chat-header">
              <span className="avatar" style={{ backgroundColor: getAvatarColor(activeFriend) }}>
                {getAvatarText(activeFriend)}
              </span>
              <div className="chat-title">
                <span className="chat-name">{getDisplayName(activeFriend)}</span>
              </div>
            </header>

            <div className="messages" ref={messageListRef} onScroll={handleMessagesScroll}>
              {activePagination?.loadingMore && (
                <p className="messages-load-more">正在加载更早的消息…</p>
              )}

              {activePagination?.error && (
                <div className="messages-load-more messages-load-more-error">
                  <p>{activePagination.error}</p>
                  <button
                    className="list-retry"
                    type="button"
                    onClick={() => {
                      if (activeFriend) {
                        void loadOlderMessages(activeFriend.id)
                      }
                    }}
                  >
                    重试
                  </button>
                </div>
              )}

              {activeHistoryStatus === 'loading' && (
                <p className="messages-state">正在加载历史消息…</p>
              )}

              {activeHistoryStatus === 'error' && (
                <div className="messages-state messages-state-error">
                  <p>{activeHistoryError || '历史消息加载失败，请稍后重试。'}</p>
                  <button
                    className="list-retry"
                    type="button"
                    onClick={() => {
                      if (activeFriend) {
                        void loadHistory(activeFriend.id)
                      }
                    }}
                  >
                    重新加载
                  </button>
                </div>
              )}

              {activeHistoryStatus === 'ready' && activeMessages.length === 0 && (
                <p className="messages-empty">暂无聊天记录</p>
              )}

              {activeMessages.map((message) => (
                <div
                  key={message.messageId}
                  className={message.mine ? 'message-row mine' : 'message-row'}
                >
                  {!message.mine && (
                    <span
                      className="bubble-avatar"
                      style={{ backgroundColor: getAvatarColor(activeFriend) }}
                    >
                      {getAvatarText(activeFriend)}
                    </span>
                  )}
                  <div className={message.status === 'failed' ? 'bubble bubble-failed' : 'bubble'}>
                    <p className="bubble-text">{message.text}</p>
                    <span className="bubble-time">
                      {formatMessageTime(message.createdAt)}
                      {message.status === 'sending' && ' · 发送中…'}
                    </span>
                    {message.status === 'failed' && (
                      <span className="bubble-error">
                        {message.error ?? '发送失败'}
                        <button
                          className="bubble-retry"
                          type="button"
                          onClick={() => retryMessage(activeFriend.id, message)}
                        >
                          重发
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <input
                className="composer-input"
                type="text"
                value={drafts[activeFriend.id] ?? ''}
                maxLength={MAX_MESSAGE_LENGTH}
                onChange={handleDraftChange}
                onKeyDown={handleComposerKeyDown}
                placeholder="输入消息，按 Enter 发送"
                aria-label="消息输入框"
              />
              <button
                className="send-button"
                type="submit"
                disabled={(drafts[activeFriend.id] ?? '').trim() === ''}
              >
                发送
              </button>
            </form>
          </>
        ) : (
          <div className="chat-empty">
            {listStatus === 'loading' && '正在加载好友…'}
            {listStatus === 'error' && '好友列表加载失败，请在左侧重新加载'}
            {listStatus === 'ready' && '还没有好友，添加好友后就可以聊天了'}
          </div>
        )}
      </main>
    </div>
  )
}

export default ChatScreen
