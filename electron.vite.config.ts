import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 客户端默认后端地址（仅开发环境使用，生产构建必须显式配置 VITE_API_BASE_URL）
const DEV_DEFAULT_API_BASE_URL = 'http://localhost:3000'
// electron-vite dev 的渲染进程地址，HMR 需要放行其 WebSocket
const DEV_RENDERER_WS_ORIGIN = 'ws://localhost:5173'

const CSP_PLACEHOLDER = '__MYCHATAPP_CSP__'

function normalizeApiBaseUrl(rawValue: string | undefined): string | null {
  const value = rawValue?.trim()

  if (!value) {
    return null
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new Error(`VITE_API_BASE_URL 不是合法地址：${value}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`VITE_API_BASE_URL 只支持 http/https：${value}`)
  }

  return url.origin
}

/**
 * 根据实际 API 地址生成 CSP 的 connect-src，
 * 避免写死来源，也避免为了放行请求而整体放宽 CSP。
 */
function buildCsp(isDev: boolean, apiBaseUrl: string | null): string {
  const connectSrc = new Set<string>(["'self'"])

  if (apiBaseUrl) {
    connectSrc.add(apiBaseUrl)
    connectSrc.add(apiBaseUrl.replace(/^http/, 'ws'))
  }

  if (isDev) {
    // Vite HMR
    connectSrc.add(DEV_RENDERER_WS_ORIGIN)
  }

  const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"

  // 头像等图片由后端静态资源提供，img-src 需要放行实际 API 来源
  const imgSrc = new Set<string>(["'self'", 'data:'])

  if (apiBaseUrl) {
    imgSrc.add(apiBaseUrl)
  }

  return [
    "default-src 'self'",
    scriptSrc,
    // React 通过 style 属性写内联样式，需要保留 unsafe-inline
    "style-src 'self' 'unsafe-inline'",
    `img-src ${[...imgSrc].join(' ')}`,
    "font-src 'self'",
    `connect-src ${[...connectSrc].join(' ')}`
  ].join('; ')
}

function createCspPlugin(isDev: boolean, apiBaseUrl: string | null): Plugin {
  const csp = buildCsp(isDev, apiBaseUrl)

  return {
    name: 'mychatapp-csp',
    transformIndexHtml(html) {
      return html.replace(CSP_PLACEHOLDER, csp)
    }
  }
}

export default defineConfig(({ command, mode }) => {
  const isDev = command === 'serve'
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const configuredApiBaseUrl = normalizeApiBaseUrl(env.VITE_API_BASE_URL)
  const apiBaseUrl = configuredApiBaseUrl ?? (isDev ? DEV_DEFAULT_API_BASE_URL : null)

  if (!isDev && !configuredApiBaseUrl) {
    console.warn(
      '\n[mychatapp] 未配置 VITE_API_BASE_URL：生产构建的 CSP 不会放行后端请求。' +
        '请在打包前设置真实服务器地址，例如 VITE_API_BASE_URL=https://chat-api.example.com。\n'
    )
  }

  return {
    main: {},
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react(), createCspPlugin(isDev, apiBaseUrl)]
    }
  }
})
