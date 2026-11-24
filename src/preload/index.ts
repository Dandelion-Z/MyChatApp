import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AuthStorageApi,
  CredentialStoreSnapshot,
  CredentialTombstone,
  RendererApi,
  SaveCredentialResult,
  SavedCredential
} from '../shared/authStorage'
import type { UpdaterApi, UpdaterState } from '../shared/updater'
import type { WindowFlashApi } from '../shared/windowFlash'
import type { WindowLayoutApi, WindowLayoutMode } from '../shared/windowLayout'
import type {
  DeleteFriendDataRequest,
  DeleteFriendDataResult,
  DeleteLocalChatRequest,
  DeleteLocalChatResult,
  EnsureLocalChatRequest,
  EnsureLocalChatResult,
  ListChatPeersResult,
  ListLocalChatsResult,
  ListLocalMessagesRequest,
  MarkConversationReadRequest,
  MarkConversationReadResult,
  ListLocalMessagesResult,
  LocalMessageStats,
  LocalMessagesApi,
  SaveLocalMessageRequest,
  SaveLocalMessageResult,
  SaveLocalMessagesRequest,
  SaveLocalMessagesResult,
  SetChatFlagsRequest,
  SetChatFlagsResult,
  SetSyncCursorRequest,
  SetSyncCursorResult,
  SyncCursorsResult,
  TouchLocalChatRequest,
  TouchLocalChatResult,
  UnreadSummary
} from '../shared/localMessages'

// 只暴露自动登录所需的三个最小接口，不暴露完整 ipcRenderer / Node.js API
const authStorage: AuthStorageApi = {
  load: (): Promise<CredentialStoreSnapshot | null> => ipcRenderer.invoke('auth-storage:load'),
  save: (credential: SavedCredential): Promise<SaveCredentialResult> =>
    ipcRenderer.invoke('auth-storage:save', credential),
  clear: (userId: string, refreshToken?: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('auth-storage:clear', { userId, refreshToken }),
  addTombstone: (entry: CredentialTombstone): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('auth-storage:tombstone', entry)
}

// 自动更新只暴露两个查询/重试接口，安装由主进程在启动门禁内完成
const updater: UpdaterApi = {
  getState: (): Promise<UpdaterState> => ipcRenderer.invoke('updater:get-state'),
  retry: (): Promise<UpdaterState> => ipcRenderer.invoke('updater:retry')
}

// 本地聊天记录只暴露必要的读写与同步进度接口，实际读写都由主进程 SQLite 完成
const localMessages: LocalMessagesApi = {
  save: (request: SaveLocalMessageRequest): Promise<SaveLocalMessageResult> =>
    ipcRenderer.invoke('local-messages:save', request),
  saveMany: (request: SaveLocalMessagesRequest): Promise<SaveLocalMessagesResult> =>
    ipcRenderer.invoke('local-messages:save-many', request),
  list: (request: ListLocalMessagesRequest): Promise<ListLocalMessagesResult> =>
    ipcRenderer.invoke('local-messages:list', request),
  getSyncCursors: (userId: string): Promise<SyncCursorsResult> =>
    ipcRenderer.invoke('local-messages:sync-cursors', userId),
  setSyncCursor: (request: SetSyncCursorRequest): Promise<SetSyncCursorResult> =>
    ipcRenderer.invoke('local-messages:set-sync-cursor', request),
  getStats: (): Promise<LocalMessageStats> => ipcRenderer.invoke('local-messages:stats'),
  listChats: (userId: string): Promise<ListLocalChatsResult> =>
    ipcRenderer.invoke('local-messages:list-chats', userId),
  ensureChat: (request: EnsureLocalChatRequest): Promise<EnsureLocalChatResult> =>
    ipcRenderer.invoke('local-messages:ensure-chat', request),
  touchChat: (request: TouchLocalChatRequest): Promise<TouchLocalChatResult> =>
    ipcRenderer.invoke('local-messages:touch-chat', request),
  getUnreadSummary: (userId: string): Promise<UnreadSummary> =>
    ipcRenderer.invoke('local-messages:unread-summary', userId),
  markConversationRead: (
    request: MarkConversationReadRequest
  ): Promise<MarkConversationReadResult> => ipcRenderer.invoke('local-messages:mark-read', request),
  setChatFlags: (request: SetChatFlagsRequest): Promise<SetChatFlagsResult> =>
    ipcRenderer.invoke('local-messages:set-chat-flags', request),
  deleteChat: (request: DeleteLocalChatRequest): Promise<DeleteLocalChatResult> =>
    ipcRenderer.invoke('local-messages:delete-chat', request),
  deleteFriendData: (request: DeleteFriendDataRequest): Promise<DeleteFriendDataResult> =>
    ipcRenderer.invoke('local-messages:delete-friend-data', request),
  listChatPeers: (userId: string): Promise<ListChatPeersResult> =>
    ipcRenderer.invoke('local-messages:chat-peers', userId)
}

// 任务栏闪烁提醒：只暴露开始/停止两个动作，窗口状态由主进程校验
const windowFlash: WindowFlashApi = {
  start: (): Promise<void> => ipcRenderer.invoke('window:flash'),
  stop: (): Promise<void> => ipcRenderer.invoke('window:flash-stop')
}

// 窗口尺寸只允许在登录、注册、聊天三种布局之间切换，不接受任意宽高
const windowLayout: WindowLayoutApi = {
  set: (mode: WindowLayoutMode): Promise<void> => ipcRenderer.invoke('window:set-layout', mode)
}

// Custom APIs for renderer
const api: RendererApi = {
  authStorage,
  updater,
  localMessages,
  windowLayout,
  windowFlash
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
