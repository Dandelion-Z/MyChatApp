import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { UpdaterState } from '../shared/updater'

// 更新服务器地址的运行期覆盖项；未设置时使用打包时写入的 app-update.yml
const UPDATE_URL_ENV = 'MYCHATAPP_UPDATE_URL'
// 占位地址（保留 TLD，解析必然失败），用于提示部署方尚未配置真实更新服务器
const PLACEHOLDER_HOST_SUFFIX = '.invalid'

const CHECKING_STATE: UpdaterState = { phase: 'checking', message: '正在检查更新…' }

let state: UpdaterState = CHECKING_STATE
let initialized = false
let checkInFlight = false

function setState(next: UpdaterState): void {
  state = next
  console.log('[updater]', next.phase, next.message)
}

export function getUpdaterState(): UpdaterState {
  return {
    ...state,
    progress: state.progress ? { ...state.progress } : undefined
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''

  // 生产页面 app://mychatapp；开发页面只允许本机 Vite
  return url.startsWith('app://mychatapp/') || /^http:\/\/localhost:\d+\//.test(url)
}

function resolveConfiguredUpdateUrl(): string | null {
  const raw = process.env[UPDATE_URL_ENV]?.trim()

  if (!raw) {
    return null
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${UPDATE_URL_ENV} 不是合法地址：${raw}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${UPDATE_URL_ENV} 只支持 http/https：${raw}`)
  }

  return url.toString()
}

function isPlaceholderFeedUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(PLACEHOLDER_HOST_SUFFIX)
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读取打包产物 resources/app-update.yml 中写入的更新地址 */
function readPackagedFeedUrl(): string | null {
  try {
    const content = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const match = /^\s*url:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(content)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/** 解析本次启动使用的更新地址；占位地址时给出可操作的失败提示 */
function resolveFeedUrl(): string | null {
  const configured = resolveConfiguredUpdateUrl()

  if (configured) {
    autoUpdater.setFeedURL({ provider: 'generic', url: configured })

    if (isPlaceholderFeedUrl(configured)) {
      throw new Error(`更新服务器地址仍是占位地址：${configured}`)
    }

    return configured
  }

  // 未设置环境变量时 electron-updater 读取打包生成的 app-update.yml
  const packagedUrl = readPackagedFeedUrl()

  if (packagedUrl === null) {
    throw new Error('未找到更新配置（app-update.yml），请使用完整安装包重新安装后再试')
  }

  if (isPlaceholderFeedUrl(packagedUrl)) {
    throw new Error(
      `未配置更新服务器地址（打包时仍是占位地址 ${packagedUrl}），请设置 ${UPDATE_URL_ENV} 后重新构建`
    )
  }

  return packagedUrl
}

async function checkForUpdates(): Promise<void> {
  if (checkInFlight) {
    return
  }

  checkInFlight = true
  setState(CHECKING_STATE)

  try {
    await autoUpdater.checkForUpdates()

    // 事件缺失时兜底，避免门禁一直停在「检查中」
    if (state.phase === 'checking') {
      setState({ phase: 'ready', message: '已是最新版本' })
    }
  } catch (error) {
    if (state.phase !== 'installing') {
      setState({ phase: 'error', message: `检查更新失败：${errorMessage(error)}` })
    }
  } finally {
    checkInFlight = false
  }
}

function configureUpdater(): void {
  autoUpdater.autoDownload = true
  // 只在启动门禁处安装：禁止退出应用时偷偷安装
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.disableWebInstaller = true
  autoUpdater.autoRunAppAfterInstall = true

  autoUpdater.on('checking-for-update', () => {
    setState(CHECKING_STATE)
  })

  autoUpdater.on('update-available', (info) => {
    setState({
      phase: 'downloading',
      message: `发现新版本 ${info.version}，正在下载…`,
      version: info.version
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({
      phase: 'downloading',
      message: `正在下载更新 ${Math.round(progress.percent)}%`,
      version: state.version,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      }
    })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ phase: 'ready', message: '已是最新版本' })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setState({
      phase: 'installing',
      message: `更新 ${info.version} 已下载，正在静默安装并重启…`,
      version: info.version
    })

    // 给渲染进程一点时间展示状态，随后静默安装并重启
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true)
    }, 300)
  })

  autoUpdater.on('error', (error) => {
    if (state.phase === 'installing') {
      return
    }

    setState({ phase: 'error', message: `检查更新失败：${errorMessage(error)}` })
  })
}

/** 启动检查：先确认更新地址可用，再交给 electron-updater；失败时停在门禁 */
function runStartupCheck(): void {
  try {
    resolveFeedUrl()
  } catch (error) {
    setState({ phase: 'error', message: `检查更新失败：${errorMessage(error)}` })
    return
  }

  void checkForUpdates()
}

/** 启动门禁：正式版启动时先检查更新，开发环境直接放行 */
export function registerUpdater(): void {
  ipcMain.handle('updater:get-state', (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    return getUpdaterState()
  })

  ipcMain.handle('updater:retry', (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('unauthorized sender')
    }

    if (!app.isPackaged) {
      return getUpdaterState()
    }

    if (
      state.phase === 'checking' ||
      state.phase === 'downloading' ||
      state.phase === 'installing'
    ) {
      return getUpdaterState()
    }

    // 重新解析更新地址：配置类错误（占位地址/缺少 app-update.yml）重试仍然会给出同样提示
    runStartupCheck()

    return getUpdaterState()
  })

  if (initialized) {
    return
  }

  initialized = true

  // 开发环境不执行自动更新检查，保持现有开发流程
  if (!app.isPackaged) {
    setState({ phase: 'ready', message: '开发环境不检查更新' })
    return
  }

  configureUpdater()
  runStartupCheck()
}
