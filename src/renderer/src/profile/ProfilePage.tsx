import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { ApiError, resolveApiUrl } from '../api/client'
import type { Friend } from '../api/friends'
import defaultAvatarUrl from '../assets/default-avatar.png'
import {
  getFriendProfile,
  getMyProfile,
  getProfileOptions,
  uploadMyAvatar,
  type FriendProfile,
  type MyProfile,
  type ProfileOptions
} from '../api/profile'
import { getFriendDisplayName } from '../friends/displayName'
import { FriendRemark } from './FriendRemark'
import { ProfileEditForm } from './ProfileEditForm'
import { countryLabel, currentLocale, formatAge, formatBirthDate, genderLabel } from './labels'

type ProfilePageProps = {
  online: boolean
  onBack: () => void
  onToast: (message: string) => void
  /** 自己的头像上传/恢复默认后通知外层，让导航栏、聊天头像等即时同步 */
  onAvatarChanged?: (avatarUrl: string | null) => void
  /** 传入好友即为好友资料模式；不传则是当前用户自己的资料 */
  friend?: Friend | null
  onSendMessage?: (friend: Friend) => void
  onDeleteFriend?: (friend: Friend) => void
  /** 好友关系已被解除（备注接口 404）时的回调 */
  onRelationLost?: () => void
  /** 备注保存成功后的回调，用于同步联系人/会话列表与聊天标题 */
  onRemarkChanged?: (friendId: string, remark: string | null) => void
}

const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024
const ALLOWED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

type RowProps = { label: string; value: string }

