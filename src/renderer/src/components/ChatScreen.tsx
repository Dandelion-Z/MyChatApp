import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ApiError } from '../api/client'
import {
  acceptFriendRequest,
  getFriendRequests,
  getFriends,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  setFriendStar
} from '../api/friends'
import type { Friend, FriendRequestItem } from '../api/friends'
import {
  getConversations,
  markConversationReadOnServer,
  openConversationOnServer,
  updateConversationOnServer
} from '../api/conversations'
import type { ServerConversation } from '../api/conversations'
import { getMessageHistory } from '../api/messages'
import type { MessageItem } from '../api/messages'
import type { LocalChatSummary, LocalMessageItem } from '../../../shared/localMessages'
import { useAuth } from '../auth/AuthContext'
import { getMyProfile } from '../api/profile'
import { Badge } from './Badge'
import { Avatar } from './Avatar'
import { ChangePasswordDialog } from '../profile/ChangePasswordDialog'
import { ProfilePage } from '../profile/ProfilePage'
import { groupContacts } from '../contacts/groups'
import { getFriendDisplayName } from '../friends/displayName'
import {
  deleteLocalChat,
  deleteLocalFriendData,
  ensureLocalChat,
  listLocalChatPeers,
  listLocalChats,
  setLocalChatFlags,
  touchLocalChat
} from '../localMessages/chatEntries'
import {
  getUnreadSummary,
  listLocalMessages,
  markConversationRead,
  saveLocalMessage,
  saveLocalMessageAsync,
  saveLocalMessagesAsync,
  subscribeLocalMessagesUpdated
} from '../localMessages/store'
import { isFriendHistorySyncIncomplete } from '../localMessages/sync'
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

/** 分页来源：同一会话内只使用一种游标，首次加载时确定 */
type PaginationSource = 'local' | 'server'

/** 历史分页状态，按 friendId 隔离 */
type PaginationState = {
  /** 翻页数据来源，初始化后不再混用 */
  source: PaginationSource
  hasMore: boolean
  nextCursor: string | null
  loadingMore: boolean
  /** 加载更早消息失败时的提示；成功后清空 */
  error: string
}

const MESSAGE_PAGE_SIZE = 30
/** 后台同步通知的读取节流窗口 */
const REFRESH_THROTTLE_MS = 250
/** 相邻消息超过该间隔时插入新的时间标签 */
const TIME_LABEL_GAP_MS = 5 * 60 * 1000

