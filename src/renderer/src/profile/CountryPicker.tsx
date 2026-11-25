import { useEffect, useMemo, useRef, useState } from 'react'
import type { CountryOption } from '../api/profile'
import { countryLabel, type UiLocale } from './labels'

type CountryPickerProps = {
  countries: CountryOption[]
  value: string | null
  locale: UiLocale
  disabled?: boolean
  onChange: (code: string | null) => void
}

/** 可搜索的国家/地区选择器：显示名称随界面语言变化，提交值始终是 ISO 代码。 */
export function CountryPicker({
  countries,
  value,
  locale,
  disabled = false,
  onChange
}: CountryPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = countries.find((country) => country.code === value) ?? null

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()

    if (!keyword) {
      return countries
    }

    return countries.filter(
      (country) =>
        country.name.toLowerCase().includes(keyword) ||
        country.nameEn.toLowerCase().includes(keyword) ||
        country.code.toLowerCase().includes(keyword)
    )
  }, [countries, query])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    searchRef.current?.focus()

    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const choose = (code: string | null): void => {
    onChange(code)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="country-picker" ref={rootRef}>
      <button
        type="button"
        className="profile-select"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected ? undefined : 'profile-select-placeholder'}>
          {selected ? countryLabel(selected, locale) : '未设置'}
        </span>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="country-panel">
          <div className="country-search">
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="搜索国家/地区"
              aria-label="搜索国家/地区"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="country-list" role="listbox" aria-label="国家/地区">
            {selected && (
              <button
                type="button"
                className="country-option country-clear"
                onClick={() => choose(null)}
              >
                清除选择
              </button>
            )}
            {filtered.map((country) => (
              <button
                type="button"
                key={country.code}
                role="option"
                aria-selected={country.code === value}
                className={`country-option${country.code === value ? ' selected' : ''}`}
                onClick={() => choose(country.code)}
              >
                <span className="country-name">{countryLabel(country, locale)}</span>
                <span className="country-code">{country.code}</span>
              </button>
            ))}
            {filtered.length === 0 && <p className="country-empty">没有匹配的国家/地区</p>}
          </div>
        </div>
      )}
    </div>
  )
}
