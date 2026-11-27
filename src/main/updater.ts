import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { UpdaterState } from '../shared/updater'

// 更新源有两类来源：
//   1. 正式安装版：读取安装包内 resources/app-update.yml 写入的 publish 配置
//      （当前为 GitHub Releases 公开仓库，客户端不需要任何 Token）；
//   2. 本地测试：设置 POLARNIGHT_UPDATE_URL 时强制使用 Generic Provider 的假更新服务器，
//      仅用于 scripts/test-packaged-update.mjs 一类离线验证。
const UPDATE_URL_ENV = 'POLARNIGHT_UPDATE_URL'
// 占位地址（保留 TLD，解析必然失败），用于提示部署方尚未配置真实更新源
const PLACEHOLDER_HOST_SUFFIX = '.invalid'
// GitHub Releases 页面/下载站域名：这些地址不是 Generic 更新源根地址，误填会导致 404
const GITHUB_HOST_SUFFIXES = ['github.com', 'githubusercontent.com']

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

function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase()

  return GITHUB_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * POLARNIGHT_UPDATE_URL 只接受 Generic 假更新服务器的根地址。
 * GitHub 正式更新源由安装包的 app-update.yml 提供，把 GitHub 页面地址填进该变量
 * 会被当成 Generic 根地址去请求 latest.yml，从而 404 卡死门禁，这里提前拦截。
 */
function assertGenericTestFeedUrl(raw: string, url: URL): void {
  if (isGitHubHost(url.hostname)) {
    throw new Error(
      `${UPDATE_URL_ENV} 只用于 Generic 本地测试，不能填 GitHub 地址：${raw}；` +
        '正式安装版的 GitHub 更新源由安装包内 app-update.yml 提供，无需设置该变量'
    )
  }

  if (/\.ya?ml$/i.test(url.pathname)) {
    throw new Error(
      `${UPDATE_URL_ENV} 需要更新源根地址（例如 http://127.0.0.1:3999/polarnight），` +
        `而不是 latest.yml 文件地址：${raw}`
    )
  }
}

interface PackagedUpdateConfig {
  provider: string
  url: string | null
  owner: string | null
  repo: string | null
  channel: string | null
  privateRepo: boolean | null
}

/** 从 app-update.yml 中读取单层标量字段（该文件由 electron-builder 生成，结构扁平） */
function readYamlScalar(content: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm').exec(content)
  const value = match?.[1].trim()

  return value ? value : null
}

function readYamlBoolean(content: string, key: string): boolean | null {
  const raw = readYamlScalar(content, key)

  if (raw === 'true') {
    return true
  }

  if (raw === 'false') {
    return false
  }

  return null
}

/** 读取打包产物 resources/app-update.yml 中写入的 publish 配置 */
function readPackagedUpdateConfig(): PackagedUpdateConfig | null {
  let content: string

  try {
    content = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
  } catch {
    return null
  }

  const provider = readYamlScalar(content, 'provider')

  if (!provider) {
    return null
  }

  return {
    provider,
    url: readYamlScalar(content, 'url'),
    owner: readYamlScalar(content, 'owner'),
    repo: readYamlScalar(content, 'repo'),
    channel: readYamlScalar(content, 'channel'),
    privateRepo: readYamlBoolean(content, 'private')
  }
}

/**
 * 把底层错误转换成用户能看懂的中文提示。
 * 未识别的错误原样返回，保留排查所需的原始信息。
 */
