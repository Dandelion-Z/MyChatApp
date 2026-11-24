import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AuthStorageApi,
  CredentialStoreSnapshot,
  SavedCredential
} from '../shared/authStorage'
import type { UpdaterApi } from '../shared/updater'
import type { LocalMessagesApi } from '../shared/localMessages'
import type { WindowFlashApi } from '../shared/windowFlash'
import type { WindowLayoutApi } from '../shared/windowLayout'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      authStorage: AuthStorageApi
      updater: UpdaterApi
      localMessages: LocalMessagesApi
      windowLayout: WindowLayoutApi
      windowFlash: WindowFlashApi
    }
  }
}

export type { CredentialStoreSnapshot, SavedCredential }