function ProfileRow({ label, value }: RowProps): React.JSX.Element {
  return (
    <div className="profile-row">
      <span className="profile-row-label">{label}</span>
      <span className="profile-row-value">{value}</span>
    </div>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 旧环境或权限不足时回退到临时 textarea
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 个人资料页：占据右侧聊天区域。
 * - 不传 friend：自己的资料，可编辑；
 * - 传入 friend：好友资料，只读，可编辑备注、发消息、删除好友。
 */
export function ProfilePage({
  online,
  onBack,
  onToast,
  onAvatarChanged,
  friend,
  onSendMessage,
  onDeleteFriend,
  onRelationLost,
  onRemarkChanged
}: ProfilePageProps): React.JSX.Element {
  const { requestWithAuth } = useAuth()
  const locale = currentLocale()
  const friendId = friend?.id ?? null
  const isFriend = friendId !== null

  const [profile, setProfile] = useState<MyProfile | FriendProfile | null>(null)
  const [options, setOptions] = useState<ProfileOptions | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextProfile, nextOptions] = await Promise.all([
        friendId ? getFriendProfile(requestWithAuth, friendId) : getMyProfile(requestWithAuth),
        getProfileOptions(requestWithAuth)
      ])
      setProfile(nextProfile as MyProfile | FriendProfile)
      setOptions(nextOptions)
      setLoadError(null)
      setStatus('ready')
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setLoadError('好友关系已不存在，无法查看该资料。')
      } else {
        setLoadError(error instanceof Error ? error.message : '资料加载失败，请稍后重试。')
      }
      setStatus('error')
    }
  }, [friendId, requestWithAuth])

  useEffect(() => {
    // 数据获取 effect：切换资料对象后重新请求，加载态由 load 内部维护
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const retry = (): void => {
    setStatus('loading')
    void load()
  }

  const handleCopy = async (): Promise<void> => {
    if (!profile) {
      return
    }

    const ok = await copyText(profile.uid)
    onToast(ok ? 'UID 已复制' : '复制失败，请手动选择 UID')
  }

  const avatarSrc = resolveApiUrl(profile?.avatarUrl ?? null) ?? defaultAvatarUrl

  const handleAvatarFile = async (file: File | undefined): Promise<void> => {
    if (!file || avatarUploading) {
      return
    }

    // 客户端只做即时提示，最终仍以服务端 sharp 解析结果为准
    if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
      onToast('仅支持 JPG、PNG、WebP 格式的图片')
      return
    }

    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      onToast('图片大小不能超过 5MB')
      return
    }

    setAvatarUploading(true)

    try {
      const next = await uploadMyAvatar(requestWithAuth, file)
      setProfile((current) => (current ? { ...current, ...next } : next))
      onAvatarChanged?.(next.avatarUrl)
      onToast('头像已更新')
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : '头像上传失败，请稍后重试。')
    } finally {
      setAvatarUploading(false)

      if (avatarInputRef.current) {
        avatarInputRef.current.value = ''
      }
    }
  }

  const countryName = profile?.countryCode
    ? options?.countries.find((country) => country.code === profile.countryCode)
    : undefined
  const provinceName = profile?.provinceCode
    ? options?.provinces.find((province) => province.code === profile.provinceCode)?.name
    : undefined
  const cityName =
    profile?.countryCode === 'CN' && profile.provinceCode && profile.cityCode
      ? options?.provinces
          .find((province) => province.code === profile.provinceCode)
          ?.cities.find((city) => city.code === profile.cityCode)?.name
      : undefined

  const remark = isFriend ? ((profile as FriendProfile | null)?.remark ?? null) : null
  // 好友页主要身份名称：备注优先；自己的资料始终使用自己的昵称
  const displayName = profile
    ? isFriend
      ? getFriendDisplayName({ ...profile, remark })
      : profile.nickname
    : ''

  return (
    <section className="profile-page" aria-label={isFriend ? '好友资料' : '个人资料'}>
      <header className="profile-header">
        <button type="button" className="profile-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          返回
        </button>
        <h2 className="profile-title">{isFriend ? '好友资料' : '个人资料'}</h2>
        {!isFriend && !editing && status === 'ready' && (
          <button
            type="button"
            className="profile-edit-toggle"
            disabled={!options}
            onClick={() => {
              setSaveError(null)
              setEditing(true)
            }}
          >
            编辑资料
          </button>
        )}
      </header>

      <div className="profile-body">
        {status === 'loading' && (
          <p className="profile-hint">{isFriend ? '正在加载好友资料…' : '正在加载个人资料…'}</p>
        )}

        {status === 'error' && (
          <div className="profile-hint">
            <p>{loadError}</p>
            <button type="button" className="profile-retry" onClick={retry}>
              重试
            </button>
          </div>
        )}

        {status === 'ready' && profile && !isFriend && editing && options && (
          <ProfileEditForm
            profile={profile}
            options={options}
            locale={locale}
            requestWithAuth={requestWithAuth}
            saving={saving}
            setSaving={setSaving}
            error={saveError}
            setError={setSaveError}
            onCancel={() => {
              setEditing(false)
              setSaveError(null)
            }}
            onSaved={(next) => {
              setProfile(next)
              setEditing(false)
              setSaveError(null)
              onToast('资料已保存')
            }}
          />
        )}

        {status === 'ready' && profile && (isFriend || !editing) && (
          <>
            <div className="profile-identity">
              <div className="profile-avatar-column">
                <span className="profile-avatar">
                  {isFriend ? (
                    <img
                      className="profile-avatar-image"
                      src={avatarSrc}
                      alt=""
                      onError={(event) => {
                        if (event.currentTarget.src !== defaultAvatarUrl) {
                          event.currentTarget.src = defaultAvatarUrl
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="profile-avatar-button"
                      aria-label="更换头像"
                      disabled={avatarUploading}
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      <img
                        className="profile-avatar-image"
                        src={avatarSrc}
                        alt=""
                        onError={(event) => {
                          if (event.currentTarget.src !== defaultAvatarUrl) {
                            event.currentTarget.src = defaultAvatarUrl
                          }
                        }}
                      />
                      {avatarUploading && <span className="profile-avatar-mask">上传中…</span>}
                    </button>
                  )}
                </span>
                {!isFriend && (
                  <input
                    ref={avatarInputRef}
                    className="profile-avatar-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="选择头像图片"
                    onChange={(event) => void handleAvatarFile(event.target.files?.[0])}
                  />
                )}
              </div>
              <div className="profile-identity-text">
                <p className="profile-nickname">{displayName}</p>
                <p className={`profile-presence${online ? ' online' : ''}`}>
                  <span className="profile-presence-dot" aria-hidden="true" />
                  {online ? '在线' : '离线'}
                </p>
              </div>
            </div>

            <div className="profile-uid-row">
              <span className="profile-row-label">UID</span>
              <span className="profile-uid">{profile.uid}</span>
              <button type="button" className="profile-copy" onClick={() => void handleCopy()}>
                复制
              </button>
            </div>

            <div className="profile-rows">
              {isFriend && friend && (
                <>
                  <ProfileRow label="昵称" value={profile.nickname} />
                  <FriendRemark
                    friendId={friend.id}
                    remark={remark}
                    nickname={profile.nickname}
                    requestWithAuth={requestWithAuth}
                    onSaved={(next) => {
                      setProfile((current) => (current ? { ...current, remark: next } : current))
                      onRemarkChanged?.(friend.id, next)
                      onToast(next ? '备注已保存' : '备注已清空')
                    }}
                    onRelationLost={() => {
                      onToast('好友关系已不存在')
                      onRelationLost?.()
                    }}
                  />
                </>
              )}
              {profile.signature && <ProfileRow label="个性签名" value={profile.signature} />}
              <ProfileRow label="等级" value={`LV.${profile.level}（${profile.activityPoints}）`} />
              {countryName && (
                <ProfileRow label="国家/地区" value={countryLabel(countryName, locale)} />
              )}
              {provinceName && <ProfileRow label="省份" value={provinceName} />}
              {cityName && <ProfileRow label="城市" value={cityName} />}
              {profile.gender && (
                <ProfileRow label="性别" value={genderLabel(profile.gender, locale) ?? ''} />
              )}
              {profile.birthDate && (
                <ProfileRow label="出生日期" value={formatBirthDate(profile.birthDate, locale)} />
              )}
              {profile.age !== null && (
                <ProfileRow label="年龄" value={formatAge(profile.age, locale) ?? ''} />
              )}
            </div>
          </>
        )}
      </div>

      {isFriend && friend && status === 'ready' && !editing && (
        <div className="profile-footer">
          <button
            type="button"
            className="profile-action profile-action-primary"
            onClick={() => onSendMessage?.(friend)}
          >
            发消息
          </button>
          <button
            type="button"
            className="profile-action profile-action-danger"
            onClick={() => onDeleteFriend?.(friend)}
          >
            删除好友
          </button>
        </div>
      )}
    </section>
  )
}
