import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AuthStorageApi,
  CredentialStoreSnapshot,
  SavedCredential
} from '../shared/authStorage'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      authStorage: AuthStorageApi
    }
  }
}

export type { CredentialStoreSnapshot, SavedCredential }
