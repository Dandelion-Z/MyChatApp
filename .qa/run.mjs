/**
 * 一键接口 QA。
 *
 * 安全边界：
 * - 只接受显式提供的 QA_DATABASE_URL，且库名必须严格等于 mychatapp_qa
 * - 不做 DROP / TRUNCATE / 重建数据库，只清理本套测试固定使用的 qa_* 账号及其级联数据
 * - 只停止本进程启动的服务端子进程，不碰其他进程
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const qaDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(qaDir, '..')
const serverDir = path.join(root, 'server')
const require = createRequire(path.join(serverDir, 'package.json'))
const { Client } = require('pg')

const QA_DB_NAME = 'mychatapp_qa'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const FIXTURE_USERNAMES = [
  'qa_alice',
  'qa_bob',
  'qa_carol',
  'qa_dave',
  'qa_legacy_a',
  'qa_legacy_b',
  'qa_legacy_c',
  'qa_prof_x',
  'qa_prof_y',
  'qa_proxy_x'
]
const PORT = Number(process.env.QA_PORT ?? 3000)
const BASE = `http://127.0.0.1:${PORT}`
const AVATAR_DIR = path.join(qaDir, 'avatars')

const SCRIPTS = [
  'auth-edge.mjs',
  'auth-main.mjs',
  'friends.mjs',
  'legacy-friends.mjs',
  'socket.mjs',
  'profile.mjs',
  'persist-1.mjs',
  'persist-2.mjs',
  'proxy-ip.mjs'
]

function maskUrl(value) {
  return value.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')
}

function fail(message) {
  console.error(`\n[test:qa] 失败：${message}`)
  process.exit(1)
}

function readJwtSecret() {
  if (process.env.QA_JWT_SECRET) {
    return process.env.QA_JWT_SECRET
  }

  const envFile = path.join(serverDir, '.env')

  if (!existsSync(envFile)) {
    fail('缺少 QA_JWT_SECRET，且未找到 server/.env')
  }

  const matched = readFileSync(envFile, 'utf8').match(/^JWT_SECRET=(.*)$/m)

  if (!matched || !matched[1].trim()) {
    fail('server/.env 中缺少 JWT_SECRET')
  }

  return matched[1].trim()
}

function validateQaUrl() {
  const raw = process.env.QA_DATABASE_URL?.trim()

  if (!raw) {
    fail(
      '缺少 QA_DATABASE_URL。请显式提供隔离测试库，例如：\n' +
        "  QA_DATABASE_URL='postgresql://user:<password>@127.0.0.1:5432/mychatapp_qa' npm run test:qa\n" +
        '（不会回退使用 DATABASE_URL）'
    )
  }

  let parsed

  try {
    parsed = new URL(raw)
  } catch {
    fail('QA_DATABASE_URL 不是合法的 URL')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail('QA_DATABASE_URL 必须是 PostgreSQL 连接串')
  }

  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    fail(`QA_DATABASE_URL 必须指向本机测试库（当前主机：${parsed.hostname}）`)
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))

  if (database !== QA_DB_NAME) {
    fail(`QA_DATABASE_URL 的数据库名必须是 ${QA_DB_NAME}（当前：${database || '空'}）`)
  }

  return raw
}

function checkPortFree() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT })

    socket.setTimeout(1500)

    socket.on('connect', () => {
      socket.destroy()
      reject(
        new Error(
          `端口 ${PORT} 已被占用。test:qa 不会停止未知进程，请先释放端口或通过 QA_PORT 指定其他端口。`
        )
      )
    })

    socket.on('timeout', () => {
      socket.destroy()
      resolve()
    })

    socket.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') {
        resolve()
        return
      }

      reject(error)
    })
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })

    child.on('error', (error) => {
      resolve({ code: -1, output: `${output}\n${error.message}` })
    })

    child.on('close', (code) => {
      resolve({ code: code ?? -1, output })
    })
  })
}

async function migrate(qaUrl) {
  const result = await run('npx', ['tsx', 'database/scripts/migrate.ts', 'migrate'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: qaUrl },
    shell: process.platform === 'win32'
  })

  if (result.code !== 0) {
    fail(`QA 数据库迁移失败：\n${result.output.trim()}`)
  }

  process.stdout.write(result.output.replace(/DATABASE_URL=[^\s]+/g, 'DATABASE_URL=***'))
}

let serverProcess = null
let serverLogs = ''

function killProcessTree(pid) {
  if (!pid) {
    return
  }

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 进程可能已经退出
  }
}

async function stopServer() {
  if (!serverProcess) {
    return
  }

  const pid = serverProcess.pid
  serverProcess = null
  killProcessTree(pid)
  await new Promise((resolve) => setTimeout(resolve, 600))
}

async function waitForHealth(timeoutMs = 30000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`服务端提前退出（exit ${serverProcess.exitCode}）：\n${serverLogs.slice(-2000)}`)
    }

    try {
      const response = await fetch(`${BASE}/health`)

      if (response.ok) {
        return
      }
    } catch {
      // 还没起来，继续等
    }

    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  throw new Error(`等待服务端健康检查超时：\n${serverLogs.slice(-2000)}`)
}

async function startServer(qaUrl, jwtSecret) {
  serverLogs = ''
  serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: qaUrl,
      PORT: String(PORT),
      JWT_SECRET: jwtSecret,
      AVATAR_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const collect = (chunk) => {
    serverLogs += chunk.toString()
  }

  serverProcess.stdout.on('data', collect)
  serverProcess.stderr.on('data', collect)

  await waitForHealth()
}

async function main() {
  const qaUrl = validateQaUrl()
  const jwtSecret = readJwtSecret()

  console.log(`[test:qa] 目标数据库：${maskUrl(qaUrl)}`)
  console.log(`[test:qa] 测试端口：${PORT}`)

  await checkPortFree()

  const client = new Client({ connectionString: qaUrl })

  try {
    await client.connect()
    const nameResult = await client.query('SELECT current_database() AS name')

    if (nameResult.rows[0]?.name !== QA_DB_NAME) {
      fail(`实际连接的数据库不是 ${QA_DB_NAME}`)
    }
  } catch (error) {
    fail(`无法连接 QA 数据库：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    await migrate(qaUrl)

    // 只清理固定 QA 账号及其关联数据；不做 DROP / TRUNCATE，也不触碰其他用户
    await client.query('BEGIN')

    const idsResult = await client.query(
      'SELECT id FROM users WHERE username = ANY($1::text[])',
      [FIXTURE_USERNAMES]
    )
    const ids = idsResult.rows.map((row) => String(row.id))

    if (ids.length > 0) {
      await client.query(
        'DELETE FROM messages WHERE sender_id = ANY($1::bigint[]) OR receiver_id = ANY($1::bigint[])',
        [ids]
      )
      await client.query(
        'DELETE FROM user_conversations WHERE user_id = ANY($1::bigint[]) OR peer_id = ANY($1::bigint[])',
        [ids]
      )
      await client.query(
        'DELETE FROM friend_requests WHERE sender_id = ANY($1::bigint[]) OR receiver_id = ANY($1::bigint[])',
        [ids]
      )
      await client.query(
        'DELETE FROM friendships WHERE user_id = ANY($1::bigint[]) OR friend_id = ANY($1::bigint[])',
        [ids]
      )
      await client.query('DELETE FROM refresh_tokens WHERE user_id = ANY($1::bigint[])', [ids])
      await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [ids])
    }

    await client.query('COMMIT')

    console.log(
      `[test:qa] 已清理测试账号：${ids.length === 0 ? '无（数据库本来就干净）' : FIXTURE_USERNAMES.join(', ')}`
    )
  } finally {
    await client.end().catch(() => {})
  }

  const results = []

  try {
    for (const script of SCRIPTS) {
      await stopServer()
      await startServer(qaUrl, jwtSecret)

      console.log(`\n[test:qa] 运行 ${script}`)
      const startedAt = Date.now()
      const result = await run(process.execPath, [path.join(qaDir, script)], {
        cwd: root,
        env: { ...process.env, QA_BASE: BASE, QA_JWT_SECRET: jwtSecret, QA_DATABASE_URL: qaUrl }
      })
      const duration = Date.now() - startedAt
      const masked = result.output.split(qaUrl).join(maskUrl(qaUrl))
      process.stdout.write(masked)
      if (!masked.endsWith('\n')) {
        process.stdout.write('\n')
      }

      const matches = [...masked.matchAll(/SUMMARY .*?: (\d+)\/(\d+) passed/g)]
      const last = matches.at(-1)

      results.push({
        script,
        code: result.code,
        passed: last ? Number(last[1]) : null,
        total: last ? Number(last[2]) : null,
        duration
      })

      const failed = result.code !== 0 || !last || Number(last[1]) !== Number(last[2])

      if (failed) {
        for (const rest of SCRIPTS.slice(SCRIPTS.indexOf(script) + 1)) {
          results.push({ script: rest, code: null, passed: null, total: null, duration: 0 })
        }
        break
      }
    }
  } finally {
    await stopServer()
    rmSync(path.join(qaDir, 'persist.json'), { force: true })
    rmSync(AVATAR_DIR, { recursive: true, force: true })
  }

  console.log('\n[test:qa] 结果汇总')
  console.log('  脚本                 状态      通过/总数     耗时')

  let ok = true

  for (const item of results) {
    const status = item.code === null ? 'SKIP' : item.code === 0 ? 'PASS' : 'FAIL'
    const counts = item.passed === null ? '-' : `${item.passed}/${item.total}`
    console.log(
      `  ${item.script.padEnd(20)}${status.padEnd(9)}${counts.padEnd(13)}${
        item.duration ? `${(item.duration / 1000).toFixed(1)}s` : '-'
      }`
    )

    if (status !== 'PASS') {
      ok = false
    }
  }

  const executed = results.filter((item) => item.code !== null).length
  const skipped = results.filter((item) => item.code === null).length
  const totalPassed = results.reduce((sum, item) => sum + (item.passed ?? 0), 0)
  const totalChecks = results.reduce((sum, item) => sum + (item.total ?? 0), 0)

  console.log(
    `\n[test:qa] 执行 ${executed} 个脚本，跳过 ${skipped} 个；断言 ${totalPassed}/${totalChecks} 通过`
  )
  console.log(ok ? '[test:qa] 全部通过' : '[test:qa] 存在失败')

  process.exitCode = ok ? 0 : 1
}

process.on('SIGINT', () => {
  stopServer().finally(() => process.exit(130))
})

main().catch(async (error) => {
  console.error('\n[test:qa] 异常终止：', error instanceof Error ? error.message : String(error))
  await stopServer()
  process.exit(1)
})
