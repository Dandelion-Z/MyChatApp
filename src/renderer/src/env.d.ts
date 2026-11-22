/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基础地址；未配置时客户端默认使用 http://localhost:3000 */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
