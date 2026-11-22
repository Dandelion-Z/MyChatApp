import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Client } from 'pg'

const ROOT_DIR = join(__dirname, '..', '..')
const SERVER_DIR = join(ROOT_DIR, 'server')
const serverRequire = createRequire(join(SERVER_DIR, 'package.json'))

type DotenvModule = {
  config: (options: { path: string; quiet?: boolean }) => unknown
}

type Argon2Module = {
  argon2id: number
  hash: (password: string, options?: { type?: number }) => Promise<string>
  verify: (hash: string, password: string) => Promise<boolean>
}

const dotenv = serverRequire('dotenv') as DotenvModule
const argon2 = serverRequire('argon2') as Argon2Module

dotenv.config({ path: join(SERVER_DIR, '.env'), quiet: true })

// 仅限本地开发/自动化测试使用，禁止用于正式账号，也不得在公网环境复用
const TEST_PASSWORD = 'MyChatAppLocalTest123!'

const TEST_USERS = [
  { username: 'test_alice', nickname: '测试用户 A' },
  { username: 'test_bob', nickname: '测试用户 B' },
  { username: 'test_charlie', nickname: '测试用户 C' },
  { username: 'test_david', nickname: '测试用户 D' }
] as const

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

type DatabaseName = 'mychatapp' | 'mychatapp_test'

type DatabaseTarget = {
  name: DatabaseName
  url: URL
}

type SeedSummary = {
  created: string[]
  existing: string[]
  passwordUpdated: string[]
  restored: string[]
  friendshipRows: number
}

function fail(message: string): never {
  throw new Error(message)
}

function parsePostgresUrl(raw: string): URL {
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return fail('DATABASE_URL 不是合法的 PostgreSQL 连接字符串')
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('DATABASE_URL 必须使用 postgres:// 或 postgresql:// 协议')
  }

  return url
}

function getDatabaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''))
}

function assertLocalUrl(url: URL): void {
  const host = url.hostname.toLowerCase()

  if (!LOCAL_HOSTS.has(host)) {
    fail(`只允许连接本地数据库，当前数据库主机为 ${host}`)
  }
}

function buildTestDatabaseUrl(baseUrl: URL): URL {
  const testUrl = new URL(baseUrl.toString())
  testUrl.pathname = '/mychatapp_test'
  return testUrl
}

async function ensureSchema(client: Client, databaseName: string): Promise<void> {
  const result = await client.query<{ users: string | null; friendships: string | null }>(
    `SELECT
       to_regclass('public.users')::text AS users,
       to_regclass('public.friendships')::text AS friendships`
  )

  const row = result.rows[0]

  if (!row?.users || !row.friendships) {
    fail(`数据库 ${databaseName} 缺少 users/friendships 表，请先执行迁移`)
  }
}

