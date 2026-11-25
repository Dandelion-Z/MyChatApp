import { findCountry } from '../data/countries'
import { findCity, findProvince } from '../data/regions'
import { graphemeLength, normalizeNickname } from '../utils/text'
import type { UserProfile } from './profileService'

export type Gender = 'male' | 'female' | 'other'

export type ProfilePatch = {
  nickname?: string
  signature?: string | null
  countryCode?: string | null
  provinceCode?: string | null
  cityCode?: string | null
  gender?: Gender | null
  birthDate?: string | null
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

const PROFILE_FIELDS: readonly string[] = [
  'nickname',
  'signature',
  'countryCode',
  'provinceCode',
  'cityCode',
  'gender',
  'birthDate'
]

const GENDERS: readonly Gender[] = ['male', 'female', 'other']
const COUNTRY_PATTERN = /^[A-Z]{2}$/
const REGION_PATTERN = /^\d{6}$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_SIGNATURE_LENGTH = 50
const MAX_REMARK_LENGTH = 50

function fail<T>(message: string): ValidationResult<T> {
  return { ok: false, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 以中国时区的“今天”为基准判断未来日期，避免服务器 UTC 时区把当天算成未来
function todayInChina(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < 1900 || year > 9999) {
    return false
  }

  // 用 UTC 往返校验真实日历日期，闰年 2 月 29 日会保留，2 月 30 日会被修正
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/**
 * 解析并校验 PATCH /api/profile/me 的请求体。
 * 区域字段需要结合当前资料做跨字段校验：非 CN 清空省市、省会联动城市。
 */
export function parseProfilePatch(
  body: unknown,
  current: UserProfile
): ValidationResult<ProfilePatch> {
  if (!isRecord(body)) {
    return fail('请求体必须是 JSON 对象')
  }

  const keys = Object.keys(body)

  if (keys.length === 0) {
    return fail('至少需要提交一个可修改字段')
  }

  for (const key of keys) {
    if (!PROFILE_FIELDS.includes(key)) {
      return fail(`不支持修改字段：${key}`)
    }
  }

  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key)
  const changes: ProfilePatch = {}

  if (has('nickname')) {
    if (typeof body.nickname !== 'string') {
      return fail('nickname 必须是字符串')
    }

    const normalized = normalizeNickname(body.nickname)

    if (!normalized.ok) {
      return fail(normalized.message)
    }

    changes.nickname = normalized.value
  }

  if (has('signature')) {
    const value = body.signature

    if (value === null) {
      changes.signature = null
    } else if (typeof value !== 'string') {
      return fail('signature 必须是字符串或 null')
    } else {
      const trimmed = value.trim()

      if (trimmed === '') {
        changes.signature = null
      } else if (graphemeLength(trimmed) > MAX_SIGNATURE_LENGTH) {
        return fail(`个性签名最多 ${MAX_SIGNATURE_LENGTH} 个字符`)
      } else {
        changes.signature = trimmed
      }
    }
  }

  let nextCountry = current.countryCode

  if (has('countryCode')) {
    const value = body.countryCode

    if (value === null) {
      nextCountry = null
    } else if (typeof value !== 'string') {
      return fail('countryCode 必须是字符串或 null')
    } else {
      const normalized = value.trim().toUpperCase()

      if (!COUNTRY_PATTERN.test(normalized) || !findCountry(normalized)) {
        return fail('国家/地区代码无效')
      }

      nextCountry = normalized
    }
  }

  const provinceProvided = has('provinceCode')
  const cityProvided = has('cityCode')
  let nextProvince = current.provinceCode
  let nextCity = current.cityCode

  if (provinceProvided) {
    const value = body.provinceCode

    if (value === null) {
      nextProvince = null
    } else if (typeof value !== 'string') {
      return fail('provinceCode 必须是字符串或 null')
    } else {
      const normalized = value.trim()

      if (!REGION_PATTERN.test(normalized)) {
        return fail('省份代码必须是六位数字')
      }

      nextProvince = normalized
    }
  }

  if (cityProvided) {
    const value = body.cityCode

    if (value === null) {
      nextCity = null
    } else if (typeof value !== 'string') {
      return fail('cityCode 必须是字符串或 null')
    } else {
      const normalized = value.trim()

      if (!REGION_PATTERN.test(normalized)) {
        return fail('城市代码必须是六位数字')
      }

      nextCity = normalized
    }
  }

  if (nextCountry !== 'CN') {
    if (provinceProvided && nextProvince !== null) {
      return fail('只有中国（CN）可以填写省份和城市')
    }

    if (cityProvided && nextCity !== null) {
      return fail('只有中国（CN）可以填写省份和城市')
    }

    // 从中国切换到其他国家时，服务端自动清空省市
    nextProvince = null
    nextCity = null
  } else {
    if (nextProvince !== null && !findProvince(nextProvince)) {
      return fail('省份代码不存在')
    }

    if (nextCity !== null) {
      if (nextProvince === null) {
        if (cityProvided) {
          return fail('填写城市前需要先选择省份')
        }

        nextCity = null
      } else if (!findCity(nextProvince, nextCity)) {
        if (cityProvided) {
          return fail('所选城市不属于所选省份')
        }

        // 更换省份后原城市不再属于新省份时，自动清空城市
        nextCity = null
      }
    }
  }

  if (has('countryCode') && nextCountry !== current.countryCode) {
    changes.countryCode = nextCountry
  }

  if (nextProvince !== current.provinceCode) {
    changes.provinceCode = nextProvince
  }

  if (nextCity !== current.cityCode) {
    changes.cityCode = nextCity
  }

  if (has('gender')) {
    const value = body.gender

    if (value === null) {
      changes.gender = null
    } else if (typeof value !== 'string' || !GENDERS.includes(value as Gender)) {
      return fail('性别必须是 male、female 或 other')
    } else {
      changes.gender = value as Gender
    }
  }

  if (has('birthDate')) {
    const value = body.birthDate

    if (value === null) {
      changes.birthDate = null
    } else if (typeof value !== 'string') {
      return fail('birthDate 必须是字符串或 null')
    } else {
      const normalized = value.trim()

      if (!isValidCalendarDate(normalized)) {
        return fail('出生日期必须是有效的 YYYY-MM-DD 日期')
      }

      if (normalized > todayInChina()) {
        return fail('出生日期不能晚于今天')
      }

      changes.birthDate = normalized
    }
  }

  return { ok: true, value: changes }
}

export function parseRemark(value: unknown): ValidationResult<string | null> {
  if (value === null) {
    return { ok: true, value: null }
  }

  if (typeof value !== 'string') {
    return fail('remark 必须是字符串或 null')
  }

  const trimmed = value.trim()

  if (trimmed === '') {
    return { ok: true, value: null }
  }

  if (graphemeLength(trimmed) > MAX_REMARK_LENGTH) {
    return fail(`好友备注最多 ${MAX_REMARK_LENGTH} 个字符`)
  }

  return { ok: true, value: trimmed }
}
