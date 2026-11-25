import type { CountryOption, Gender } from '../api/profile'

export type UiLocale = 'zh' | 'en'

/**
 * 当前没有应用内语言切换，界面语言按系统/浏览器语言推断：
 * 英文系统显示英文国家名，其余显示中文。服务端始终保存 ISO 代码。
 */
export function currentLocale(): UiLocale {
  const language = typeof navigator === 'undefined' ? 'zh' : navigator.language
  return language.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

export function countryLabel(country: CountryOption, locale: UiLocale): string {
  return locale === 'en' ? country.nameEn || country.name : country.name
}

const GENDER_LABELS: Record<Gender, Record<UiLocale, string>> = {
  male: { zh: '男', en: 'Male' },
  female: { zh: '女', en: 'Female' },
  other: { zh: '其他', en: 'Other' }
}

export function genderLabel(gender: Gender | null, locale: UiLocale): string | null {
  return gender ? GENDER_LABELS[gender][locale] : null
}

/** 把 1995-06-15 这类日期格式化为 1995年6月15日（英文环境保留 ISO 形式） */
export function formatBirthDate(value: string, locale: UiLocale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return value
  }

  if (locale === 'en') {
    return value
  }

  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`
}

/** 年龄展示：服务端返回的动态结果，未填写生日时为 null */
export function formatAge(age: number | null, locale: UiLocale): string | null {
  if (age === null) {
    return null
  }

  return locale === 'en' ? `${age}` : `${age} 岁`
}