async function upsertTestUsers(client: Client, summary: SeedSummary): Promise<Map<string, string>> {
  const userIds = new Map<string, string>()

  for (const user of TEST_USERS) {
    const existing = await client.query<{
      id: string | number
      password_hash: string
      is_deleted: boolean
    }>('SELECT id, password_hash, is_deleted FROM users WHERE username = $1', [user.username])

    if (existing.rowCount === 0) {
      const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id })
      const inserted = await client.query<{ id: string | number }>(
        `INSERT INTO users (username, password_hash, nickname)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [user.username, passwordHash, user.nickname]
      )

      userIds.set(user.username, String(inserted.rows[0].id))
      summary.created.push(user.username)
      continue
    }

    const row = existing.rows[0]
    userIds.set(user.username, String(row.id))

    let passwordMatches: boolean

    try {
      passwordMatches = await argon2.verify(row.password_hash, TEST_PASSWORD)
    } catch {
      // 哈希损坏时按不匹配处理，下面重置为已知测试密码
      passwordMatches = false
    }

    if (!passwordMatches) {
      const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id })
      // 仅更新固定测试账号的密码哈希
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        passwordHash,
        row.id
      ])
      summary.passwordUpdated.push(user.username)
    }

    if (row.is_deleted) {
      // 固定测试账号被误软删除时恢复，保证可登录
      await client.query('UPDATE users SET is_deleted = FALSE WHERE id = $1', [row.id])
      summary.restored.push(user.username)
    }

    summary.existing.push(user.username)
  }

  return userIds
}

async function seedDatabase(target: DatabaseTarget): Promise<SeedSummary> {
  const client = new Client({ connectionString: target.url.toString() })
  const summary: SeedSummary = {
    created: [],
    existing: [],
    passwordUpdated: [],
    restored: [],
    friendshipRows: 0
  }

  await client.connect()

  try {
    const current = await client.query<{ name: string }>('SELECT current_database() AS name')

    if (current.rows[0]?.name !== target.name) {
      fail(`实际连接的数据库不是 ${target.name}，已中止`)
    }

    await ensureSchema(client, target.name)

    await client.query('BEGIN')

    try {
      const userIds = await upsertTestUsers(client, summary)

      const aliceId = userIds.get('test_alice')
      const bobId = userIds.get('test_bob')

      if (!aliceId || !bobId) {
        fail('固定测试账号创建失败，未找到 test_alice/test_bob')
      }

      // 双向好友关系；已存在时不会重复插入
      const friendship = await client.query(
        `INSERT INTO friendships (user_id, friend_id)
         VALUES ($1, $2), ($2, $1)
         ON CONFLICT DO NOTHING`,
        [aliceId, bobId]
      )

      summary.friendshipRows = friendship.rowCount ?? 0

      await client.query('COMMIT')
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // 连接已断开时忽略回滚失败，保留原始错误
      }

      throw error
    }
  } finally {
    await client.end()
  }

  return summary
}

function printSummary(target: DatabaseTarget, summary: SeedSummary): void {
  console.log(`\n[${target.name}]`)
  console.log(`  新建账号：${summary.created.length > 0 ? summary.created.join(', ') : '无'}`)
  console.log(`  已存在账号：${summary.existing.length > 0 ? summary.existing.join(', ') : '无'}`)

  if (summary.passwordUpdated.length > 0) {
    console.log(`  已重置密码哈希：${summary.passwordUpdated.join(', ')}`)
  }

  if (summary.restored.length > 0) {
    console.log(`  已恢复软删除账号：${summary.restored.join(', ')}`)
  }

  console.log(
    summary.friendshipRows > 0
      ? `  已建立 Alice ↔ Bob 好友关系（${summary.friendshipRows} 行）`
      : '  Alice ↔ Bob 好友关系已存在，未重复插入'
  )
}

async function main(): Promise<void> {
  const rawUrl = process.env.DATABASE_URL?.trim()

  if (!rawUrl) {
    fail('未找到 DATABASE_URL，请在 server/.env 中配置本地 mychatapp 数据库')
  }

  const baseUrl = parsePostgresUrl(rawUrl)
  assertLocalUrl(baseUrl)

  const baseName = getDatabaseName(baseUrl)

  if (baseName !== 'mychatapp') {
    fail(`DATABASE_URL 必须指向本地 mychatapp 数据库，当前为 ${baseName}`)
  }

  const testUrl = buildTestDatabaseUrl(baseUrl)
  assertLocalUrl(testUrl)

  if (getDatabaseName(testUrl) !== 'mychatapp_test') {
    fail('无法推导出 mychatapp_test 数据库连接')
  }

  for (const target of [
    { name: 'mychatapp', url: baseUrl },
    { name: 'mychatapp_test', url: testUrl }
  ] as const) {
    const summary = await seedDatabase(target)
    printSummary(target, summary)
  }

  console.log('\n固定测试账号初始化完成（两个数据库均已处理）。')
}

main().catch((error) => {
  console.error('初始化固定测试账号失败：', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
