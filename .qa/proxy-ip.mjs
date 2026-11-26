/**
 * 反向代理 / 限流取址验证（独立运行）。
 *
 * 用法：
 *   QA_DATABASE_URL='postgresql://.../mychatapp_qa' node .qa/proxy-ip.mjs
 *
 * 校验：
 * - TRUST_PROXY=127.0.0.1 时按 X-Forwarded-For 取客户端 IP，不同 IP 独立计数
 * - 未配置 TRUST_PROXY 时忽略 X-Forwarded-For，伪造头不能拆分/绕过计数
 * - TRUST_PROXY 非法时服务端拒绝启动
 * - 注册/登录/刷新限流阈值保持 5/10/30
 */
import { spawn } from 'node:child_process'
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
const TRUST_PORT = 3101
const UNTRUST_PORT = 3102
const INVALID_PORT = 3103

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('PASS', name, detail === undefined ? '' : JSON.stringify(detail))
  } else {
    failed += 1
    console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function validateEnv() {
  const raw = process.env.QA_DATABASE_URL?.trim()
  if (!raw) {
    throw new Error('缺少 QA_DATABASE_URL')
  }
  const parsed = new URL(raw)
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!LOCAL_HOSTS.has(parsed.hostname) || database !== QA_DB_NAME) {
    throw new Error(`QA_DATABASE_URL 必须指向本机 ${QA_DB_NAME}`)
  }
  return raw
}

function readJwtSecret() {
  if (process.env.QA_JWT_SECRET) return process.env.QA_JWT_SECRET
  const { readFileSync } = require('node:fs')
  const text = readFileSync(path.join(serverDir, '.env'), 'utf8')
  const matched = text.match(/^JWT_SECRET=(.*)$/m)
  if (!matched) throw new Error('server/.env 中缺少 JWT_SECRET')
  return matched[1].trim()
}

function portFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(1200)
    socket.on('connect', () => {
      socket.destroy()
      reject(new Error(`端口 ${port} 已被占用`))
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve()
    })
    socket.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 已退出
  }
}

async function startServer({ port, trustProxy, qaUrl, jwtSecret, expectFailure }) {
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: qaUrl,
      PORT: String(port),
      JWT_SECRET: jwtSecret,
      ...(trustProxy ? { TRUST_PROXY: trustProxy } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let logs = ''
  child.stdout.on('data', (chunk) => (logs += chunk.toString()))
  child.stderr.on('data', (chunk) => (logs += chunk.toString()))

  if (expectFailure) {
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    return { child, logs: () => logs, exited }
  }

  const base = `http://127.0.0.1:${port}`
  const startedAt = Date.now()

  while (Date.now() - startedAt < 20000) {
    if (child.exitCode !== null) {
      throw new Error(`端口 ${port} 服务启动失败：${logs.slice(-800)}`)
    }
    try {
      const response = await fetch(`${base}/health`)
      if (response.ok) {
        return { child, base, logs: () => logs }
      }
    } catch {
      // 继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`端口 ${port} 等待健康检查超时：${logs.slice(-800)}`)
}

async function probe(base, { path: route, forwardedFor, body }) {
  return fetch(base + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {})
    },
    body: JSON.stringify(body)
  })
}

async function main() {
  const qaUrl = validateEnv()
  const jwtSecret = readJwtSecret()

  const client = new Client({ connectionString: qaUrl })
  await client.connect()
  const name = (await client.query('SELECT current_database() AS name')).rows[0]?.name
  await client.end()
  if (name !== QA_DB_NAME) throw new Error('实际数据库不是 mychatapp_qa')

  for (const port of [TRUST_PORT, UNTRUST_PORT, INVALID_PORT]) {
    await portFree(port)
  }

  let trusted
  let untrusted
  let invalid

  try {
    trusted = await startServer({
      port: TRUST_PORT,
      trustProxy: '127.0.0.1',
      qaUrl,
      jwtSecret
    })
    untrusted = await startServer({ port: UNTRUST_PORT, qaUrl, jwtSecret })

    const login = (forwardedFor) =>
      probe(trusted.base, {
        path: '/api/auth/login',
        forwardedFor,
        body: { username: 'qa_nobody', password: 'QaTestPass123!' }
      })

    const t1 = await login('203.0.113.10')
    check('可信代理下识别到转发 IP（剩余 9）', t1.headers.get('ratelimit-remaining') === '9', {
      remaining: t1.headers.get('ratelimit-remaining'),
      limit: t1.headers.get('ratelimit-limit')
    })
    const t2 = await login('203.0.113.10')
    check('同一转发 IP 继续累计（剩余 8）', t2.headers.get('ratelimit-remaining') === '8', {
      remaining: t2.headers.get('ratelimit-remaining')
    })
    const t3 = await login('203.0.113.11')
    check('不同转发 IP 使用独立计数（剩余 9）', t3.headers.get('ratelimit-remaining') === '9', {
      remaining: t3.headers.get('ratelimit-remaining')
    })

    const u1 = await probe(untrusted.base, {
      path: '/api/auth/login',
      forwardedFor: '198.51.100.1',
      body: { username: 'qa_nobody', password: 'QaTestPass123!' }
    })
    const u2 = await probe(untrusted.base, {
      path: '/api/auth/login',
      forwardedFor: '198.51.100.2',
      body: { username: 'qa_nobody', password: 'QaTestPass123!' }
    })
    check(
      '未信任代理时伪造 XFF 不能拆分计数',
      u1.headers.get('ratelimit-remaining') === '9' &&
        u2.headers.get('ratelimit-remaining') === '8',
      {
        first: u1.headers.get('ratelimit-remaining'),
        second: u2.headers.get('ratelimit-remaining')
      }
    )

    const reg = await probe(trusted.base, {
      path: '/api/auth/register',
      forwardedFor: '203.0.113.20',
      body: { username: 'qa_proxy_x', password: 'QaTestPass123!', nickname: '代理测试' }
    })
    check('注册限流阈值仍为 5', reg.headers.get('ratelimit-limit') === '5', {
      limit: reg.headers.get('ratelimit-limit')
    })

    const refresh = await probe(trusted.base, {
      path: '/api/auth/refresh',
      forwardedFor: '203.0.113.20',
      body: { refreshToken: 'invalid-token' }
    })
    check('刷新限流阈值仍为 30', refresh.headers.get('ratelimit-limit') === '30', {
      limit: refresh.headers.get('ratelimit-limit')
    })

    invalid = await startServer({
      port: INVALID_PORT,
      trustProxy: 'not-an-ip',
      qaUrl,
      jwtSecret,
      expectFailure: true
    })
    check(
      '非法 TRUST_PROXY 时服务端拒绝启动',
      invalid.exited && invalid.logs().includes('TRUST_PROXY'),
      invalid.logs().slice(-200)
    )
  } finally {
    for (const server of [trusted, untrusted, invalid]) {
      if (server?.child) killTree(server.child.pid)
    }
  }

  console.log(`\nSUMMARY 代理与限流: ${passed}/${passed + failed} passed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('代理与限流验证失败：', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