function getDisplayName(friend: Friend): string {
  // 好友列表优先显示当前用户设置的备注，未设置时回退昵称；登录用户名不对外展示
  return getFriendDisplayName(friend)
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// 数据库游标是微秒精度 ISO 文本，JS Date 只认毫秒，截断多余精度再解析
function parseMessageTime(value: string): number {
  const time = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(time) ? 0 : time
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function isSameDay(left: Date, right: Date): boolean {
  return startOfDay(left) === startOfDay(right)
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 微信式时间标签：今天只显示时间，昨天带“昨天”，同年更早显示月日，跨年再带年份。
 * 时间无法解析时返回空字符串，调用方据此跳过标签。
 */
function formatTimeLabel(value: string, now: Date = new Date()): string {
  const time = parseMessageTime(value)

  if (time === 0) {
    return ''
  }

  const date = new Date(time)
  const clock = formatTime(date)
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)

  if (dayDiff === 0) {
    return clock
  }

  if (dayDiff === 1) {
    return `昨天 ${clock}`
  }

  const monthDay = `${padTwo(date.getMonth() + 1)}月${padTwo(date.getDate())}日`

  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${clock}`
  }

  return `${date.getFullYear()}年${monthDay} ${clock}`
}

/**
 * 消息列表里显示的最近消息时间：今天 HH:mm / 昨天 / 同年 M月D日 / 跨年 YYYY/M/D。
 * 没有最近消息时返回空串，由列表决定是否显示占位。
 */
function formatChatListTime(atUs: number | null, now: Date = new Date()): string {
  if (atUs === null) {
    return ''
  }

  const date = new Date(Math.floor(atUs / 1000))

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)

  if (dayDiff <= 0) {
    return formatTime(date)
  }

  if (dayDiff === 1) {
    return '昨天'
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${padTwo(date.getMonth() + 1)}月${padTwo(date.getDate())}日`
  }

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 是否需要为当前消息插入时间标签：
 * 第一条消息总显示；跨自然日显示；相邻间隔达到 5 分钟显示。
 */
function shouldShowTimeLabel(previous: string | null, current: string): boolean {
  if (formatTimeLabel(current) === '') {
    return false
  }

  if (previous === null) {
    return true
  }

  const previousTime = parseMessageTime(previous)
  const currentTime = parseMessageTime(current)

  if (previousTime === 0 || !isSameDay(new Date(previousTime), new Date(currentTime))) {
    return true
  }

  return currentTime - previousTime >= TIME_LABEL_GAP_MS
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

/** 本地 SQLite 记录转成界面消息；字段与服务端消息一致 */
function toChatMessageFromLocal(item: LocalMessageItem, myUserId: string): ChatMessage {
  return {
    messageId: item.messageId,
    text: item.content,
    createdAt: item.createdAt,
    mine: item.senderId === myUserId,
    status: 'sent',
    serverId: item.serverId
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

/** 只改某个好友的分页状态，其他好友保持原样 */
function updatePagination(
  previous: Record<string, PaginationState>,
  friendId: string,
  patch: Partial<PaginationState>
): Record<string, PaginationState> {
  const current = previous[friendId] ?? {
    source: 'local' as PaginationSource,
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

  return '发送失败，请稍后重试。'
}

/** 好友申请状态文案；收到的待处理申请由同意/拒绝按钮代替状态文字 */
function getFriendRequestStatusLabel(status: FriendRequestItem['status']): string {
  if (status === 'accepted') {
    return '已添加'
  }

  if (status === 'rejected') {
    return '已拒绝'
  }

  if (status === 'expired') {
    return '已过期'
  }

  return '等待验证'
}

function getFriendRequestErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return '无法连接服务器，请确认后端服务已启动后重试。'
    }

    if (error.status === 500) {
      return '服务器内部错误，请稍后重试。'
    }

    // 400/403/404/409 等业务错误优先使用后端返回的明确文案
    return error.message
  }

  return '操作失败，请稍后重试。'
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

// 联系人右键菜单的估算尺寸：只用于把菜单限制在窗口内，避免贴边时被裁掉
const CONTACT_MENU_WIDTH = 180
const CONTACT_MENU_HEIGHT = 148
const CONTACT_MENU_MARGIN = 8

// 消息列表右键菜单的三个选项（删除聊天在最后），估算尺寸用于夹取位置
const CHAT_MENU_WIDTH = 168
const CHAT_MENU_HEIGHT = 132
const CHAT_MENU_MARGIN = 8

// 输入框高度：用户手动拖动调整，所有会话共用并持久化在本机
const COMPOSER_MIN_HEIGHT = 44
const COMPOSER_HEIGHT_STORAGE_KEY = 'mychatapp.composerHeight'

// 中栏宽度：拖动右侧边框调整，限定范围避免挤压聊天区
const MIDDLE_COLUMN_DEFAULT_WIDTH = 280
const MIDDLE_COLUMN_MIN_WIDTH = 220
const MIDDLE_COLUMN_MAX_WIDTH = 420

// 基础 Emoji：仅使用 Unicode 字符，作为普通文本插入与发送
const EMOJI_OPTIONS = [
  '😀',
  '😄',
  '😁',
  '😆',
  '😅',
  '😂',
  '🤣',
  '🙂',
  '😉',
  '😊',
  '😍',
  '🥰',
  '😘',
  '😜',
  '🤪',
  '😎',
  '🤔',
  '🙄',
  '😴',
  '🥱',
  '😢',
  '😭',
  '😤',
  '😡',
  '👍',
  '👎',
  '👏',
  '🙏',
  '💪',
  '👌',
  '✌️',
  '🤝',
  '❤️',
  '💔',
  '💯',
  '🎉',
  '🔥',
  '✨',
  '🌹',
  '🍀',
  '☀️',
  '🌙',
  '⭐️',
  '🍺',
  '☕️',
  '🍰',
  '🎁',
  '🚀'
]

/** 读取上次调整的输入框高度；无记录或数据损坏时回落到最小高度 */
function readStoredComposerHeight(): number {
  try {
    const raw = window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)

    if (Number.isFinite(parsed) && parsed >= COMPOSER_MIN_HEIGHT) {
      return parsed
    }
  } catch {
    // localStorage 不可用时按默认高度处理，不影响聊天
  }

  return COMPOSER_MIN_HEIGHT
}

// 距底部多少像素以内视为“正在看最新消息”；只有这个位置才向后台上报已读
const READ_BOTTOM_THRESHOLD = 48

/** 滚动容器是否停在（或非常接近）最新消息处 */
function isNearBottom(list: HTMLElement | null): boolean {
  if (!list) {
    return true
  }

  return list.scrollHeight - list.scrollTop - list.clientHeight <= READ_BOTTOM_THRESHOLD
}

type ComposerSelection = {
  selectionStart: number
  selectionEnd: number
  scrollTop: number
}

/** 服务端会话排序：置顶优先，其次最近活动时间倒序，最后按 peerId 升序稳定兜底 */
function compareServerConversations(left: ServerConversation, right: ServerConversation): number {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1
  }

  const leftAt = left.lastActivityAt ? parseMessageTime(left.lastActivityAt) : 0
  const rightAt = right.lastActivityAt ? parseMessageTime(right.lastActivityAt) : 0

  if (leftAt !== rightAt) {
    return rightAt - leftAt
  }

  return left.peerId.localeCompare(right.peerId)
}

function ChatScreen(): React.JSX.Element {
  const { user, logout, requestWithAuth, getRefreshToken } = useAuth()

  const [friends, setFriends] = useState<Friend[]>([])
  const [activeFriendId, setActiveFriendId] = useState<string | null>(null)
  // 中间栏视图：消息列表 / 通讯录
  const [view, setView] = useState<'messages' | 'contacts'>('messages')
  // 本地会话条目（聊天列表），消息内容与时间由主进程从 messages 表读出
  const [chatEntries, setChatEntries] = useState<LocalChatSummary[]>([])
  // 通讯录里单击选中的联系人（只高亮，不打开聊天）
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  // 中间栏顶部搜索框：仅按昵称匹配当前好友列表
  const [searchQuery, setSearchQuery] = useState<string>('')
  // 全部会话的未读消息总数（持久化在本地 SQLite 的 messages.is_unread 上）
  const [unreadTotal, setUnreadTotal] = useState<number>(0)
  // 服务端未读：peerId -> 未读条数，以 PostgreSQL 的已读位置为准
  const [serverUnread, setServerUnread] = useState<Record<string, number>>({})
  // 服务端汇总的未读总数（所有可见会话）
  const [serverUnreadTotal, setServerUnreadTotal] = useState<number>(0)
  // 是否成功拉取过服务端未读：失败时界面继续用本地统计兜底
  const [serverUnreadReady, setServerUnreadReady] = useState<boolean>(false)
  // 服务端会话列表：成员、排序、置顶/免打扰/隐藏与元数据都以它为准
  const [serverConversations, setServerConversations] = useState<ServerConversation[]>([])
  // 是否成功拉取过服务端会话列表；失败时列表退回本地缓存
  const [serverConversationsReady, setServerConversationsReady] = useState<boolean>(false)
  // 左侧导航栏底部的账户菜单（当前只有退出登录，后续可按同一结构追加）
  const [railMenuOpen, setRailMenuOpen] = useState<boolean>(false)
  const railFooterRef = useRef<HTMLDivElement | null>(null)

  // 双击头像的防重入时间戳：一次双击不应重复创建会话条目
  const openingChatRef = useRef<Map<string, number>>(new Map())
  // 字母分组的锚点，供右侧索引滚动定位
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  // 每个好友会话的历史加载状态与错误，按好友 ID 分开保存
  const [historyStatus, setHistoryStatus] = useState<Record<string, HistoryStatus>>({})
  const [historyError, setHistoryError] = useState<Record<string, string>>({})
  // 历史分页状态（hasMore / nextCursor / loadingMore / error），按好友 ID 分开保存
  const [pagination, setPagination] = useState<Record<string, PaginationState>>({})
  // 每个好友独立保存草稿，只在内存中；切换好友互不影响
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // 输入框高度：全局统一，拖动调整后写入 localStorage
  const [composerHeight, setComposerHeight] = useState<number>(() => readStoredComposerHeight())
  // 中栏宽度：仅当前窗口内生效，不持久化
  const [middleColumnWidth, setMiddleColumnWidth] = useState<number>(MIDDLE_COLUMN_DEFAULT_WIDTH)
  // 表情面板是否展开：固定在输入区底部左侧按钮旁弹出
  const [emojiOpen, setEmojiOpen] = useState(false)
  // 个人资料页：占据右侧聊天区域，但不影响选中的会话与草稿
  const [profileOpen, setProfileOpen] = useState(false)
  /** 当前登录用户自己的头像；上传/恢复默认后由资料页回调即时更新 */
  const [selfAvatarUrl, setSelfAvatarUrl] = useState<string | null>(null)

  // 启动/切换账号时读取自己的头像，供导航栏、自我聊天与消息头像复用
  useEffect(() => {
    if (!user?.id) {
      setSelfAvatarUrl(null)
      return
    }

    let active = true

    void getMyProfile(requestWithAuth)
      .then((profile) => {
        if (active) {
          setSelfAvatarUrl(profile.avatarUrl)
        }
      })
      .catch(() => {
        // 拉取失败时保持默认头像，不影响其他界面使用
      })

    return () => {
      active = false
    }
  }, [requestWithAuth, user?.id])
  // 好友资料页：与自己的资料页共用同一个组件，仅访问模式不同
  const [profileFriend, setProfileFriend] = useState<Friend | null>(null)
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  // 在线好友 ID 集合，只用于好友列表的绿色圆点
  const [onlineFriendIds, setOnlineFriendIds] = useState<Set<string>>(new Set())
  // 连接状态只用于界面提示，实际收发仍由 socketClient 控制
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>(getSocketStatus())

  // 添加好友表单状态
  const [addOpen, setAddOpen] = useState<boolean>(false)
  const [addUid, setAddUid] = useState<string>('')
  const [addSubmitting, setAddSubmitting] = useState<boolean>(false)
  const [addError, setAddError] = useState<string | null>(null)
  // 发送申请成功后的轻量 Toast：约 1 秒自动消失，不拦截操作
  const [toast, setToast] = useState<string | null>(null)
  // 修改密码弹窗：从左侧底部账户菜单打开
  const [passwordOpen, setPasswordOpen] = useState<boolean>(false)
  const toastTimerRef = useRef<number | null>(null)
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
  // 星标请求进行中标记：避免连点造成同一联系人并发写入
  const starUpdatingRef = useRef<boolean>(false)
  // 联系人右键菜单：记录目标好友与鼠标位置（视口坐标）
  const [contactMenu, setContactMenu] = useState<{
    friendId: string
    x: number
    y: number
  } | null>(null)
  const contactMenuRef = useRef<HTMLDivElement | null>(null)

  // 消息列表右键菜单：记录目标会话与鼠标位置（视口坐标）
  const [chatMenu, setChatMenu] = useState<{ peerId: string; x: number; y: number } | null>(null)
  const chatMenuRef = useRef<HTMLDivElement | null>(null)
  // 会话管理状态写入中：避免连点造成同一会话并发写库
  const chatFlagUpdatingRef = useRef<boolean>(false)
  // 会话设置侧边栏：置顶 / 免打扰，开关状态始终以服务端会话为准
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false)
  const [settingsBusy, setSettingsBusy] = useState<boolean>(false)
  const chatSettingsRef = useRef<HTMLElement | null>(null)
  const chatSettingsButtonRef = useRef<HTMLButtonElement | null>(null)
  // 与 chatEntries 同步的 ref：收到实时消息时读取免打扰状态，避免闭包拿到旧列表
  const chatEntriesRef = useRef<LocalChatSummary[]>([])
  // 与 serverConversations 同步的 ref：写操作需要用最新的 version 做乐观并发控制
  const serverConversationsRef = useRef<ServerConversation[]>([])

  // 新的朋友：右栏好友申请列表（收到 + 发出），进入页面时从服务端拉取
  const [requestsOpen, setRequestsOpen] = useState<boolean>(false)
  const [friendRequests, setFriendRequests] = useState<FriendRequestItem[]>([])
  const [requestsStatus, setRequestsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  )
  const [requestsError, setRequestsError] = useState<string | null>(null)
  // 正在同意/拒绝的申请 ID；同一时间只处理一条，避免并发写库
  const [requestActionId, setRequestActionId] = useState<string | null>(null)
  const [requestActionError, setRequestActionError] = useState<string | null>(null)
  // 收到的待处理申请数（由服务端统计）：大于 0 时「新的朋友」入口显示红点
  const [pendingIncomingCount, setPendingIncomingCount] = useState<number>(0)
  const requestsControllerRef = useRef<AbortController | null>(null)
  const requestActionRef = useRef<boolean>(false)

  const messageListRef = useRef<HTMLDivElement>(null)
  // 新消息到达时是否继续贴住底部：用户翻看历史时保持原阅读位置
  const stickToBottomRef = useRef<boolean>(true)
  const previousActiveFriendRef = useRef<string | null>(null)
  // 手动调整输入框高度：以聊天区高度的一半作为上限
  const chatAreaRef = useRef<HTMLElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  // 输入框当前高度与拖动起点，用 ref 保证拖动过程读取到最新值
  const composerHeightRef = useRef<number>(composerHeight)
  const composerResizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  // 拖动高度前的聊天滚动位置：用于拖动过程中保持视觉位置稳定
  const composerScrollRef = useRef<{ stickToBottom: boolean; scrollTop: number } | null>(null)
  const middleColumnResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  // 表情面板与按钮：用于判断点击是否落在面板外
  const emojiPanelRef = useRef<HTMLDivElement | null>(null)
  const emojiButtonRef = useRef<HTMLButtonElement | null>(null)
  // 每个会话的输入框光标 / 选区 / 内部滚动位置，只在内存中保存
  const composerSelectionsRef = useRef<Map<string, ComposerSelection>>(new Map())
  // 已经自动聚焦过的会话：同一个会话重渲染或窗口重新聚焦时不再抢焦点
  const focusedComposerFriendRef = useRef<string | null>(null)
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
  // 服务端未读镜像：计算总数增量时避免读到过期的 state
  const serverUnreadRef = useRef<Record<string, number>>({})
  // 已上报过的最后位置 / 正在上报的位置，避免同一位置重复请求
  const lastReadSubmittedRef = useRef<Map<string, string>>(new Map())
  const readInFlightRef = useRef<Map<string, string>>(new Map())
  // 本地读取请求序号：IPC 无法取消，用序号丢弃过期结果，且不影响其他类型的请求
  const localReadSeqRef = useRef<Map<string, number>>(new Map())
  // 后台同步通知的节流定时器与上次执行时间，按好友 ID 记录
  const localRefreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const localRefreshAtRef = useRef<Map<string, number>>(new Map())
  // 前插更早消息后要恢复的滚动位置（scrollHeight / scrollTop），按好友 ID 记录
  const scrollRestoreRef = useRef<Map<string, { height: number; top: number }>>(new Map())
  // 每次切换会话递增，用于判断分页响应是否还属于发起请求时的那次会话查看
  const activeSessionRef = useRef(0)

  // 重连补拉：以“连接代次”隔离不同连接周期的请求，旧代次结果直接丢弃
  // 好友列表差集核对同一时间只跑一轮，避免重连与列表刷新并发重复清理
  const pruneInFlightRef = useRef<boolean>(false)
  const prunePromiseRef = useRef<Promise<void> | null>(null)
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

  // 进入聊天界面时恢复主界面窗口尺寸（登录 / 注册时使用紧凑窗口）
  useEffect(() => {
    void window.api?.windowLayout?.set('chat').catch(() => {
      // 窗口尺寸调整失败不影响聊天功能
    })
  }, [])

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

  useEffect(() => {
    chatEntriesRef.current = chatEntries
  }, [chatEntries])

  useEffect(() => {
    serverConversationsRef.current = serverConversations
  }, [serverConversations])

  /**
   * 当前账号自己的联系人条目：用于自我聊天（个人备忘录）。
   * 只存在于渲染端，不写入服务端 friendships，也不能删除或标记星标。
   */
  const selfFriend = useMemo<Friend | null>(() => {
    if (!user) {
      return null
    }

    return {
      id: user.id,
      nickname: user.nickname,
      createdAt: '',
      isStarred: false,
      starredAt: null,
      remark: null,
      avatarUrl: selfAvatarUrl
    }
  }, [selfAvatarUrl, user])

  const friendsWithSelf = useMemo(
    () => (selfFriend ? [...friends, selfFriend] : friends),
    [friends, selfFriend]
  )

  /** 重新读取未读总数；消息入库或清除后由调用方触发 */
  const refreshUnreadTotal = useCallback(async (): Promise<void> => {
    const summary = await getUnreadSummary(user?.id)

    if (!isMountedRef.current) {
      return
    }

    setUnreadTotal(summary.total)
  }, [user?.id])

  /** 重新读取本地会话条目；消息表内容变化后由调用方触发 */
  const refreshChatEntries = useCallback(async (): Promise<void> => {
    const chats = await listLocalChats(user?.id)

    if (!isMountedRef.current) {
      return
    }

    setChatEntries(chats)
  }, [user?.id])

  /**
   * 拉取服务端会话列表与未读。列表以服务端为权威，成功结果同时镜像到本地缓存，
   * 供离线展示；请求失败时保留上一份服务端数据，界面继续用本地缓存兜底。
   */
  const refreshServerConversations = useCallback(async (): Promise<void> => {
    try {
      const response = await getConversations(requestWithAuth)

      if (!isMountedRef.current) {
        return
      }

      const nextUnread: Record<string, number> = {}

      for (const conversation of response.conversations) {
        nextUnread[conversation.peerId] = conversation.unreadCount
      }

      const sorted = response.conversations.slice().sort(compareServerConversations)

      serverUnreadRef.current = nextUnread
      setServerUnread(nextUnread)
      setServerUnreadTotal(response.unreadTotal)
      setServerUnreadReady(true)
      serverConversationsRef.current = sorted
      setServerConversations(sorted)
      setServerConversationsReady(true)

      // 把服务端的置顶/免打扰镜像到本地缓存，只写有差异的条目，离线读取时保持一致
      const myUserId = user?.id

      if (myUserId) {
        const localById = new Map(chatEntriesRef.current.map((entry) => [entry.peerId, entry]))
        const mirrors: Promise<boolean>[] = []

        for (const conversation of sorted) {
          const local = localById.get(conversation.peerId)

          if (
            !local ||
            local.isPinned !== conversation.isPinned ||
            local.isMuted !== conversation.isMuted
          ) {
            mirrors.push(
              setLocalChatFlags(myUserId, conversation.peerId, {
                pinned: conversation.isPinned,
                muted: conversation.isMuted
              })
            )
          }
        }

        if (mirrors.length > 0) {
          void Promise.all(mirrors).then(() => refreshChatEntries())
        }
      }
    } catch (error) {
      // 401 由 AuthContext 统一登出；离线等错误保留旧值，等下次刷新
      if (error instanceof ApiError && error.status === 401) {
        return
      }
    }
  }, [refreshChatEntries, requestWithAuth, user?.id])

  /**
   * 上报“已读到哪条消息”：只有窗口在前台、且会话停在最新消息处时才推进。
   * 正在翻看历史消息时不会提前清掉服务端未读。
   */
  const reportReadIfLatest = useCallback(
    (peerId: string, latest: ChatMessage | undefined): void => {
      const myUserId = user?.id

      if (!myUserId || !latest?.serverId || peerId === myUserId) {
        return
      }

      if (!document.hasFocus() || !isNearBottom(messageListRef.current)) {
        return
      }

      if (lastReadSubmittedRef.current.get(peerId) === latest.serverId) {
        return
      }

      if (readInFlightRef.current.has(peerId)) {
        return
      }

      const reportedMessageId = latest.serverId
      readInFlightRef.current.set(peerId, reportedMessageId)

      void markConversationReadOnServer(requestWithAuth, peerId, reportedMessageId)
        .then((state) => {
          if (!isMountedRef.current) {
            return
          }

          const submitted = lastReadSubmittedRef.current.get(peerId)

          // 并发上报可能在乱序返回：旧位置的结果不能覆盖新位置
          if (submitted !== undefined && BigInt(submitted) > BigInt(reportedMessageId)) {
            return
          }

          lastReadSubmittedRef.current.set(peerId, reportedMessageId)

          const nextUnread = { ...serverUnreadRef.current, [peerId]: state.unreadCount }

          serverUnreadRef.current = nextUnread
          setServerUnread(nextUnread)
          // 总数直接由各会话未读求和，避免增量扣减在新消息并发时累积偏差
          setServerUnreadTotal(
            Object.values(nextUnread).reduce((sum, count) => sum + Math.max(0, count), 0)
          )

          // 本地 SQLite 未读一并清掉，离线兜底统计与服务端保持一致
          void markConversationRead(myUserId, peerId).then(() =>
            Promise.all([refreshChatEntries(), refreshUnreadTotal()])
          )
        })
        .catch((error: unknown) => {
          // 401 由 AuthContext 统一登出；其他失败留待下次滚动或新消息重试
          if (error instanceof ApiError && error.status === 401) {
            return
          }
        })
        .finally(() => {
          if (readInFlightRef.current.get(peerId) === reportedMessageId) {
            readInFlightRef.current.delete(peerId)
          }
        })
    },
    [refreshChatEntries, refreshUnreadTotal, requestWithAuth, user?.id]
  )

  /**
   * 写服务端会话状态（置顶/免打扰/隐藏），用返回的最新会话替换本地列表项。
   * 先成功再改本地缓存；失败时返回 false，由调用方提示，不破坏已有界面状态。
   */
  const patchServerConversation = useCallback(
    async (
      peerId: string,
      changes: { isPinned?: boolean; isMuted?: boolean; isHidden?: boolean }
    ): Promise<boolean> => {
      const myUserId = user?.id

      if (!myUserId) {
        return false
      }

      try {
        let current = serverConversationsRef.current.find((item) => item.peerId === peerId)

        // 本地还没有该会话的服务端记录（例如首次操作）时，先创建再改状态
        if (!current) {
          current = await openConversationOnServer(requestWithAuth, peerId)
        }

        let updated
        try {
          updated = await updateConversationOnServer(
            requestWithAuth,
            peerId,
            changes,
            current.version
          )
        } catch (error) {
          // 其他设备（或本机已读上报）会推进 version，导致一次 409。
          // 这里拉取最新状态后用新版本重试一次，避免用户第一次点击开关就失败。
          if (!(error instanceof ApiError) || error.status !== 409) {
            throw error
          }

          const latest = await getConversations(requestWithAuth)
          const latestEntry = latest.conversations.find((item) => item.peerId === peerId)

          if (!latestEntry) {
            throw error
          }

          updated = await updateConversationOnServer(
            requestWithAuth,
            peerId,
            changes,
            latestEntry.version
          )
        }

        if (!isMountedRef.current) {
          return true
        }

        const previousUnread = serverUnreadRef.current[peerId] ?? 0
        const next = serverConversationsRef.current.filter((item) => item.peerId !== peerId)

        if (!updated.isHidden) {
          // PATCH 只返回会话状态，不带未读数：沿用当前已知值，稍后由列表刷新校准
          next.push({ ...updated, unreadCount: previousUnread })
        }

        next.sort(compareServerConversations)
        serverConversationsRef.current = next
        setServerConversations(next)

        // 本地缓存同步，保证离线时置顶/免打扰与云端一致
        await setLocalChatFlags(myUserId, peerId, {
          pinned: updated.isPinned,
          muted: updated.isMuted
        })
        await refreshChatEntries()

        // 隐藏会改变总数，置顶会影响排序：用服务端列表再校准一次
        if (changes.isHidden !== undefined) {
          void refreshServerConversations()
        }

        return true
      } catch (error) {
        // 401 由 AuthContext 统一登出
        if (error instanceof ApiError && error.status === 401) {
          return false
        }

        // 版本冲突说明其他设备改过同一会话：重新拉取最新状态
        if (error instanceof ApiError && error.status === 409) {
          void refreshServerConversations()
        }

        return false
      }
    },
    [refreshChatEntries, refreshServerConversations, requestWithAuth, user?.id]
  )

  /**
   * 打开某个好友的聊天：选中会话、打开（或创建）服务端会话记录、更新本地最近打开时间。
   * 重新打开被删除（隐藏）的聊天时，服务端会清除本侧隐藏位并返回最新状态。
   */
  const openConversation = useCallback(
    async (friendId: string): Promise<void> => {
      setRequestsOpen(false)
      setProfileOpen(false)
      setProfileFriend(null)
      setActiveFriendId(friendId)

      try {
        const conversation = await openConversationOnServer(requestWithAuth, friendId)

        if (isMountedRef.current) {
          const previousUnread = serverUnreadRef.current[friendId] ?? 0
          const next = serverConversationsRef.current.filter((item) => item.peerId !== friendId)
          // open 只返回会话状态，不带未读数：沿用当前已知值，列表刷新时会校准
          next.push({ ...conversation, unreadCount: previousUnread })
          next.sort(compareServerConversations)
          serverConversationsRef.current = next
          setServerConversations(next)
          setServerConversationsReady(true)
        }
      } catch (error) {
        // 离线时仍允许打开本地缓存的聊天；401 由 AuthContext 统一处理
        if (error instanceof ApiError && error.status === 401) {
          return
        }
      }

      await ensureLocalChat(user?.id, friendId)
      await touchLocalChat(user?.id, friendId)
      // 打开会话不直接清未读：等历史加载完、确实停在最新消息处再上报已读
      await refreshChatEntries()
      // open 会清除隐藏位并更新最近打开时间，用服务端列表校准成员与未读
      void refreshServerConversations()
    },
    [refreshChatEntries, refreshServerConversations, requestWithAuth, user?.id]
  )

  /** 置顶 / 取消置顶：先写服务端，成功后同步本地缓存与排序 */
  const toggleChatPinned = async (entry: LocalChatSummary): Promise<void> => {
    if (chatFlagUpdatingRef.current) {
      return
    }

    chatFlagUpdatingRef.current = true

    try {
      const ok = await patchServerConversation(entry.peerId, { isPinned: !entry.isPinned })

      if (!ok) {
        setDeleteNotice('设置置顶失败，请稍后再试。')
        setDeleteNoticeWarning(true)
      }
    } finally {
      chatFlagUpdatingRef.current = false
    }
  }

  /** 免打扰开关：只影响任务栏闪烁提醒，不改变消息入库、同步和未读统计 */
  const toggleChatMuted = async (entry: LocalChatSummary): Promise<void> => {
    if (chatFlagUpdatingRef.current) {
      return
    }

    chatFlagUpdatingRef.current = true

    try {
      const ok = await patchServerConversation(entry.peerId, { isMuted: !entry.isMuted })

      if (!ok) {
        setDeleteNotice('设置免打扰失败，请稍后再试。')
        setDeleteNoticeWarning(true)
      }
    } finally {
      chatFlagUpdatingRef.current = false
    }
  }

  /** 会话设置侧边栏：置顶开关；服务端成功后才改变，失败保留原状态并提示 */
  const handleSettingsTogglePinned = async (): Promise<void> => {
    if (!activeChatEntry || settingsBusy) {
      return
    }

    setSettingsBusy(true)

    try {
      await toggleChatPinned(activeChatEntry)
    } finally {
      setSettingsBusy(false)
    }
  }

  /** 会话设置侧边栏：免打扰开关；只影响提醒，不影响消息接收与未读 */
  const handleSettingsToggleMuted = async (): Promise<void> => {
    if (!activeChatEntry || settingsBusy) {
      return
    }

    setSettingsBusy(true)

    try {
      await toggleChatMuted(activeChatEntry)
    } finally {
      setSettingsBusy(false)
    }
  }

  /** 删除聊天入口：服务端隐藏会话并清本地未读，历史消息一条不删 */
  const handleDeleteChat = async (entry: LocalChatSummary): Promise<void> => {
    if (chatFlagUpdatingRef.current) {
      return
    }

    chatFlagUpdatingRef.current = true

    try {
      const ok = await patchServerConversation(entry.peerId, { isHidden: true })

      if (!ok) {
        setDeleteNotice('删除聊天失败，请稍后重试。')
        setDeleteNoticeWarning(true)
        return
      }

      const clearedUnread = await deleteLocalChat(user?.id, entry.peerId)

      if (clearedUnread === null) {
        setDeleteNotice('聊天已从云端隐藏，但本地缓存清理失败，请重启应用后重试。')
        setDeleteNoticeWarning(true)
        return
      }

      // 删除当前打开的会话时回到空聊天区域，历史消息仍保留
      if (activeFriendIdRef.current === entry.peerId) {
        setActiveFriendId(null)
      }

      // 隐藏会话默认不出现在服务端列表，总数会随重新拉取一起归零
      await Promise.all([refreshChatEntries(), refreshUnreadTotal(), refreshServerConversations()])
    } finally {
      chatFlagUpdatingRef.current = false
    }
  }

  // 消息列表右键菜单：点击菜单外部、按 Esc 或窗口失焦时关闭
  useEffect(() => {
    if (!chatMenu) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!chatMenuRef.current?.contains(event.target as Node)) {
        setChatMenu(null)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setChatMenu(null)
      }
    }

    const handleBlur = (): void => setChatMenu(null)

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', handleBlur)
    }
  }, [chatMenu])

  /** 通讯录双击头像：建/开聊天并切到消息入口，防重入避免一次双击创建两次 */
  const openConversationFromContacts = useCallback(
    (friendId: string): void => {
      const now = Date.now()
      const lastOpenedAt = openingChatRef.current.get(friendId) ?? 0

      if (now - lastOpenedAt < 800) {
        return
      }

      openingChatRef.current.set(friendId, now)
      setRequestsOpen(false)
      setSelectedContactId(friendId)
      setView('messages')
      void openConversation(friendId)
    },
    [openConversation]
  )

  /** 搜索结果：切到消息入口并打开（必要时创建）对应聊天 */
  const openConversationFromSearch = useCallback(
    (friendId: string): void => {
      setSearchQuery('')
      setView('messages')
      openConversationFromContacts(friendId)
    },
    [openConversationFromContacts]
  )

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
        friendsRef.current = list
        setListStatus('ready')
        setActiveFriendId((previousId) => {
          // 新添加的好友优先选中；否则保留原选择；否则不自动打开会话，由消息列表/通讯录决定
          if (preferredFriendId && list.some((friend) => friend.id === preferredFriendId)) {
            return preferredFriendId
          }
          // 自己不在好友列表里，但自我聊天同样需要保持选中
          if (
            previousId &&
            (previousId === user?.id || list.some((friend) => friend.id === previousId))
          ) {
            return previousId
          }
          return null
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
    [requestWithAuth, user?.id]
  )

  /**
   * 好友列表刷新后与服务端好友集合做差集，清理“已不是好友但仍留有本地数据”的对象。
   *
   * 只有好友接口成功返回时才会调用，绝不能把失败/空结果当成真实列表；
   * 自我聊天不在好友列表里，必须显式保留；只处理当前登录账号的数据。
   */
  const pruneStaleFriendCaches = useCallback(
    (currentFriends: Friend[]): Promise<void> => {
      const myUserId = user?.id

      if (!myUserId) {
        return Promise.resolve()
      }

      // 已在核对时复用同一轮结果，保证“先核对再同步”的调用方等到清理完成
      if (pruneInFlightRef.current) {
        return prunePromiseRef.current ?? Promise.resolve()
      }

      pruneInFlightRef.current = true

      const run = (async (): Promise<void> => {
        try {
          const peers = await listLocalChatPeers(myUserId)

          if (peers.length === 0) {
            return
          }

          // 好友集合 + 自己：自我聊天必须保留
          const keepIds = new Set(currentFriends.map((friend) => friend.id))
          keepIds.add(myUserId)

          const stalePeers = peers.filter((peerId) => !keepIds.has(peerId))

          if (stalePeers.length === 0) {
            return
          }

          const removedPeers: string[] = []

          for (const peerId of stalePeers) {
            const clearedUnread = await deleteLocalFriendData(myUserId, peerId)

            // 清理失败时保留本地缓存，等下一次好友列表刷新再试
            if (clearedUnread !== null) {
              removedPeers.push(peerId)
            }
          }

          if (removedPeers.length === 0) {
            return
          }

          const removed = new Set(removedPeers)

          // 同步清理内存中的消息、历史加载状态、分页状态与草稿，避免重新加好友后看到旧缓存
          setMessages((previous) => {
            const next = { ...previous }
            removedPeers.forEach((peerId) => delete next[peerId])
            return next
          })
          setHistoryStatus((previous) => {
            const next = { ...previous }
            removedPeers.forEach((peerId) => delete next[peerId])
            return next
          })
          setPagination((previous) => {
            const next = { ...previous }
            removedPeers.forEach((peerId) => delete next[peerId])
            return next
          })
          setDrafts((previous) => {
            const next = { ...previous }
            removedPeers.forEach((peerId) => delete next[peerId])
            return next
          })

          removedPeers.forEach((peerId) => {
            syncedFriendIdsRef.current.delete(peerId)
            syncingFriendIdsRef.current.delete(peerId)
            loadedHistoryRef.current.delete(peerId)
            composerSelectionsRef.current.delete(peerId)
          })

          if (activeFriendIdRef.current && removed.has(activeFriendIdRef.current)) {
            setActiveFriendId(null)
          }

          setSelectedContactId((previousId) =>
            previousId && removed.has(previousId) ? null : previousId
          )
          setChatMenu((previousMenu) =>
            previousMenu && removed.has(previousMenu.peerId) ? null : previousMenu
          )

          await Promise.all([refreshChatEntries(), refreshUnreadTotal()])
        } finally {
          pruneInFlightRef.current = false
          prunePromiseRef.current = null
        }
      })()

      prunePromiseRef.current = run

      return run
    },
    [refreshChatEntries, refreshUnreadTotal, user?.id]
  )

  /** 进入“新的朋友”时从服务端拉取最新申请（服务端按申请时间倒序） */
  const loadFriendRequests = useCallback(async (): Promise<boolean> => {
    requestsControllerRef.current?.abort()

    const controller = new AbortController()
    requestsControllerRef.current = controller

    setRequestsStatus('loading')
    setRequestsError(null)

    try {
      const response = await getFriendRequests(requestWithAuth, controller.signal)

      if (controller.signal.aborted || !isMountedRef.current) {
        return false
      }

      // 服务端已倒序；这里再按时间兜底排序，保证同一时间内的展示顺序稳定
      const sorted = response.requests
        .slice()
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))

      setFriendRequests(sorted)
      // 红点只统计收到的待处理申请，自己发出的申请不计入
      setPendingIncomingCount(response.pendingIncomingCount)
      setRequestsStatus('ready')
      return true
    } catch (error) {
      if (controller.signal.aborted || !isMountedRef.current) {
        return false
      }

      // 401 由 AuthContext 统一登出
      if (error instanceof ApiError && error.status === 401) {
        return false
      }

      setRequestsStatus('error')
      setRequestsError(error instanceof ApiError ? error.message : '好友申请加载失败，请稍后重试。')
      return false
    }
  }, [requestWithAuth])

  // 打开“新的朋友”时刷新；关闭时作废仍在途的请求
  useEffect(() => {
    if (!requestsOpen) {
      requestsControllerRef.current?.abort()
      return
    }

    void loadFriendRequests()
  }, [requestsOpen, loadFriendRequests])

  const openFriendRequests = (): void => {
    setProfileOpen(false)
    setProfileFriend(null)
    setView('contacts')
    setRequestsOpen(true)
    setSearchQuery('')
    setAddOpen(false)
    setContactMenu(null)
    setRequestActionError(null)
  }

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
        // 优先读本地 SQLite：打开会话即可显示最近一页，不依赖网络
        let localPage: Awaited<ReturnType<typeof listLocalMessages>> | null = null

        try {
          localPage = await listLocalMessages(myUserId, friendId, { limit: MESSAGE_PAGE_SIZE })
        } catch (error) {
          // 本地读取失败不影响聊天，继续回退服务端历史
          console.warn('[localMessages] 本地历史读取失败，回退服务端', error)
        }

        if (controller.signal.aborted) {
          return
        }

        type LocalPage = NonNullable<typeof localPage>

        const applyLocalPage = (local: LocalPage): void => {
          const incoming = local.messages.map((item) => toChatMessageFromLocal(item, myUserId))

          setMessages((previous) =>
            updateConversation(previous, friendId, (list) => mergeSyncedMessages(list, incoming))
          )
          loadedHistoryRef.current.add(friendId)
          setHistoryStatus((previous) => ({ ...previous, [friendId]: 'ready' }))

          // 本地已有历史记录：确保消息列表里能看到对应会话入口
          void ensureLocalChat(myUserId, friendId).then(() => refreshChatEntries())

          // 首次成功加载才初始化分页；重新添加好友等场景保留已翻过页的游标
          setPagination((previous) =>
            previous[friendId]
              ? previous
              : updatePagination(previous, friendId, {
                  source: 'local',
                  hasMore: local.hasMore,
                  nextCursor: local.nextCursor,
                  loadingMore: false,
                  error: ''
                })
          )
        }

        // 后台同步尚未完成（含尚未开始/失败）时，本地记录可能只覆盖较早的一段：
        // 此时本地游标会落在历史中段，向上翻页将无法补齐，先按服务端分页。
        // 确认同步完整结束后，新打开的会话才优先使用本地游标。
        const localIncomplete = isFriendHistorySyncIncomplete(friendId)

        if (localPage && localPage.messages.length > 0 && !localIncomplete) {
          applyLocalPage(localPage)
          return
        }

        try {
          // 本地没有记录 / 同步未完成：使用现有服务端历史接口
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
              updateConversation(previous, friendId, (list) => mergeSyncedMessages(list, incoming))
            )
          }

          loadedHistoryRef.current.add(friendId)
          setHistoryStatus((previous) => ({ ...previous, [friendId]: 'ready' }))

          // 同一会话内只使用一种游标：本次走了服务端就保持服务端分页
          setPagination((previous) =>
            previous[friendId]
              ? previous
              : updatePagination(previous, friendId, {
                  source: 'server',
                  hasMore: page.hasMore,
                  nextCursor: page.nextCursor,
                  loadingMore: false,
                  error: ''
                })
          )

          // 服务端存在历史：确保消息列表里能看到对应会话入口
          void ensureLocalChat(myUserId, friendId).then(() => refreshChatEntries())
        } catch (error) {
          if (controller.signal.aborted) {
            return
          }

          // 服务端暂时不可访问时退回已有本地记录，避免整页空白
          if (localPage && localPage.messages.length > 0) {
            applyLocalPage(localPage)
            return
          }

          throw error
        }
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
    [refreshChatEntries, requestWithAuth, user?.id]
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
        // 分页来源在首次加载时确定，同一会话内不混用两种游标
        let incoming: ChatMessage[] = []
        let hasMore = false
        let nextCursor: string | null = null

        if (state.source === 'server') {
          const page = await getMessageHistory(requestWithAuth, friendId, {
            limit: MESSAGE_PAGE_SIZE,
            before: state.nextCursor,
            signal: controller.signal
          })

          if (controller.signal.aborted) {
            return
          }

          incoming = page.messages.map((item) => toChatMessage(item, myUserId))
          hasMore = page.hasMore
          nextCursor = page.nextCursor
        } else {
          const page = await listLocalMessages(myUserId, friendId, {
            limit: MESSAGE_PAGE_SIZE,
            before: state.nextCursor
          })

          if (controller.signal.aborted) {
            return
          }

          incoming = page.messages.map((item) => toChatMessageFromLocal(item, myUserId))
          hasMore = page.hasMore
          nextCursor = page.nextCursor
        }
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
          updateConversation(previous, friendId, (list) => mergeSyncedMessages(list, incoming))
        )
        setPagination((previous) =>
          updatePagination(previous, friendId, {
            hasMore,
            nextCursor,
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

    // 记录是否停在最新位置，供新消息到达时决定是否自动滚到底部
    stickToBottomRef.current = isNearBottom(list)

    // 滚到最新消息处才允许上报已读；停在历史消息时不推进
    if (isNearBottom(list)) {
      reportReadIfLatest(friendId, messagesRef.current[friendId]?.at(-1))
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
  }, [loadOlderMessages, reportReadIfLatest])

  // 切换到某个好友时按需加载历史消息
  useEffect(() => {
    if (!activeFriendId || loadedHistoryRef.current.has(activeFriendId)) {
      return
    }

    void loadHistory(activeFriendId)
  }, [activeFriendId, loadHistory])

  /**
   * 后台同步每写入一页后重读本地最新一页并合并。
   * 只补消息，不触碰分页状态：来源 / 游标 / hasMore 由历史初始化与翻页单独维护。
   */
  const refreshLocalHistory = useCallback(
    async (friendId: string): Promise<void> => {
      const myUserId = user?.id

      if (!myUserId || !loadedHistoryRef.current.has(friendId)) {
        return
      }

      const seq = (localReadSeqRef.current.get(friendId) ?? 0) + 1
      localReadSeqRef.current.set(friendId, seq)

      try {
        const page = await listLocalMessages(myUserId, friendId, { limit: MESSAGE_PAGE_SIZE })

        if (
          !isMountedRef.current ||
          localReadSeqRef.current.get(friendId) !== seq ||
          page.messages.length === 0
        ) {
          return
        }

        const incoming = page.messages.map((item) => toChatMessageFromLocal(item, myUserId))

        setMessages((previous) =>
          updateConversation(previous, friendId, (list) => mergeSyncedMessages(list, incoming))
        )
      } catch (error) {
        console.warn('[localMessages] 重新读取本地最新消息失败', error)
      }
    },
    [user?.id]
  )

  useEffect(() => {
    // 同步按页写入很频繁，按 250ms 窗口节流：窗口内首次立即读，其余合并到窗口末尾
    const timers = localRefreshTimersRef.current
    const lastRun = localRefreshAtRef.current

    const runRefresh = (friendId: string): void => {
      timers.delete(friendId)
      lastRun.set(friendId, Date.now())
      void refreshLocalHistory(friendId)
    }

    const scheduleRefresh = (friendId: string): void => {
      const now = Date.now()
      const wait = REFRESH_THROTTLE_MS - (now - (lastRun.get(friendId) ?? 0))
      const existing = timers.get(friendId)

      if (existing) {
        clearTimeout(existing)
        timers.delete(friendId)
      }

      if (wait <= 0) {
        runRefresh(friendId)
        return
      }

      timers.set(
        friendId,
        setTimeout(() => runRefresh(friendId), wait)
      )
    }

    const unsubscribe = subscribeLocalMessagesUpdated(scheduleRefresh)

    return () => {
      unsubscribe()

      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
    }
  }, [refreshLocalHistory])

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
    // 本批次补回的接收消息涉及哪些会话：用于整批只闪烁一次
    const syncedInboundPeers = new Set<string>()

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

        // 断线期间的消息只存在于服务端：补写本地库并计入未读，重启后数量才不会丢
        const newestKnownAt = messagesRef.current[friendId]?.at(-1)?.createdAt
        const missed = newestKnownAt
          ? page.messages.filter((item) => item.createdAt > newestKnownAt)
          : []

        if (missed.length > 0) {
          const viewingConversation = document.hasFocus() && activeFriendIdRef.current === friendId

          if (missed.some((item) => item.senderId !== myUserId)) {
            syncedInboundPeers.add(friendId)
          }

          void saveLocalMessagesAsync(
            myUserId,
            missed.map((item) => ({
              messageId: item.messageId,
              senderId: item.senderId,
              receiverId: item.receiverId,
              content: item.content,
              createdAt: item.createdAt,
              serverId: item.id
            })),
            { markUnread: !viewingConversation }
          ).then(() => refreshUnreadTotal())
        }
        syncedFriendIdsRef.current.add(friendId)
        setHistoryStatus((previous) => ({ ...previous, [friendId]: 'ready' }))
        setHistoryError((previous) => ({ ...previous, [friendId]: '' }))

        // 分页来源 / 游标 / hasMore 只由 loadHistory 与翻页维护，补拉不触碰
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

    // 断线/离线期间补回的新消息：先刷新服务端会话列表，再按“存在未免打扰的未读”
    // 在窗口不在前台时整批只闪烁一次；已读位置由服务端判定，读过的消息不会提醒。
    if (syncedInboundPeers.size > 0) {
      await refreshServerConversations()

      if (!document.hasFocus()) {
        const shouldFlash = serverConversationsRef.current.some(
          (conversation) =>
            syncedInboundPeers.has(conversation.peerId) &&
            conversation.unreadCount > 0 &&
            !conversation.isMuted
        )

        if (shouldFlash) {
          void window.api?.windowFlash?.start()
        }
      }
    }
  }, [refreshServerConversations, refreshUnreadTotal, requestWithAuth, user?.id])

  useEffect(() => {
    // 数据获取 effect：挂载时立即进入 loading 并请求好友列表
    void loadFriends()
    // 登录后立刻拉一次好友申请，保证未进入「新的朋友」前红点也是准确的
    void loadFriendRequests()
    // 登录后立即用服务端已读位置初始化未读统计
    void refreshServerConversations()

    return () => {
      requestSeqRef.current += 1
      controllerRef.current?.abort()
    }
  }, [loadFriends, loadFriendRequests, refreshServerConversations])

  // 好友列表就绪（含重新加载 / 新增 / 删除好友）后重读本地会话条目与未读数
  useEffect(() => {
    if (listStatus === 'ready') {
      void refreshChatEntries()
      void refreshUnreadTotal()
      void refreshServerConversations()
    }
  }, [listStatus, refreshChatEntries, refreshServerConversations, refreshUnreadTotal])

  // 后台同步把新消息写入本地库后，刷新消息列表的最近消息、排序与未读数
  useEffect(
    () =>
      subscribeLocalMessagesUpdated(() => {
        void refreshChatEntries()
        void refreshUnreadTotal()
      }),
    [refreshChatEntries, refreshUnreadTotal]
  )

  // 窗口重新获得焦点时：当前会话视为正在阅读，清除它的未读并同步总数
  useEffect(() => {
    const myUserId = user?.id

    const handleFocus = (): void => {
      // 窗口回到前台：任务栏闪烁立即停止
      void window.api?.windowFlash?.stop()

      // 回到窗口时同步一次好友申请，让红点反映其他用户新发来的申请
      void loadFriendRequests()

      const friendId = activeFriendIdRef.current

      // 回到前台时重新拉服务端会话与未读；只有停在最新消息处才上报已读
      void refreshServerConversations()

      if (friendId && myUserId) {
        reportReadIfLatest(friendId, messagesRef.current[friendId]?.at(-1))
      }

      void Promise.all([refreshUnreadTotal(), refreshChatEntries()])
    }

    window.addEventListener('focus', handleFocus)

    return () => window.removeEventListener('focus', handleFocus)
  }, [
    loadFriendRequests,
    refreshChatEntries,
    refreshServerConversations,
    refreshUnreadTotal,
    reportReadIfLatest,
    user?.id
  ])

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

  // 好友列表刷新成功后，与服务端好友集合做差集，清理另一端删好友留下的本地缓存
  useEffect(() => {
    if (listStatus !== 'ready') {
      return
    }

    void (async () => {
      await syncConversations()
      // 同步过程中可能有针对旧好友的在途任务重新建出会话条目，最后再核对一次
      await pruneStaleFriendCaches(friendsRef.current)
    })()
  }, [friends, listStatus, pruneStaleFriendCaches, syncConversations])

  // 断线重连：先拿最新好友列表，再核对本地缓存差集，最后用最新好友列表补拉离线消息
  const reconnectAndSync = useCallback(async (): Promise<void> => {
    const loaded = await loadFriends()

    // 好友列表没拿到时宁可不同步，也不能用旧列表或空列表去清理本地缓存
    if (!loaded) {
      return
    }

    await pruneStaleFriendCaches(friendsRef.current)
    await syncConversations()
    // 补拉后再次核对，避免同步过程中重新生成已删除好友的会话条目
    await pruneStaleFriendCaches(friendsRef.current)
  }, [loadFriends, pruneStaleFriendCaches, syncConversations])

  // Socket 连接成功（首次连接或自动重连）后补拉所有好友的离线消息；
  // 每次断开/重连都作废旧连接周期的请求，避免旧结果覆盖新周期
  useEffect(() => {
    const unsubscribe = subscribeSocketStatus((nextStatus) => {
      if (nextStatus === 'connected') {
        void reconnectAndSync()
      } else {
        resetConversationSync()
      }
    })

    return () => {
      unsubscribe()
      resetConversationSync()
    }
  }, [reconnectAndSync, resetConversationSync])

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

      // 只有“收到的对方消息 + 当前会话不在前台阅读”才计入未读
      const viewingConversation =
        document.hasFocus() && activeFriendIdRef.current === conversationId
      const shouldMarkUnread = incoming.senderId !== myUserId && !viewingConversation

      // 任务栏闪烁：只提醒“别人发来的、未免打扰的”新消息，且窗口不在前台。
      // 自己的消息（含自我聊天）永远不触发；免打扰只影响提醒，不影响入库与未读。
      if (incoming.senderId !== myUserId && !document.hasFocus()) {
        const entry = chatEntriesRef.current.find((item) => item.peerId === conversationId)

        if (!entry?.isMuted) {
          void window.api?.windowFlash?.start()
        }
      }

      // 实时消息落本地库；markUnread 由主进程写到 messages.is_unread 上做持久化
      void saveLocalMessageAsync(
        myUserId,
        {
          messageId: incoming.messageId,
          senderId: incoming.senderId,
          receiverId: incoming.receiverId,
          content: incoming.content,
          createdAt: incoming.createdAt,
          serverId: incoming.id
        },
        { markUnread: shouldMarkUnread }
      ).then(() => {
        if (shouldMarkUnread) {
          void refreshUnreadTotal()
        }
      })

      if (incoming.senderId !== myUserId) {
        if (viewingConversation && isNearBottom(messageListRef.current)) {
          // 正在最新位置阅读：立即推进服务端已读
          reportReadIfLatest(conversationId, toChatMessage(incoming, myUserId))
        }
      }

      setMessages((previous) =>
        updateConversation(previous, conversationId, (list) =>
          mergeChatMessages(list, [toChatMessage(incoming, myUserId)])
        )
      )

      // 首次收到该好友的消息即创建会话条目，并从服务端刷新会话列表（含未读数）
      void ensureLocalChat(myUserId, conversationId).then(() =>
        Promise.all([refreshChatEntries(), refreshServerConversations()])
      )
    })
  }, [
    refreshChatEntries,
    refreshServerConversations,
    refreshUnreadTotal,
    reportReadIfLatest,
    user?.id
  ])

  const activeFriend = useMemo(
    () => friendsWithSelf.find((friend) => friend.id === activeFriendId) ?? null,
    [friendsWithSelf, activeFriendId]
  )

  const activeMessages = useMemo(
    () => (activeFriendId ? (messages[activeFriendId] ?? []) : []),
    [messages, activeFriendId]
  )

  const activeDraft = activeFriendId ? (drafts[activeFriendId] ?? '') : ''

  /**
   * 输入框高度：由用户拖动输入区顶部的标识手动调整，所有会话共用。
   * 高度保存在 localStorage，发送消息或切换会话都不重置，窗口缩放时重新夹取上限。
   */
  const getComposerMaxHeight = useCallback((): number => {
    const areaHeight = chatAreaRef.current?.clientHeight ?? window.innerHeight
    return Math.max(COMPOSER_MIN_HEIGHT, Math.floor(areaHeight / 2))
  }, [])

  const persistComposerHeight = useCallback((height: number): void => {
    try {
      window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(height))
    } catch {
      // 写入失败只影响下次启动的高度，不阻断输入
    }
  }, [])

  /** 应用高度前统一夹取到 [最小高度, 聊天区一半] */
  const applyComposerHeight = useCallback(
    (height: number): void => {
      const next = Math.min(Math.max(height, COMPOSER_MIN_HEIGHT), getComposerMaxHeight())

      composerHeightRef.current = next
      setComposerHeight(next)
    },
    [getComposerMaxHeight]
  )

  useEffect(() => {
    composerHeightRef.current = composerHeight
  }, [composerHeight])

  // 拖动高度后保持聊天位置：原本贴底则继续贴底，正在看历史则保持 scrollTop
  useLayoutEffect(() => {
    const list = messageListRef.current
    const saved = composerScrollRef.current

    if (!list || !saved) {
      return
    }

    list.scrollTop = saved.stickToBottom ? list.scrollHeight : saved.scrollTop
  }, [composerHeight])

  // 窗口尺寸变化时重新检查上限，避免输入框超出聊天区域
  useEffect(() => {
    const handleResize = (): void => {
      const maxHeight = getComposerMaxHeight()

      if (composerHeightRef.current > maxHeight) {
        applyComposerHeight(maxHeight)
      }
    }

    window.addEventListener('resize', handleResize)
    handleResize()

    return () => window.removeEventListener('resize', handleResize)
  }, [applyComposerHeight, getComposerMaxHeight])

  /** 记录当前会话的光标、选区与输入框内部滚动位置，供切回时恢复 */
  const rememberComposerSelection = useCallback((): void => {
    const textarea = composerRef.current
    const friendId = activeFriendIdRef.current

    if (!textarea || !friendId) {
      return
    }

    composerSelectionsRef.current.set(friendId, {
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      scrollTop: textarea.scrollTop
    })
  }, [])

  /**
   * 切换会话后自动聚焦输入框：
   * - 只在会话真正切换时执行一次，普通重渲染与窗口重新聚焦不触发；
   * - 有草稿时恢复上次的光标 / 选区 / 内部滚动，新会话光标停在起始位置；
   * - preventScroll 保证聚焦不改变聊天页面的滚动位置。
   */
  useEffect(() => {
    if (!activeFriendId) {
      focusedComposerFriendRef.current = null
      return
    }

    if (focusedComposerFriendRef.current === activeFriendId) {
      return
    }

    focusedComposerFriendRef.current = activeFriendId

    const textarea = composerRef.current

    if (!textarea) {
      return
    }

    const saved = composerSelectionsRef.current.get(activeFriendId)
    const length = textarea.value.length
    const start = saved ? Math.min(saved.selectionStart, length) : 0
    const end = saved ? Math.min(Math.max(saved.selectionEnd, start), length) : start

    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(start, end)
    textarea.scrollTop = saved ? saved.scrollTop : 0
  }, [activeFriendId])

  const handleComposerResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const list = messageListRef.current
    composerResizeRef.current = {
      startY: event.clientY,
      startHeight: composerHeightRef.current
    }
    // 记录拖动前的阅读位置：原本贴底就保持贴底，否则固定在当前 scrollTop
    composerScrollRef.current = {
      stickToBottom: isNearBottom(list),
      scrollTop: list?.scrollTop ?? 0
    }
  }

  const handleComposerResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = composerResizeRef.current

    if (!drag) {
      return
    }

    const maxHeight = getComposerMaxHeight()
    const next = Math.min(
      Math.max(drag.startHeight + (drag.startY - event.clientY), COMPOSER_MIN_HEIGHT),
      maxHeight
    )

    if (next !== composerHeightRef.current) {
      composerHeightRef.current = next
      setComposerHeight(next)
    }
  }

  const handleComposerResizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!composerResizeRef.current) {
      return
    }

    composerResizeRef.current = null

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    composerScrollRef.current = null
    persistComposerHeight(composerHeightRef.current)
  }

  const handleMiddleColumnResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    middleColumnResizeRef.current = {
      startX: event.clientX,
      startWidth: middleColumnWidth
    }
  }

  const handleMiddleColumnResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = middleColumnResizeRef.current

    if (!drag) {
      return
    }

    const next = Math.min(
      Math.max(drag.startWidth + (event.clientX - drag.startX), MIDDLE_COLUMN_MIN_WIDTH),
      MIDDLE_COLUMN_MAX_WIDTH
    )

    setMiddleColumnWidth((current) => (current === next ? current : next))
  }

  const handleMiddleColumnResizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!middleColumnResizeRef.current) {
      return
    }

    middleColumnResizeRef.current = null

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /** 在光标位置插入 Emoji；插入后保持焦点与光标位置，方便继续输入 */
  const insertEmoji = (emoji: string): void => {
    if (!activeFriendId) {
      return
    }

    const textarea = composerRef.current
    const current = drafts[activeFriendId] ?? ''
    const start = textarea ? textarea.selectionStart : current.length
    const end = textarea ? textarea.selectionEnd : current.length
    const next = current.slice(0, start) + emoji + current.slice(end)

    if (next.length > MAX_MESSAGE_LENGTH) {
      return
    }

    const caret = start + emoji.length

    setDrafts((previous) => ({ ...previous, [activeFriendId]: next }))
    // 选中表情后收起面板，光标仍回到原插入位置
    setEmojiOpen(false)

    // 等 React 提交新值后再设置光标，避免光标被重置到末尾
    window.setTimeout(() => {
      const element = composerRef.current

      if (!element) {
        return
      }

      element.focus({ preventScroll: true })
      element.setSelectionRange(caret, caret)
      rememberComposerSelection()
    }, 0)
  }

  // 点击面板外部或按 Esc 关闭表情面板
  useEffect(() => {
    if (!emojiOpen) {
      return
    }

    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node

      if (emojiPanelRef.current?.contains(target) || emojiButtonRef.current?.contains(target)) {
        return
      }

      setEmojiOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setEmojiOpen(false)
      }
    }

    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [emojiOpen])

  const activeHistoryStatus = activeFriendId ? historyStatus[activeFriendId] : undefined
  const activeHistoryError = activeFriendId ? (historyError[activeFriendId] ?? '') : ''
  const activePagination = activeFriendId ? pagination[activeFriendId] : undefined

  const friendById = useMemo(
    () => new Map(friendsWithSelf.map((friend) => [friend.id, friend])),
    [friendsWithSelf]
  )

  /**
   * 消息列表排序：
   * - 服务端会话列表可用时，直接沿用服务端排序（置顶优先、最近活动时间倒序），
   *   最近消息内容仍从本地消息缓存补全；
   * - 服务端不可用时，用本地缓存排序兜底；
   * - 已删除的好友不出现在列表里（聊天记录仍保留在本地）。
   */
  const chatRows = useMemo<LocalChatSummary[]>(() => {
    if (serverConversationsReady) {
      const previewById = new Map(
        chatEntries.map((entry) => [entry.peerId, entry.lastMessageContent])
      )

      return serverConversations
        .filter((conversation) => friendById.has(conversation.peerId))
        .map((conversation) => ({
          peerId: conversation.peerId,
          createdAtUs: 0,
          lastOpenedAtUs: conversation.lastOpenedAt
            ? parseMessageTime(conversation.lastOpenedAt) * 1000
            : 0,
          lastMessageContent: previewById.get(conversation.peerId) ?? null,
          lastMessageAtUs: conversation.lastMessageAt
            ? parseMessageTime(conversation.lastMessageAt) * 1000
            : null,
          unreadCount: conversation.unreadCount,
          isPinned: conversation.isPinned,
          isMuted: conversation.isMuted
        }))
    }

    return chatEntries
      .filter((entry) => friendById.has(entry.peerId))
      .slice()
      .sort((left, right) => {
        if (left.isPinned !== right.isPinned) {
          return left.isPinned ? -1 : 1
        }

        const leftAt = left.lastMessageAtUs
        const rightAt = right.lastMessageAtUs

        if (leftAt !== null && rightAt !== null) {
          return rightAt - leftAt
        }

        if (leftAt !== null) {
          return -1
        }

        if (rightAt !== null) {
          return 1
        }

        return right.lastOpenedAtUs - left.lastOpenedAtUs
      })
  }, [chatEntries, friendById, serverConversations, serverConversationsReady])

  /** 当前右键菜单对应的会话（列表刷新后状态仍以最新数据为准） */
  const menuChatEntry = useMemo(
    () => (chatMenu ? (chatRows.find((entry) => entry.peerId === chatMenu.peerId) ?? null) : null),
    [chatMenu, chatRows]
  )

  /** 会话设置侧边栏对应的会话：开关显示服务端当前状态 */
  const activeChatEntry = useMemo(
    () =>
      activeFriendId ? (chatRows.find((entry) => entry.peerId === activeFriendId) ?? null) : null,
    [activeFriendId, chatRows]
  )

  /**
   * 星标联系人：单独置顶，按标记时间从新到旧；不参与下面的 A-Z 分组。
   * 星标状态来自好友列表接口（服务端 friendships 记录），未星标的 starredAt 为 null。
   */
  const starredFriends = useMemo(() => {
    return friends
      .filter((friend) => friend.isStarred)
      .slice()
      .sort((left, right) => {
        const leftAt = left.starredAt ? Date.parse(left.starredAt) : 0
        const rightAt = right.starredAt ? Date.parse(right.starredAt) : 0
        return rightAt - leftAt
      })
  }, [friends])

  const contactGroups = useMemo(
    () =>
      groupContacts(
        friendsWithSelf.filter((friend) => !friend.isStarred),
        getDisplayName
      ),
    [friendsWithSelf]
  )

  /**
   * 好友列表尚未就绪或加载失败时的兜底分组：只渲染自己的条目，
   * 避免网络异常时连自我聊天入口都看不到。
   */
  const selfFallbackGroups = useMemo(
    () => (selfFriend && listStatus !== 'ready' ? groupContacts([selfFriend], getDisplayName) : []),
    [selfFriend, listStatus]
  )

  /** 搜索只在当前好友列表内按昵称匹配（包含自己，便于打开自我聊天） */
  const searchResults = useMemo(() => {
    const keyword = searchQuery.trim().toLocaleLowerCase()

    if (keyword === '') {
      return []
    }

    return friendsWithSelf.filter((friend) =>
      getDisplayName(friend).toLocaleLowerCase().includes(keyword)
    )
  }, [friendsWithSelf, searchQuery])
  const contactLetters = useMemo(() => contactGroups.map((group) => group.letter), [contactGroups])
  // 有服务端未读时以服务端为准；首次拉取失败时回退到本地统计
  const displayedUnreadTotal = serverUnreadReady ? serverUnreadTotal : unreadTotal

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
    const switchedConversation = previousActiveFriendRef.current !== activeFriendId
    previousActiveFriendRef.current = activeFriendId

    if (restore && activeFriendId) {
      scrollRestoreRef.current.delete(activeFriendId)
      list.scrollTop = restore.top + (list.scrollHeight - restore.height)
      stickToBottomRef.current = false
      return
    }

    // 切换会话必须定位到最新；同一会话里新消息只在原本贴底时才跟随，避免打断历史阅读
    if (switchedConversation || stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [activeFriendId, activeMessages])

  // 消息渲染并滚到底后，若确实停在最新位置，就把最后一条服务端消息上报为已读
  useEffect(() => {
    if (!activeFriendId) {
      return
    }

    reportReadIfLatest(activeFriendId, activeMessages.at(-1))
  }, [activeMessages, activeFriendId, reportReadIfLatest])

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

        // 服务端已确认写入，此时才落本地库（离线/失败重发不会提前保存）
        saveLocalMessage(user?.id, {
          messageId: ack.message.messageId,
          senderId: ack.message.senderId,
          receiverId: ack.message.receiverId,
          content: ack.message.content,
          createdAt: ack.message.createdAt,
          serverId: ack.message.id
        })

        // 首次成功发送消息即创建会话条目（已存在不会重复创建）
        void ensureLocalChat(user?.id, friendId).then(() => refreshChatEntries())
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
    [refreshChatEntries, user?.id]
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
    // 发送后该会话的光标 / 选区从起始位置重新开始，输入框高度保持不变
    composerSelectionsRef.current.delete(friendId)
    void deliverMessage(friendId, messageId, text)
  }

  const retryMessage = (friendId: string, message: ChatMessage): void => {
    if (message.status !== 'failed') {
      return
    }

    void deliverMessage(friendId, message.messageId, message.text)
  }

  const handleDraftChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    if (!activeFriendId) {
      return
    }

    const friendId = activeFriendId
    const value = event.target.value.slice(0, MAX_MESSAGE_LENGTH)

    setDrafts((previous) => ({ ...previous, [friendId]: value }))
  }

  // 按 Enter 发送；Shift + Enter 换行；使用中文输入法选词时（isComposing 为 true）不发送
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
      return
    }

    // Shift + Enter 保留默认行为，在光标处插入换行
    if (event.shiftKey) {
      return
    }

    event.preventDefault()
    sendMessage()
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    sendMessage()
  }

  /** 同意 / 拒绝好友申请：同意后刷新好友列表，申请列表始终以服务端为准 */
  const handleRequestDecision = async (
    item: FriendRequestItem,
    action: 'accept' | 'reject'
  ): Promise<void> => {
    if (requestActionRef.current) {
      return
    }

    requestActionRef.current = true
    setRequestActionId(item.id)
    setRequestActionError(null)

    try {
      if (action === 'accept') {
        await acceptFriendRequest(requestWithAuth, item.id)
      } else {
        await rejectFriendRequest(requestWithAuth, item.id)
      }

      if (!isMountedRef.current) {
        return
      }

      if (action === 'accept') {
        // 新好友要重新从服务端拉历史；本地记录（若存在）按 messageId 合并保留
        loadedHistoryRef.current.delete(item.user.id)
        syncedFriendIdsRef.current.delete(item.user.id)
        syncingFriendIdsRef.current.delete(item.user.id)
        await loadFriends()
      }

      if (!isMountedRef.current) {
        return
      }

      await loadFriendRequests()
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      // 401 由 AuthContext 统一登出
      if (error instanceof ApiError && error.status === 401) {
        return
      }

      setRequestActionError(getFriendRequestErrorMessage(error))
    } finally {
      requestActionRef.current = false

      if (isMountedRef.current) {
        setRequestActionId(null)
      }
    }
  }

  const showToast = useCallback((message: string): void => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
    }

    setToast(message)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, 1000)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  const openAddFriend = (): void => {
    setAddOpen(true)
    setSearchQuery('')
    setAddUid('')
    setAddError(null)
  }

  const closeAddFriend = (): void => {
    if (addSubmittingRef.current) {
      return
    }

    setAddOpen(false)
    setAddUid('')
    setAddError(null)
  }

  const handleAddFriend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    // ref 抢占，防止连续点击/回车在状态更新前重复提交
    if (addSubmittingRef.current) {
      return
    }

    const uid = addUid.trim()

    if (!uid) {
      setAddError('请输入对方 UID')
      return
    }

    addSubmittingRef.current = true
    setAddSubmitting(true)
    setAddError(null)

    try {
      await sendFriendRequest(requestWithAuth, uid)

      if (!isMountedRef.current) {
        return
      }

      setAddOpen(false)
      setAddUid('')
      showToast('已成功发送好友申请，等待对方验证')

      // 保持当前页面，不自动跳转；已在申请页时刷新列表
      if (requestsOpen) {
        await loadFriendRequests()
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

  /** 标记 / 取消星标：先乐观更新界面，请求失败时回滚到服务端确认前的状态 */
  const toggleContactStar = async (friend: Friend): Promise<void> => {
    if (starUpdatingRef.current) {
      return
    }

    starUpdatingRef.current = true

    const previousStarredAt = friend.starredAt
    const previousIsStarred = friend.isStarred
    const nextStarred = !previousIsStarred

    setFriends((previous) =>
      previous.map((item) =>
        item.id === friend.id
          ? {
              ...item,
              isStarred: nextStarred,
              starredAt: nextStarred ? new Date().toISOString() : null
            }
          : item
      )
    )

    try {
      const state = await setFriendStar(requestWithAuth, friend.id, nextStarred)

      if (!isMountedRef.current) {
        return
      }

      // 以服务端返回的时间为准，保证星标分组内排序稳定（最近标记在前）
      setFriends((previous) =>
        previous.map((item) =>
          item.id === friend.id
            ? { ...item, isStarred: state.isStarred, starredAt: state.starredAt }
            : item
        )
      )
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      setFriends((previous) =>
        previous.map((item) =>
          item.id === friend.id
            ? { ...item, isStarred: previousIsStarred, starredAt: previousStarredAt }
            : item
        )
      )

      // 401 由 AuthContext 统一登出
      if (error instanceof ApiError && error.status === 401) {
        return
      }

      setDeleteNotice('设置星标失败，请稍后再试')
      setDeleteNoticeWarning(true)
    } finally {
      starUpdatingRef.current = false
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
      setProfileFriend((current) => (current?.id === friend.id ? null : current))

      // 星标随好友关系记录一起由服务端删除；重新添加后即普通联系人

      // 服务端已删除双方云端消息与会话，这里清理本机当前账号的缓存：
      // 本地消息、会话条目、同步游标与未读。清理失败不推翻服务端删除结果。
      const clearedUnread = await deleteLocalFriendData(user?.id, friend.id)

      if (!isMountedRef.current) {
        return
      }

      if (activeFriendIdRef.current === friend.id) {
        setActiveFriendId(null)
      }

      setMessages((previous) => {
        if (!(friend.id in previous)) {
          return previous
        }

        const next = { ...previous }
        delete next[friend.id]
        return next
      })

      // 已删除好友不再参与当前连接周期的自动同步
      syncedFriendIdsRef.current.delete(friend.id)
      syncingFriendIdsRef.current.delete(friend.id)
      loadedHistoryRef.current.delete(friend.id)

      if (clearedUnread !== null) {
        void refreshUnreadTotal()
      }

      // 以服务端重新返回的列表为准；当前好友被删时自动选中第一个剩余好友
      const refreshed = await loadFriends()

      if (!isMountedRef.current) {
        return
      }

      if (clearedUnread === null) {
        setDeleteNotice('好友已删除，但本地缓存清理失败，请重启应用后重试。')
        setDeleteNoticeWarning(true)
      } else if (refreshed) {
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

  // 账户菜单：点击其它位置或按 Esc 关闭
  useEffect(() => {
    if (!railMenuOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!railFooterRef.current?.contains(event.target as Node)) {
        setRailMenuOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setRailMenuOpen(false)
      }
    }

    // 点击窗口外（窗口失焦）时也收起菜单，避免菜单残留在前台
    const handleBlur = (): void => setRailMenuOpen(false)

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', handleBlur)
    }
  }, [railMenuOpen])

  // 联系人右键菜单：点击菜单外部、按 Esc 或窗口失焦时关闭
  useEffect(() => {
    if (!contactMenu) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!contactMenuRef.current?.contains(event.target as Node)) {
        setContactMenu(null)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setContactMenu(null)
      }
    }

    const handleBlur = (): void => setContactMenu(null)

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', handleBlur)
    }
  }, [contactMenu])

  // 会话设置侧边栏：点击面板与齿轮以外的位置、按 Esc 或窗口失焦时关闭
  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null

      if (!target) {
        return
      }

      if (chatSettingsRef.current?.contains(target)) {
        return
      }

      if (chatSettingsButtonRef.current?.contains(target)) {
        return
      }

      setSettingsOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }

    const handleBlur = (): void => setSettingsOpen(false)

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', handleBlur)
    }
  }, [settingsOpen])

  // 切换会话、进入联系人或其他页面时自动关闭会话设置
  useEffect(() => {
    setSettingsOpen(false)
  }, [activeFriendId, requestsOpen, view])

  // 删除好友确认弹窗：按 Esc 关闭；正在提交时不允许中断
  useEffect(() => {
    if (!pendingDeleteId) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !deleteSubmittingRef.current) {
        setPendingDeleteId(null)
        setDeleteError(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pendingDeleteId])

  // 菜单项按数组维护，后续新增选项只需追加一项
  const railMenuItems: { key: string; label: string; onSelect: () => void }[] = [
    { key: 'password', label: '修改密码', onSelect: () => setPasswordOpen(true) },
    { key: 'logout', label: '退出登录', onSelect: logout }
  ]

  const connectionState = getConnectionState(connectionStatus)

  // 右键菜单 / 删除确认指向的联系人；好友列表刷新后可能已不存在，按空处理
  const menuFriend = contactMenu ? friendById.get(contactMenu.friendId) : undefined
  const pendingDeleteFriend = pendingDeleteId ? friendById.get(pendingDeleteId) : undefined

  /**
   * 通讯录联系人整行：
   * 单击只选中；双击整行打开聊天；右键在鼠标附近弹出操作菜单。
   */
  // 联系人整行单击进入资料页的延迟定时器：留出双击打开聊天的时间窗
  const pendingContactProfileRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (pendingContactProfileRef.current !== null) {
        window.clearTimeout(pendingContactProfileRef.current)
      }
    }
  }, [])

  const cancelPendingContactProfile = (): void => {
    if (pendingContactProfileRef.current !== null) {
      window.clearTimeout(pendingContactProfileRef.current)
      pendingContactProfileRef.current = null
    }
  }

  /** 从联系人列表打开好友资料页：只覆盖右侧区域，保留当前会话与草稿 */
  const openFriendProfile = (friend: Friend): void => {
    setProfileFriend(friend)
    setProfileOpen(false)
    setRequestsOpen(false)
    setSettingsOpen(false)
    setEmojiOpen(false)
    setChatMenu(null)
    setContactMenu(null)
    setRailMenuOpen(false)
  }

  /** 联系人条目统一入口：自己进入自己的资料页，好友进入好友资料页 */
  const openContactProfile = (friend: Friend): void => {
    if (friend.id !== user?.id) {
      openFriendProfile(friend)
      return
    }

    setProfileFriend(null)
    setProfileOpen(true)
    setRequestsOpen(false)
    setSettingsOpen(false)
    setEmojiOpen(false)
    setChatMenu(null)
    setContactMenu(null)
    setRailMenuOpen(false)
  }

  /** 单击整行进入资料页；双击时由 cancelPendingContactProfile 取消，改为打开聊天 */
  const scheduleContactProfile = (friend: Friend): void => {
    setSelectedContactId(friend.id)
    cancelPendingContactProfile()
    pendingContactProfileRef.current = window.setTimeout(() => {
      pendingContactProfileRef.current = null
      openContactProfile(friend)
    }, 180)
  }

  const renderFriendRow = (friend: Friend): ReactNode => {
    const displayName = getDisplayName(friend)
    const starred = friend.isStarred
    const isSelf = friend.id === user?.id

    return (
      <div className="friend-block" key={friend.id}>
        <div
          className="friend-row"
          onDoubleClick={() => {
            cancelPendingContactProfile()
            openConversationFromContacts(friend.id)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setSelectedContactId(friend.id)
            setContactMenu({ friendId: friend.id, x: event.clientX, y: event.clientY })
          }}
        >
          <button
            type="button"
            className={friend.id === selectedContactId ? 'friend-item selected' : 'friend-item'}
            onClick={() => scheduleContactProfile(friend)}
          >
            <span className="avatar">
              <Avatar avatarUrl={friend.avatarUrl} />
              {!isSelf && onlineFriendIds.has(friend.id) && (
                <span className="online-dot" aria-label="在线" />
              )}
            </span>
            <span className="friend-info">
              <span className="friend-name">
                {starred && (
                  <span className="friend-star" aria-label="星标联系人">
                    ★
                  </span>
                )}
                {displayName}
              </span>
            </span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* 左：导航栏 */}
      <nav className="rail" aria-label="主导航">
        <button
          type="button"
          className="rail-profile"
          title={user?.nickname ?? '当前用户'}
          aria-label="个人资料"
          onClick={() => {
            setProfileFriend(null)
            setProfileOpen(true)
            setRequestsOpen(false)
            setSettingsOpen(false)
            setEmojiOpen(false)
            setChatMenu(null)
            setContactMenu(null)
            setRailMenuOpen(false)
          }}
        >
          <span className="rail-avatar" aria-hidden="true">
            <Avatar avatarUrl={selfAvatarUrl} />
          </span>
          <span
            className={`rail-presence ${connectionState.tone}`}
            role="status"
            aria-label={connectionState.text}
            title={connectionState.text}
          />
        </button>

        <div className="rail-nav">
          <button
            className={view === 'messages' ? 'rail-item active' : 'rail-item'}
            type="button"
            title="消息"
            aria-label="消息"
            aria-current={view === 'messages' ? 'page' : undefined}
            onClick={() => {
              setRequestsOpen(false)
              setProfileOpen(false)
              setProfileFriend(null)
              setView('messages')
            }}
          >
            <span className="badge-anchor">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4.5 5.8h15a1.5 1.5 0 0 1 1.5 1.5v8.4a1.5 1.5 0 0 1-1.5 1.5H9.2l-3.9 3v-3H4.5A1.5 1.5 0 0 1 3 15.7V7.3a1.5 1.5 0 0 1 1.5-1.5Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="M7.5 10.2h9M7.5 13.4h5.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <Badge count={displayedUnreadTotal} className="badge-overlay" />
            </span>
          </button>

          <button
            className={view === 'contacts' ? 'rail-item active' : 'rail-item'}
            type="button"
            title="联系人"
            aria-label="联系人"
            aria-current={view === 'contacts' ? 'page' : undefined}
            onClick={() => {
              setRequestsOpen(false)
              setProfileOpen(false)
              setProfileFriend(null)
              setView('contacts')
            }}
          >
            <span className="badge-anchor">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M8.8 11.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <path
                  d="M2.5 19.6c0-3.1 2.8-5.4 6.3-5.4s6.3 2.3 6.3 5.4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path
                  d="M16.2 10.9a2.7 2.7 0 1 0 0-5.4M17.9 19.6c0-2.3-1-4.1-2.7-5.2a6 6 0 0 1 6.3 5.2"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <Badge count={pendingIncomingCount} className="badge-overlay" />
            </span>
          </button>
        </div>

        <div className="rail-footer" ref={railFooterRef}>
          {railMenuOpen ? (
            <div className="rail-menu" role="menu" aria-label="账户菜单">
              {railMenuItems.map((item) => (
                <button
                  key={item.key}
                  className="rail-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRailMenuOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          <button
            className={railMenuOpen ? 'rail-item active' : 'rail-item'}
            type="button"
            title="菜单"
            aria-label="菜单"
            aria-haspopup="menu"
            aria-expanded={railMenuOpen}
            onClick={() => setRailMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="6" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="18" cy="12" r="1.7" fill="currentColor" />
            </svg>
          </button>
        </div>
      </nav>

      {/* 中：消息列表 / 通讯录 */}
      <section className="contacts" style={{ width: `${middleColumnWidth}px` }}>
        {/* 整条右边框都可拖动，用于调整中栏宽度 */}
        <div
          className="contacts-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整中间栏宽度"
          title="拖动调整中间栏宽度"
          onPointerDown={handleMiddleColumnResizeStart}
          onPointerMove={handleMiddleColumnResizeMove}
          onPointerUp={handleMiddleColumnResizeEnd}
          onPointerCancel={handleMiddleColumnResizeEnd}
        />
        {/* 固定顶部：搜索框 + 添加好友入口，切换视图时位置与尺寸不变 */}
        <div className="contacts-top">
          <header className="contacts-header">
            <input
              className="contacts-search"
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setAddOpen(false)
              }}
              placeholder="搜索联系人"
              aria-label="搜索联系人"
            />
            <button
              className="contacts-add"
              type="button"
              onClick={openAddFriend}
              title="添加好友"
              aria-label="添加好友"
            >
              ＋
            </button>
          </header>

          {addOpen ? (
            <div className="contacts-dropdown">
              <form className="add-friend-form" onSubmit={handleAddFriend}>
                <input
                  className="add-friend-input"
                  type="text"
                  value={addUid}
                  onChange={(event) => setAddUid(event.target.value)}
                  placeholder="输入对方 UID"
                  aria-label="好友 UID"
                  inputMode="numeric"
                  autoFocus
                  disabled={addSubmitting}
                />

                <div className="add-friend-actions">
                  <button
                    className="add-friend-submit"
                    type="submit"
                    disabled={addSubmitting || addUid.trim() === ''}
                  >
                    {addSubmitting ? '发送中…' : '发送申请'}
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
            </div>
          ) : (
            searchQuery.trim() !== '' && (
              <div className="contacts-dropdown">
                {searchResults.length === 0 ? (
                  <p className="search-empty">未找到匹配的联系人</p>
                ) : (
                  searchResults.map((friend) => {
                    const displayName = getDisplayName(friend)

                    return (
                      <button
                        key={friend.id}
                        type="button"
                        className="search-result"
                        onClick={() => openConversationFromSearch(friend.id)}
                      >
                        <span className="avatar avatar-sm" aria-hidden="true">
                          <Avatar avatarUrl={friend.avatarUrl} />
                          {onlineFriendIds.has(friend.id) && (
                            <span className="online-dot" aria-label="在线" />
                          )}
                        </span>
                        <span className="search-result-name">{displayName}</span>
                      </button>
                    )
                  })
                )}
              </div>
            )
          )}
        </div>

        <div className="contacts-tools">
          {deleteNotice && (
            <p className={`add-friend-notice ${deleteNoticeWarning ? 'warning' : 'success'}`}>
              {deleteNotice}
            </p>
          )}
        </div>

        {view === 'messages' ? (
          <div className="chat-list">
            {listStatus === 'loading' && <p className="list-state">正在加载会话…</p>}

            {listStatus === 'error' && (
              <div className="list-state list-state-error">
                <p>{listError ?? '会话列表加载失败'}</p>
                <button className="list-retry" type="button" onClick={() => void loadFriends()}>
                  重新加载
                </button>
              </div>
            )}

            {listStatus === 'ready' && chatRows.length === 0 && (
              <p className="list-state">还没有会话，在通讯录双击联系人开始聊天</p>
            )}

            {listStatus === 'ready' &&
              chatRows.map((entry) => {
                const friend = friendById.get(entry.peerId)

                if (!friend) {
                  return null
                }

                const displayName = getDisplayName(friend)
                const timeLabel = formatChatListTime(entry.lastMessageAtUs)
                const isSelfChat = entry.peerId === user?.id
                const unreadCount = isSelfChat ? 0 : (serverUnread[entry.peerId] ?? 0)

                return (
                  <button
                    key={entry.peerId}
                    type="button"
                    className={[
                      'chat-entry',
                      entry.peerId === activeFriendId ? 'active' : '',
                      entry.isPinned ? 'pinned' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => void openConversation(entry.peerId)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setChatMenu({ peerId: entry.peerId, x: event.clientX, y: event.clientY })
                    }}
                  >
                    <span className="chat-entry-avatar">
                      <span className="avatar" aria-hidden="true">
                        <Avatar avatarUrl={friend.avatarUrl} />
                      </span>
                      {unreadCount > 0 && (
                        <Badge
                          count={unreadCount}
                          className="badge-overlay"
                          label={`${unreadCount} 条未读消息`}
                        />
                      )}
                      {!isSelfChat && onlineFriendIds.has(entry.peerId) && (
                        <span className="online-dot" aria-label="在线" />
                      )}
                    </span>

                    <span className="chat-entry-body">
                      <span className="chat-entry-top">
                        <span className="chat-entry-name">{displayName}</span>
                        {entry.isPinned && <span className="chat-flag">置顶</span>}
                        {entry.isMuted && <span className="chat-flag">免打扰</span>}
                        {timeLabel !== '' && <span className="chat-entry-time">{timeLabel}</span>}
                      </span>
                      <span className="chat-entry-preview">
                        {entry.lastMessageContent ?? '还没有消息'}
                      </span>
                    </span>
                  </button>
                )
              })}
          </div>
        ) : (
          <div className="contact-pane">
            {/* 固定在联系人列表顶部：新的朋友（好友申请）入口 */}
            <button
              type="button"
              className={
                requestsOpen
                  ? 'friend-item new-friends-entry selected'
                  : 'friend-item new-friends-entry'
              }
              onClick={openFriendRequests}
              aria-label="新的朋友"
            >
              <span className="new-friends-avatar-wrap">
                <span className="avatar new-friends-avatar" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="10" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.6" />
                    <path
                      d="M3.6 19.2c0-3.1 2.9-5.4 6.4-5.4 1.3 0 2.5.3 3.5.9"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                    <path
                      d="M17.6 14.4v5.4M14.9 17.1h5.4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                {pendingIncomingCount > 0 && (
                  <Badge
                    count={pendingIncomingCount}
                    className="badge-overlay"
                    label={`${pendingIncomingCount} 条待处理好友申请`}
                  />
                )}
              </span>
              <span className="friend-info">
                <span className="friend-name">新的朋友</span>
                <span className="friend-preview">好友申请</span>
              </span>
            </button>

            <div className="contact-scroll">
              {listStatus === 'loading' && <p className="list-state">正在加载好友…</p>}

              {listStatus === 'error' && (
                <div className="list-state list-state-error">
                  <p>{listError ?? '好友列表加载失败'}</p>
                  <button className="list-retry" type="button" onClick={() => void loadFriends()}>
                    重新加载
                  </button>
                </div>
              )}

              {selfFallbackGroups.map((group) => (
                <div key={`self-${group.letter}`} className="contact-group">
                  <p className="contact-group-title">{group.letter}</p>
                  {group.friends.map(renderFriendRow)}
                </div>
              ))}

              {listStatus === 'ready' && starredFriends.length > 0 && (
                <div className="contact-group">
                  <p className="contact-group-title">星标联系人</p>
                  {starredFriends.map(renderFriendRow)}
                </div>
              )}

              {listStatus === 'ready' &&
                contactGroups.map((group) => (
                  <div
                    key={group.letter}
                    className="contact-group"
                    ref={(element) => {
                      if (element) {
                        groupRefs.current.set(group.letter, element)
                      } else {
                        groupRefs.current.delete(group.letter)
                      }
                    }}
                  >
                    <p className="contact-group-title">{group.letter}</p>
                    {group.friends.map(renderFriendRow)}
                  </div>
                ))}
            </div>

            {contactLetters.length > 0 && (
              <nav className="letter-index" aria-label="按首字母索引">
                {contactLetters.map((letter) => (
                  <button
                    key={letter}
                    type="button"
                    className="letter-index-item"
                    onClick={() =>
                      groupRefs.current.get(letter)?.scrollIntoView({ block: 'start' })
                    }
                  >
                    {letter}
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
      </section>

      {/* 右：聊天区域 */}
      <main className="chat" ref={chatAreaRef}>
        <div
          className={profileOpen || profileFriend ? 'chat-stage chat-stage-hidden' : 'chat-stage'}
        >
          {requestsOpen ? (
            <section className="requests-panel" aria-label="好友申请">
              <header className="chat-header requests-header">
                <div className="chat-title">
                  <span className="chat-name">新的朋友</span>
                </div>
              </header>

              <div className="requests-body">
                {requestsStatus === 'loading' && friendRequests.length === 0 && (
                  <p className="list-state">正在加载好友申请…</p>
                )}

                {requestsStatus === 'error' && (
                  <div className="list-state list-state-error">
                    <p>{requestsError ?? '好友申请加载失败'}</p>
                    <button
                      className="list-retry"
                      type="button"
                      onClick={() => void loadFriendRequests()}
                    >
                      重新加载
                    </button>
                  </div>
                )}

                {requestActionError && <p className="request-action-error">{requestActionError}</p>}

                {requestsStatus === 'ready' && friendRequests.length === 0 && (
                  <p className="list-state">还没有好友申请</p>
                )}

                {friendRequests.map((item) => {
                  const displayName = item.user.nickname
                  const isIncomingPending =
                    item.direction === 'incoming' && item.status === 'pending'
                  const handling = requestActionId === item.id

                  return (
                    <div className="request-row" key={item.id}>
                      <span className="avatar" aria-hidden="true">
                        <Avatar avatarUrl={item.user.avatarUrl} />
                      </span>

                      <div className="request-info">
                        <span className="request-name">{displayName}</span>
                        <span className="request-meta">
                          {item.direction === 'incoming' ? '请求添加你为好友' : '你发送的申请'} ·{' '}
                          {formatTimeLabel(item.createdAt)}
                        </span>
                      </div>

                      <div className="request-actions">
                        {isIncomingPending ? (
                          <>
                            <button
                              className="request-accept"
                              type="button"
                              disabled={requestActionId !== null}
                              onClick={() => void handleRequestDecision(item, 'accept')}
                            >
                              {handling ? '处理中…' : '同意'}
                            </button>
                            <button
                              className="request-reject"
                              type="button"
                              disabled={requestActionId !== null}
                              onClick={() => void handleRequestDecision(item, 'reject')}
                            >
                              拒绝
                            </button>
                          </>
                        ) : (
                          <span className={`request-status ${item.status}`}>
                            {getFriendRequestStatusLabel(item.status)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ) : view === 'contacts' ? null : activeFriend ? (
            <>
              {/* 顶部只保留昵称与在线绿点；自我聊天没有在线状态 */}
              <header className="chat-header">
                <span className="chat-header-avatar" aria-hidden="true">
                  <Avatar avatarUrl={activeFriend.avatarUrl} />
                </span>
                <span className="chat-name">{getDisplayName(activeFriend)}</span>
                {activeFriend.id !== user?.id && onlineFriendIds.has(activeFriend.id) && (
                  <span className="chat-online-dot" role="img" aria-label="在线" />
                )}
                <button
                  ref={chatSettingsButtonRef}
                  className="chat-settings-toggle"
                  type="button"
                  aria-label="聊天设置"
                  aria-expanded={settingsOpen}
                  title="聊天设置"
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.6" />
                    <path
                      d="M19.1 13.5a7.6 7.6 0 0 0 0-3l1.6-1.2-1.9-3.3-1.9.8a7.7 7.7 0 0 0-2.6-1.5L14 3.3h-4l-.3 2a7.7 7.7 0 0 0-2.6 1.5l-1.9-.8-1.9 3.3 1.6 1.2a7.6 7.6 0 0 0 0 3l-1.6 1.2 1.9 3.3 1.9-.8a7.7 7.7 0 0 0 2.6 1.5l.3 2h4l.3-2a7.7 7.7 0 0 0 2.6-1.5l1.9.8 1.9-3.3-1.6-1.2Z"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </header>

              <div className="chat-body">
                <div className="chat-main">
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

                    {activeMessages.map((message, index) => {
                      const previousCreatedAt =
                        index > 0 ? activeMessages[index - 1].createdAt : null
                      const timeLabel = shouldShowTimeLabel(previousCreatedAt, message.createdAt)
                        ? formatTimeLabel(message.createdAt)
                        : ''

                      return (
                        <Fragment key={message.messageId}>
                          {timeLabel !== '' && <div className="time-divider">{timeLabel}</div>}

                          <div className={message.mine ? 'message-row mine' : 'message-row'}>
                            {!message.mine && (
                              <span className="message-avatar" aria-hidden="true">
                                <Avatar avatarUrl={activeFriend.avatarUrl} />
                              </span>
                            )}

                            <div
                              className={
                                message.status === 'failed' ? 'bubble bubble-failed' : 'bubble'
                              }
                            >
                              <p className="bubble-text">{message.text}</p>
                              {message.status === 'sending' && (
                                <span className="bubble-status">发送中…</span>
                              )}
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

                            {message.mine && (
                              <span className="message-avatar" aria-hidden="true">
                                <Avatar avatarUrl={selfAvatarUrl} />
                              </span>
                            )}
                          </div>
                        </Fragment>
                      )
                    })}
                  </div>

                  <form className="composer" onSubmit={handleSubmit}>
                    <div
                      className="composer-resize-handle"
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="拖动调整输入框高度"
                      title="拖动调整输入框高度"
                      onPointerDown={handleComposerResizeStart}
                      onPointerMove={handleComposerResizeMove}
                      onPointerUp={handleComposerResizeEnd}
                      onPointerCancel={handleComposerResizeEnd}
                    />
                    <div className="composer-input-row">
                      <textarea
                        className="composer-input"
                        ref={composerRef}
                        rows={1}
                        style={{ height: `${composerHeight}px` }}
                        value={activeDraft}
                        maxLength={MAX_MESSAGE_LENGTH}
                        onChange={handleDraftChange}
                        onKeyDown={handleComposerKeyDown}
                        onKeyUp={rememberComposerSelection}
                        onSelect={rememberComposerSelection}
                        onScroll={rememberComposerSelection}
                        onBlur={rememberComposerSelection}
                        placeholder="输入消息，按 Enter 发送"
                        aria-label="消息输入框"
                      />
                    </div>

                    {/* 底部操作区：表情入口固定在输入框左下角，不随内容高度移动 */}
                    <div className="composer-actions">
                      <button
                        ref={emojiButtonRef}
                        type="button"
                        className={emojiOpen ? 'emoji-toggle open' : 'emoji-toggle'}
                        aria-label="表情"
                        aria-expanded={emojiOpen}
                        title="表情"
                        onClick={() => setEmojiOpen((open) => !open)}
                      >
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.6" />
                          <circle cx="9.2" cy="10.2" r="1.05" fill="currentColor" />
                          <circle cx="14.8" cy="10.2" r="1.05" fill="currentColor" />
                          <path
                            d="M8.4 13.6c.9 1.5 2.2 2.3 3.6 2.3s2.7-.8 3.6-2.3"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>

                      <button
                        className="send-button"
                        type="submit"
                        disabled={activeDraft.trim() === ''}
                      >
                        发送
                      </button>
                    </div>

                    {emojiOpen && (
                      <div
                        ref={emojiPanelRef}
                        className="emoji-panel"
                        role="listbox"
                        aria-label="常用表情"
                      >
                        {EMOJI_OPTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="emoji-item"
                            role="option"
                            aria-label={`插入表情 ${emoji}`}
                            onClick={() => insertEmoji(emoji)}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </form>
                </div>

                <aside
                  ref={chatSettingsRef}
                  className={`chat-settings${settingsOpen ? ' open' : ''}`}
                  aria-label="会话设置"
                >
                  <div className="chat-settings-inner">
                    <div className="chat-setting-row">
                      <span className="chat-setting-label">置顶聊天</span>
                      <button
                        className="toggle-switch"
                        type="button"
                        role="switch"
                        aria-checked={activeChatEntry?.isPinned === true}
                        aria-label="置顶聊天"
                        disabled={settingsBusy || !activeChatEntry}
                        onClick={() => void handleSettingsTogglePinned()}
                      >
                        <span className="toggle-knob" aria-hidden="true" />
                      </button>
                    </div>

                    {activeFriend.id !== user?.id && (
                      <div className="chat-setting-row">
                        <span className="chat-setting-label">消息免打扰</span>
                        <button
                          className="toggle-switch"
                          type="button"
                          role="switch"
                          aria-checked={activeChatEntry?.isMuted === true}
                          aria-label="消息免打扰"
                          disabled={settingsBusy || !activeChatEntry}
                          onClick={() => void handleSettingsToggleMuted()}
                        >
                          <span className="toggle-knob" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <div className="chat-empty">
              {listStatus === 'loading' && '正在加载…'}
              {listStatus === 'error' && '好友列表加载失败，请在左侧重新加载'}
              {listStatus === 'ready' &&
                friends.length === 0 &&
                '还没有好友，添加好友后就可以聊天了'}
              {listStatus === 'ready' && friends.length > 0 && '从左侧选择一个聊天开始'}
            </div>
          )}
        </div>

        {profileOpen && (
          <ProfilePage
            online={connectionState.tone === 'online'}
            onBack={() => setProfileOpen(false)}
            onToast={showToast}
            onAvatarChanged={setSelfAvatarUrl}
          />
        )}

        {!profileOpen && profileFriend && (
          <ProfilePage
            key={profileFriend.id}
            friend={profileFriend}
            online={onlineFriendIds.has(profileFriend.id)}
            onBack={() => setProfileFriend(null)}
            onToast={showToast}
            onSendMessage={(friend) => {
              setProfileFriend(null)
              openConversationFromContacts(friend.id)
            }}
            onDeleteFriend={(friend) => requestDeleteFriend(friend.id)}
            onRemarkChanged={(friendId, remark) => {
              setFriends((list) =>
                list.map((item) => (item.id === friendId ? { ...item, remark } : item))
              )
              setProfileFriend((current) =>
                current && current.id === friendId ? { ...current, remark } : current
              )
            }}
            onRelationLost={() => {
              setProfileFriend(null)
              void loadFriends()
            }}
          />
        )}
      </main>

      {/* 联系人右键菜单：固定在鼠标位置附近，并限制在窗口内 */}
      {contactMenu && menuFriend && (
        <div
          ref={contactMenuRef}
          className="contact-menu"
          role="menu"
          aria-label={`${getDisplayName(menuFriend)} 的操作`}
          style={{
            left: Math.max(
              CONTACT_MENU_MARGIN,
              Math.min(contactMenu.x, window.innerWidth - CONTACT_MENU_WIDTH - CONTACT_MENU_MARGIN)
            ),
            top: Math.max(
              CONTACT_MENU_MARGIN,
              Math.min(
                contactMenu.y,
                window.innerHeight - CONTACT_MENU_HEIGHT - CONTACT_MENU_MARGIN
              )
            )
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="contact-menu-item"
            onClick={() => {
              setContactMenu(null)
              openConversationFromContacts(menuFriend.id)
            }}
          >
            发送消息
          </button>
          {/* 自己只允许打开自我聊天，不能被星标或删除 */}
          {menuFriend.id !== user?.id && (
            <>
              <button
                type="button"
                role="menuitem"
                className="contact-menu-item"
                onClick={() => {
                  setContactMenu(null)
                  void toggleContactStar(menuFriend)
                }}
              >
                {menuFriend.isStarred ? '取消星标' : '标为星标'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="contact-menu-item danger"
                onClick={() => {
                  setContactMenu(null)
                  requestDeleteFriend(menuFriend.id)
                }}
              >
                删除好友
              </button>
            </>
          )}
        </div>
      )}

      {/* 消息列表右键菜单：置顶 / 免打扰 / 删除聊天 */}
      {chatMenu && menuChatEntry && (
        <div
          ref={chatMenuRef}
          className="contact-menu"
          role="menu"
          aria-label="会话操作"
          style={{
            left: Math.max(
              CHAT_MENU_MARGIN,
              Math.min(chatMenu.x, window.innerWidth - CHAT_MENU_WIDTH - CHAT_MENU_MARGIN)
            ),
            top: Math.max(
              CHAT_MENU_MARGIN,
              Math.min(chatMenu.y, window.innerHeight - CHAT_MENU_HEIGHT - CHAT_MENU_MARGIN)
            )
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="contact-menu-item"
            onClick={() => {
              setChatMenu(null)
              void toggleChatPinned(menuChatEntry)
            }}
          >
            {menuChatEntry.isPinned ? '取消置顶' : '置顶'}
          </button>
          {/* 自我聊天不产生未读提醒，不提供免打扰 */}
          {menuChatEntry.peerId !== user?.id && (
            <button
              type="button"
              role="menuitem"
              className="contact-menu-item"
              onClick={() => {
                setChatMenu(null)
                void toggleChatMuted(menuChatEntry)
              }}
            >
              {menuChatEntry.isMuted ? '关闭免打扰' : '免打扰'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="contact-menu-item danger"
            onClick={() => {
              setChatMenu(null)
              void handleDeleteChat(menuChatEntry)
            }}
          >
            删除聊天
          </button>
        </div>
      )}

      {/* 删除好友：独立的小型确认窗口 */}
      {pendingDeleteFriend && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              cancelDeleteFriend()
            }
          }}
        >
          <div
            className="friend-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="friend-delete-title"
          >
            <p id="friend-delete-title" className="friend-dialog-title">
              删除好友
            </p>
            <p className="friend-dialog-text">
              确定删除“{getDisplayName(pendingDeleteFriend)}
              ”吗？将同时清除双方的聊天记录，删除后无法恢复。
            </p>
            {deleteError && <p className="friend-delete-error">{deleteError}</p>}
            <div className="friend-dialog-actions">
              <button
                className="friend-dialog-cancel"
                type="button"
                onClick={cancelDeleteFriend}
                disabled={deleteSubmittingId !== null}
              >
                取消
              </button>
              <button
                className="friend-dialog-confirm"
                type="button"
                onClick={() => void confirmDeleteFriend(pendingDeleteFriend)}
                disabled={deleteSubmittingId !== null}
              >
                {deleteSubmittingId === pendingDeleteFriend.id ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 修改密码：从左侧底部账户菜单打开，不跳转页面 */}
      {passwordOpen && (
        <ChangePasswordDialog
          requestWithAuth={requestWithAuth}
          getRefreshToken={getRefreshToken}
          onClose={() => setPasswordOpen(false)}
          onSuccess={() => {
            setPasswordOpen(false)
            showToast('密码修改成功')
          }}
        />
      )}

      {/* 轻量 Toast：不拦截操作，约 1 秒后自动消失 */}
      {toast && (
        <div className="app-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}

export default ChatScreen
