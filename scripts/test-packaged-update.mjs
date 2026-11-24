#!/usr/bin/env node
/**
 * 打包测试一键脚本：构建（可选）→ 本地假更新服务器 → 隔离 userData 启动 exe。
 *
 * 用法：
 *   npm run test:packaged                # 重新构建并启动（使用本地 API http://localhost:3000）
 *   npm run test:packaged -- --skip-build  # 复用已有 dist/win-unpacked
 *   npm run test:packaged -- --smoke       # 启动后检查门禁请求并自动退出（CI 冒烟）
 *
 * 选项：
 *   --skip-build      跳过 npm run build 与 electron-builder --dir
 *   --smoke           启动应用、确认假更新服务器收到 latest.yml 请求后自动关闭
 *   --keep-profile    保留 dist/.update-test-profile（默认每次启动前清空）
 *   --port <n>        假更新服务器端口，默认 3999
 *   --exe <path>      指定要启动的可执行文件
 *
 * 约束：首次使用前需安装依赖并执行 npm run build:unpack（或本脚本的构建步骤）。
 * 该脚本不添加任何“关闭更新检查”的开关；打包版始终走正式门禁。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const isWindows = process.platform === 'win32'
const npm = isWindows ? 'npm.cmd' : 'npm'
const npx = isWindows ? 'npx.cmd' : 'npx'

const args = process.argv.slice(2)
const hasFlag = (flag) => args.includes(flag)
const readOption = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const skipBuild = hasFlag('--skip-build')
const smoke = hasFlag('--smoke')
const keepProfile = hasFlag('--keep-profile')
const port = Number(readOption('--port', '3999'))
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
const defaultExe = join(repoRoot, 'dist', 'win-unpacked', isWindows ? 'mychatapp.exe' : 'mychatapp')
const exePath = resolve(repoRoot, readOption('--exe', defaultExe))
const profileDir = join(repoRoot, 'dist', '.update-test-profile')

let appProcess = null
let fakeServer = null
let shuttingDown = false
let intentionalStop = false

function log(message) {
  console.log(`[test-packaged] ${message}`)
}

function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(' ')}`)
  // Windows 下 npm/npx 是 .cmd 包装脚本，node 必须通过 shell 才能执行；
  // 用单个命令行字符串，避免 shell:true + args 数组触发 DEP0190。
  const useShell = isWindows && /\.(cmd|bat)$/i.test(command)
  const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)
  const result = useShell
    ? spawnSync([command, ...commandArgs].map(quote).join(' '), {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, ...options.env },
        shell: true
      })
    : spawnSync(command, commandArgs, {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, ...options.env }
      })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}`)
  }
}

function killProcessTree(processHandle, signal = 'SIGTERM') {
  if (!processHandle || processHandle.exitCode !== null) return
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  processHandle.kill(signal)
}

function cleanup() {
  if (shuttingDown) return
  shuttingDown = true
  killProcessTree(appProcess)
  killProcessTree(fakeServer)
  if (!keepProfile && existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true })
      log(`已清理测试 userData：${profileDir}`)
    } catch (error) {
      log(`清理测试 userData 失败：${error.message}`)
    }
  }
}

async function waitForUrl(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // 服务器还没起来，继续重试
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
  }
  return false
}

async function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit('timeout'), timeoutMs)
    processHandle.once('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
}

async function main() {
  if (!skipBuild) {
    log(`构建打包测试版本，VITE_API_BASE_URL=${apiBaseUrl}`)
    run(npm, ['run', 'build'], { env: { VITE_API_BASE_URL: apiBaseUrl } })
    run(npx, ['electron-builder', '--dir'])
  } else {
    log('已跳过构建，复用现有 dist/win-unpacked')
  }

  if (!existsSync(exePath)) {
    throw new Error(
      `找不到可执行文件：${exePath}（请先执行 npm run build:unpack 或去掉 --skip-build）`
    )
  }

  if (!keepProfile && existsSync(profileDir)) {
    rmSync(profileDir, { recursive: true, force: true })
  }

  log(`启动假更新服务器：http://127.0.0.1:${port}/mychatapp`)
  fakeServer = spawn(process.execPath, [join(repoRoot, 'scripts', 'fake-update-server.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, FAKE_UPDATE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let latestYmlRequested = false
  const forward = (stream, prefix) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue
        console.log(prefix ? `${prefix} ${line}` : line)
        if (line.includes('/latest.yml')) latestYmlRequested = true
      }
    })
  }
  forward(fakeServer.stdout, '')
  forward(fakeServer.stderr, '')

  const feedReady = await waitForUrl(
    `http://127.0.0.1:${port}/mychatapp/latest.yml?noCache=${Date.now()}`
  )
  if (!feedReady) throw new Error('假更新服务器启动失败')
  log('假更新服务器已就绪')

  try {
    const health = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/health`)
    log(`后端 /health：${health.status}（登录需要后端与数据库已启动）`)
  } catch {
    log(`警告：无法访问后端 ${apiBaseUrl}/health，登录会失败；更新门禁仍可验证`)
  }

  log(`启动应用：${exePath}`)
  log(`  MYCHATAPP_UPDATE_URL=http://127.0.0.1:${port}/mychatapp`)
  log(`  --user-data-dir=${profileDir}`)

  const env = { ...process.env, MYCHATAPP_UPDATE_URL: `http://127.0.0.1:${port}/mychatapp` }
  // 本会话 shell 可能带有 ELECTRON_RUN_AS_NODE，会导致 exe 以 Node 模式运行
  delete env.ELECTRON_RUN_AS_NODE

  appProcess = spawn(exePath, [`--user-data-dir=${profileDir}`], {
    cwd: repoRoot,
    env,
    stdio: 'inherit'
  })

  appProcess.on('exit', (code) => {
    if (intentionalStop) return
    log(`应用已退出，退出码 ${code}`)
    cleanup()
    process.exit(code ?? 0)
  })

  appProcess.on('error', (error) => {
    log(`应用启动失败：${error.message}`)
    cleanup()
    process.exit(1)
  })

  if (smoke) {
    const exitCode = await waitForExit(appProcess, 8000)
    if (exitCode !== 'timeout') {
      throw new Error(`应用在冒烟等待期内退出，退出码 ${exitCode}`)
    }
    if (!latestYmlRequested) {
      throw new Error('应用启动后没有请求 latest.yml，更新门禁可能未执行')
    }
    log('冒烟通过：应用存活且已向假更新服务器请求 latest.yml')
    intentionalStop = true
    killProcessTree(appProcess)
    cleanup()
    process.exit(0)
  }

  log('应用运行中，Ctrl+C 结束（脚本会一并关闭假更新服务器并清理测试 userData）')
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C，正在清理')
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})
process.on('exit', cleanup)

main().catch((error) => {
  console.error(`[test-packaged] 失败：${error.message}`)
  cleanup()
  process.exit(1)
})