function describeUpdaterError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)

  if (raw.includes('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')) {
    return `该版本发布缺少更新描述文件 latest.yml，请联系维护者重新发布（原始错误：${raw}）`
  }

  if (
    raw.includes('ERR_UPDATER_LATEST_VERSION_NOT_FOUND') ||
    raw.includes('ERR_UPDATER_NO_PUBLISHED_VERSIONS')
  ) {
    return `无法读取 GitHub 发布信息（仓库地址错误，或还没有正式 Release）（原始错误：${raw}）`
  }

  if (raw.includes('403') || /rate limit/i.test(raw)) {
    return `GitHub 请求过于频繁或暂时拒绝访问，请稍后重试（原始错误：${raw}）`
  }

  if (raw.includes('ERR_CONNECTION_REFUSED') || raw.includes('ECONNREFUSED')) {
    return '无法连接更新服务器，请检查网络后重试'
  }

  if (raw.includes('ENOTFOUND') || raw.includes('EAI_AGAIN')) {
    return '无法解析更新服务器域名，请检查网络或 DNS 后重试'
  }

  if (
    raw.includes('ETIMEDOUT') ||
    raw.includes('ERR_TIMED_OUT') ||
    raw.includes('ERR_CONNECTION_TIMED_OUT')
  ) {
    return '连接更新服务器超时，请检查网络后重试'
  }

  if (
    raw.includes('ERR_INTERNET_DISCONNECTED') ||
    raw.includes('ENETUNREACH') ||
    raw.includes('ERR_NETWORK_CHANGED')
  ) {
    return '当前网络不可用，请恢复网络后重试'
  }

  return raw
}

function failureMessage(error: unknown): string {
  return `检查更新失败：${describeUpdaterError(error)}`
}

/** 按 app-update.yml（或测试环境变量）配置本次启动使用的更新源；配置不完整时给出可操作的提示 */
function applyUpdaterFeed(): void {
  const override = resolveConfiguredUpdateUrl()

  if (override !== null) {
    assertGenericTestFeedUrl(override, new URL(override))

    if (isPlaceholderFeedUrl(override)) {
      throw new Error(`更新服务器地址仍是占位地址：${override}`)
    }

    console.warn(
      `[updater] 检测到 ${UPDATE_URL_ENV}，改用 Generic 假更新服务器（仅用于本地测试）：${override}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url: override })

    return
  }

  const config = readPackagedUpdateConfig()

  if (config === null) {
    throw new Error('未找到更新配置（app-update.yml），请使用完整安装包重新安装后再试')
  }

  if (config.provider === 'github') {
    if (!config.owner || !config.repo) {
      throw new Error(
        '更新配置不完整：app-update.yml 缺少 GitHub owner/repo，请使用完整安装包重新安装后再试'
      )
    }

    console.log(
      `[updater] 更新源 github：${config.owner}/${config.repo}` +
        (config.channel ? `（channel=${config.channel}）` : '')
    )

    // 公开仓库：显式给出 private 值，避免 electron-updater 读取 GH_TOKEN/GITHUB_TOKEN
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: config.owner,
      repo: config.repo,
      private: config.privateRepo ?? false,
      ...(config.channel ? { channel: config.channel } : {})
    })

    return
  }

  if (config.provider === 'generic') {
    if (!config.url) {
      throw new Error(
        '更新配置不完整：app-update.yml 缺少 generic url，请使用完整安装包重新安装后再试'
      )
    }

    if (isPlaceholderFeedUrl(config.url)) {
      throw new Error(
        `未配置更新服务器地址（打包时仍是占位地址 ${config.url}），请重新打包并发布后再试`
      )
    }

    console.log(`[updater] 更新源 generic：${config.url}`)
    autoUpdater.setFeedURL({ provider: 'generic', url: config.url })

    return
  }

  throw new Error(`不支持的更新渠道：${config.provider}（仅支持 github / generic）`)
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
      setState({ phase: 'error', message: failureMessage(error) })
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

    setState({ phase: 'error', message: failureMessage(error) })
  })
}

/** 启动检查：先确认更新源可用，再交给 electron-updater；失败时停在门禁 */
function runStartupCheck(): void {
  try {
    applyUpdaterFeed()
  } catch (error) {
    setState({ phase: 'error', message: failureMessage(error) })
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

    // 重新解析更新源：配置类错误（占位地址/缺少 app-update.yml）重试仍然会给出同样提示
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
