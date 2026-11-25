import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { setFriendRemark } from '../api/profile'
import type { AuthedRequest } from '../api/friends'

type FriendRemarkProps = {
  friendId: string
  remark: string | null
  nickname: string
  requestWithAuth: AuthedRequest
  onSaved: (remark: string | null) => void
  onRelationLost: () => void
}

const MAX_REMARK_LENGTH = 50

/** 按用户可见字符（字素）计数，避免把 Emoji / 组合字符算成多个 */
function graphemeLength(value: string): number {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
  return Array.from(segmenter.segment(value)).length
}

/**
 * 好友备注：展示态点击即可编辑，Enter 保存、Esc 取消。
 * 未设置备注时展示好友昵称，但不会把昵称写入数据库。
 */
export function FriendRemark({
  friendId,
  remark,
  nickname,
  requestWithAuth,
  onSaved,
  onRelationLost
}: FriendRemarkProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(remark ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // 点击编辑区域外的任意位置直接取消，不提交未确认内容
  useEffect(() => {
    if (!editing) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (saving) {
        return
      }

      if (editorRef.current && !editorRef.current.contains(event.target as Node)) {
        setEditing(false)
        setError(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)

    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [editing, saving])

  const startEditing = (): void => {
    if (saving) {
      return
    }

    setDraft(remark ?? '')
    setError(null)
    setEditing(true)
  }

  const cancel = (): void => {
    if (saving) {
      return
    }

    setEditing(false)
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (saving) {
      return
    }

    const value = draft.trim()

    if (graphemeLength(value) > MAX_REMARK_LENGTH) {
      setError(`备注最多 ${MAX_REMARK_LENGTH} 个字符`)
      return
    }

    setSaving(true)
    setError(null)

    try {
      const next = await setFriendRemark(requestWithAuth, friendId, value.length > 0 ? value : null)
      onSaved(next)
      setEditing(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        return
      }

      if (err instanceof ApiError && err.status === 404) {
        onRelationLost()
        return
      }

      setError(err instanceof Error ? err.message : '备注保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="profile-row profile-remark">
        <span className="profile-row-label">备注</span>
        <div className="remark-editor" ref={editorRef}>
          <input
            ref={inputRef}
            className="remark-input"
            type="text"
            value={draft}
            placeholder="设置好友备注"
            aria-label="好友备注"
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }

              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
            }}
          />
        </div>
        {error && <p className="remark-error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="profile-row profile-remark">
      <span className="profile-row-label">备注</span>
      <button type="button" className="remark-value" title="点击编辑备注" onClick={startEditing}>
        <span className={remark ? 'remark-text' : 'remark-text remark-placeholder'}>
          {remark ?? nickname}
        </span>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {error && <p className="remark-error">{error}</p>}
    </div>
  )
}
