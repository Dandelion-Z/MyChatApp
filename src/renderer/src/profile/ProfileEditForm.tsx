import { useState } from 'react'
import type { AuthedRequest } from '../api/friends'
import {
  updateMyProfile,
  type Gender,
  type MyProfile,
  type ProfileOptions,
  type ProfilePatch
} from '../api/profile'
import { CountryPicker } from './CountryPicker'
import { DatePicker } from './DatePicker'
import { genderLabel, type UiLocale } from './labels'

type ProfileEditFormProps = {
  profile: MyProfile
  options: ProfileOptions
  locale: UiLocale
  requestWithAuth: AuthedRequest
  saving: boolean
  setSaving: (saving: boolean) => void
  error: string | null
  setError: (message: string | null) => void
  onCancel: () => void
  onSaved: (profile: MyProfile) => void
}

type Draft = {
  nickname: string
  signature: string
  countryCode: string | null
  provinceCode: string | null
  cityCode: string | null
  gender: Gender | null
  birthDate: string | null
}

const GENDERS: Gender[] = ['male', 'female', 'other']

function toDraft(profile: MyProfile): Draft {
  return {
    nickname: profile.nickname,
    signature: profile.signature ?? '',
    countryCode: profile.countryCode,
    provinceCode: profile.provinceCode,
    cityCode: profile.cityCode,
    gender: profile.gender,
    birthDate: profile.birthDate
  }
}

/** 资料编辑表单：控制只提交服务端允许的 7 个字段，清空可选字段时显式传 null。 */
export function ProfileEditForm({
  profile,
  options,
  locale,
  requestWithAuth,
  saving,
  setSaving,
  error,
  setError,
  onCancel,
  onSaved
}: ProfileEditFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => toDraft(profile))

  const province = options.provinces.find((item) => item.code === draft.provinceCode)

  const update = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()

    if (saving) {
      return
    }

    const nickname = draft.nickname.trim()

    if (!nickname) {
      setError('昵称不能为空')
      return
    }

    if ([...nickname].length > 50) {
      setError('昵称最多 50 个字符')
      return
    }

    const signature = draft.signature.trim()

    if ([...signature].length > 50) {
      setError('个性签名最多 50 个字符')
      return
    }

    const isChina = draft.countryCode === 'CN'
    // 只提交允许修改的字段；未选择的省/市/签名/生日用 null 表示清空
    const patch: ProfilePatch = {
      nickname,
      signature: signature ? signature : null,
      countryCode: draft.countryCode,
      provinceCode: isChina ? draft.provinceCode : null,
      cityCode: isChina ? draft.cityCode : null,
      gender: draft.gender,
      birthDate: draft.birthDate
    }

    setError(null)
    setSaving(true)

    try {
      const next = await updateMyProfile(requestWithAuth, patch)
      onSaved(next)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '保存失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="profile-form" onSubmit={handleSubmit}>
      <div className="profile-field">
        <label className="profile-label" htmlFor="profile-nickname">
          昵称
        </label>
        <input
          id="profile-nickname"
          className="profile-input"
          type="text"
          value={draft.nickname}
          maxLength={50}
          disabled={saving}
          onChange={(event) => update({ nickname: event.target.value })}
        />
      </div>

      <div className="profile-field">
        <label className="profile-label" htmlFor="profile-signature">
          个性签名
        </label>
        <textarea
          id="profile-signature"
          className="profile-input profile-textarea"
          value={draft.signature}
          maxLength={50}
          rows={2}
          placeholder="还未填写"
          disabled={saving}
          onChange={(event) => update({ signature: event.target.value })}
        />
      </div>

      <div className="profile-field">
        <span className="profile-label">国家/地区</span>
        <CountryPicker
          countries={options.countries}
          value={draft.countryCode}
          locale={locale}
          disabled={saving}
          onChange={(code) =>
            update({
              countryCode: code,
              provinceCode: code === 'CN' ? draft.provinceCode : null,
              cityCode: code === 'CN' ? draft.cityCode : null
            })
          }
        />
      </div>

      {draft.countryCode === 'CN' && (
        <>
          <div className="profile-field">
            <label className="profile-label" htmlFor="profile-province">
              省份
            </label>
            <select
              id="profile-province"
              className="profile-select"
              value={draft.provinceCode ?? ''}
              disabled={saving}
              onChange={(event) =>
                update({ provinceCode: event.target.value || null, cityCode: null })
              }
            >
              <option value="">未设置</option>
              {options.provinces.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div className="profile-field">
            <label className="profile-label" htmlFor="profile-city">
              城市
            </label>
            <select
              id="profile-city"
              className="profile-select"
              value={draft.cityCode ?? ''}
              disabled={saving || !province || province.cities.length === 0}
              onChange={(event) => update({ cityCode: event.target.value || null })}
            >
              <option value="">未设置</option>
              {(province?.cities ?? []).map((city) => (
                <option key={city.code} value={city.code}>
                  {city.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="profile-field">
        <span className="profile-label">性别</span>
        <div className="gender-options" role="group" aria-label="性别">
          {GENDERS.map((gender) => (
            <button
              key={gender}
              type="button"
              className={`gender-option${draft.gender === gender ? ' selected' : ''}`}
              aria-pressed={draft.gender === gender}
              disabled={saving}
              onClick={() => update({ gender: draft.gender === gender ? null : gender })}
            >
              {genderLabel(gender, locale)}
            </button>
          ))}
        </div>
      </div>

      <div className="profile-field">
        <span className="profile-label">出生日期</span>
        <DatePicker
          value={draft.birthDate}
          disabled={saving}
          onChange={(value) => update({ birthDate: value })}
        />
      </div>

      {error && (
        <p className="profile-error" role="alert">
          {error}
        </p>
      )}

      <div className="profile-actions">
        <button type="button" className="profile-cancel" disabled={saving} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="profile-save" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}
