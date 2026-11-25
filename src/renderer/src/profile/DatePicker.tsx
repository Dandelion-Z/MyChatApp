import { useMemo, useState } from 'react'

type DatePickerProps = {
  value: string | null
  disabled?: boolean
  onChange: (value: string | null) => void
}

type DateParts = { year: number | null; month: number | null; day: number | null }

type TodayParts = { year: number; month: number; day: number }

const pad = (value: number): string => String(value).padStart(2, '0')

/** 中国时区（Asia/Shanghai）的当天年月日，用于限制未来日期 */
function todayInChina(): TodayParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())

  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value)

  return { year: pick('year'), month: pick('month'), day: pick('day') }
}

function parseValue(value: string | null): DateParts {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null

  if (!match) {
    return { year: null, month: null, day: null }
  }

  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 年月日三段选择，不引入日历依赖；提交值始终是 YYYY-MM-DD 字符串。 */
export function DatePicker({
  value,
  disabled = false,
  onChange
}: DatePickerProps): React.JSX.Element {
  const today = useMemo(() => todayInChina(), [])
  const [parts, setParts] = useState<DateParts>(() => parseValue(value))

  const years = useMemo(() => {
    const list: number[] = []
    for (let year = today.year; year >= 1900; year -= 1) {
      list.push(year)
    }
    return list
  }, [today.year])

  const monthCount = 12
  const maxDay = parts.year && parts.month ? daysInMonth(parts.year, parts.month) : 31
  const isCurrentMonth = parts.year === today.year && parts.month === today.month

  const emit = (next: DateParts): void => {
    // 年份/月份变化后，如果原来的日超出当月天数，自动清空日，避免提交无效日期
    const nextDay =
      next.year !== null && next.month !== null && next.day !== null
        ? Math.min(next.day, daysInMonth(next.year, next.month))
        : next.day
    const normalized = { ...next, day: nextDay }
    setParts(normalized)

    if (normalized.year === null || normalized.month === null || normalized.day === null) {
      onChange(null)
      return
    }

    onChange(`${normalized.year}-${pad(normalized.month)}-${pad(normalized.day)}`)
  }

  return (
    <div className="date-picker">
      <select
        className="profile-select date-select"
        aria-label="出生年份"
        disabled={disabled}
        value={parts.year ?? ''}
        onChange={(event) => {
          const year = event.target.value ? Number(event.target.value) : null
          emit({ year, month: parts.month, day: parts.day })
        }}
      >
        <option value="">未设置</option>
        {years.map((year) => (
          <option key={year} value={year}>
            {year} 年
          </option>
        ))}
      </select>

      <select
        className="profile-select date-select"
        aria-label="出生月份"
        disabled={disabled || parts.year === null}
        value={parts.month ?? ''}
        onChange={(event) => {
          const month = event.target.value ? Number(event.target.value) : null
          emit({ year: parts.year, month, day: parts.day })
        }}
      >
        <option value="">月</option>
        {Array.from({ length: monthCount }, (_, index) => index + 1).map((month) => (
          <option key={month} value={month}>
            {month} 月
          </option>
        ))}
      </select>

      <select
        className="profile-select date-select"
        aria-label="出生日期"
        disabled={disabled || parts.year === null || parts.month === null}
        value={parts.day ?? ''}
        onChange={(event) => {
          const day = event.target.value ? Number(event.target.value) : null
          emit({ year: parts.year, month: parts.month, day })
        }}
      >
        <option value="">日</option>
        {Array.from({ length: maxDay }, (_, index) => index + 1).map((day) => {
          const future = isCurrentMonth && day > today.day
          return (
            <option key={day} value={day} disabled={future}>
              {day} 日
            </option>
          )
        })}
      </select>
    </div>
  )
}
