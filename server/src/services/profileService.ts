import { pool } from '../database/pool'
import type { ProfilePatch } from './profileValidation'

export type Gender = 'male' | 'female' | 'other'

export type UserProfile = {
  id: string
  uid: string
  nickname: string
  avatarUrl: string | null
  signature: string | null
  countryCode: string | null
  provinceCode: string | null
  cityCode: string | null
  gender: Gender | null
  birthDate: string | null
  age: number | null
  level: number
  activityPoints: number
}

export type FriendProfile = UserProfile & {
  remark: string | null
}

export class ProfileNotFoundError extends Error {
  constructor() {
    super('用户不存在')
    this.name = 'ProfileNotFoundError'
  }
}

export class FriendProfileNotFoundError extends Error {
  constructor() {
    super('用户不存在或不是好友')
    this.name = 'FriendProfileNotFoundError'
  }
}

export class FriendshipNotFoundError extends Error {
  constructor() {
    super('好友关系不存在')
    this.name = 'FriendshipNotFoundError'
  }
}

type ProfileRow = {
  id: string
  uid: string
  nickname: string
  avatar_url: string | null
  signature: string | null
  country_code: string | null
  province_code: string | null
  city_code: string | null
  gender: Gender | null
  birth_date: string | null
  age: number | null
  level: number
  activity_points: number
  remark?: string | null
}

// birth_date 统一转成字符串，避免 node-postgres 转成 Date 后因时区产生日期偏移
// 年龄按中国时区（Asia/Shanghai）的当天计算，与出生日期的未来校验保持同一时区
const PROFILE_COLUMNS = `
  u.id::text AS id,
  u.uid,
  u.nickname,
  u.avatar_url,
  u.signature,
  u.country_code,
  u.province_code,
  u.city_code,
  u.gender,
  to_char(u.birth_date, 'YYYY-MM-DD') AS birth_date,
  CASE
    WHEN u.birth_date IS NULL THEN NULL
    ELSE EXTRACT(
      YEAR FROM age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date, u.birth_date)
    )::int
  END AS age,
  u.level,
  u.activity_points
`

function mapProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    uid: row.uid,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    signature: row.signature,
    countryCode: row.country_code,
    provinceCode: row.province_code,
    cityCode: row.city_code,
    gender: row.gender,
    birthDate: row.birth_date,
    age: row.age,
    level: row.level,
    activityPoints: row.activity_points
  }
}

export async function getSelfProfile(userId: string): Promise<UserProfile> {
  const result = await pool.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.id = $1 AND u.is_deleted = FALSE`,
    [userId]
  )

  if (result.rowCount === 0) {
    throw new ProfileNotFoundError()
  }

  return mapProfile(result.rows[0])
}

export async function getFriendProfile(
  currentUserId: string,
  friendUserId: string
): Promise<FriendProfile> {
  const result = await pool.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS}, f.remark
       FROM users u
       JOIN friendships f ON f.user_id = $1 AND f.friend_id = u.id
      WHERE u.id = $2 AND u.is_deleted = FALSE`,
    [currentUserId, friendUserId]
  )

  if (result.rowCount === 0) {
    throw new FriendProfileNotFoundError()
  }

  return { ...mapProfile(result.rows[0]), remark: result.rows[0].remark ?? null }
}

/**
 * 动态拼装只更新实际发生变化字段的 UPDATE，返回数据库写后的最终资料。
 */
export async function updateProfile(userId: string, changes: ProfilePatch): Promise<UserProfile> {
  const assignments: string[] = []
  const values: unknown[] = []

  const push = (column: string, value: unknown, cast = ''): void => {
    values.push(value)
    assignments.push(`${column} = $${values.length}${cast}`)
  }

  if (changes.nickname !== undefined) {
    push('nickname', changes.nickname)
  }

  if (changes.signature !== undefined) {
    push('signature', changes.signature)
  }

  if (changes.countryCode !== undefined) {
    push('country_code', changes.countryCode)
  }

  if (changes.provinceCode !== undefined) {
    push('province_code', changes.provinceCode)
  }

  if (changes.cityCode !== undefined) {
    push('city_code', changes.cityCode)
  }

  if (changes.gender !== undefined) {
    push('gender', changes.gender)
  }

  if (changes.birthDate !== undefined) {
    push('birth_date', changes.birthDate, '::date')
  }

  if (assignments.length === 0) {
    return getSelfProfile(userId)
  }

  values.push(userId)

  const result = await pool.query<ProfileRow>(
    `UPDATE users u
        SET ${assignments.join(', ')}
      WHERE u.id = $${values.length} AND u.is_deleted = FALSE
      RETURNING ${PROFILE_COLUMNS}`,
    values
  )

  if (result.rowCount === 0) {
    throw new ProfileNotFoundError()
  }

  return mapProfile(result.rows[0])
}

/**
 * 只更新当前用户自己那一侧的好友备注；双方备注互相独立。
 */
export async function setFriendRemark(
  currentUserId: string,
  friendUserId: string,
  remark: string | null
): Promise<string | null> {
  const result = await pool.query<{ remark: string | null }>(
    `UPDATE friendships
        SET remark = $3
      WHERE user_id = $1 AND friend_id = $2
      RETURNING remark`,
    [currentUserId, friendUserId, remark]
  )

  if (result.rowCount === 0) {
    throw new FriendshipNotFoundError()
  }

  return result.rows[0].remark ?? null
}
