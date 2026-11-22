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

// Custom APIs for renderer
const api: RendererApi = {
  authStorage
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
