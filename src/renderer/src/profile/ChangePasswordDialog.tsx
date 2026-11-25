import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from '../api/client'
import type { AuthedRequest } from '../api/friends'
import { changeMyPassword } from '../api/profile'

const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 128

type ChangePasswordDialogProps = {
  requestWithAuth: AuthedRequest
  /** 当前设备的 Refresh Token：服务端撤销其他设备凭证时保留这一条 */
  getRefreshToken: () => string | null
  onClose: () => void
  onSuccess: () => void
}

function getChangePasswordErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return '网络异常，请检查网络后重试。'
    }

    if (error.status === 500) {
      return '服务器暂时不可用，请稍后重试。'
    }

    return error.message
  }

  return '修改密码失败，请稍后重试。'
}

/** 修改密码弹窗：原密码 + 新密码 + 确认新密码，提交成功后由调用方关闭并提示 */
export function ChangePasswordDialog({
  requestWithAuth,
  getRefreshToken,
  onClose,
  onSuccess
}: ChangePasswordDialogProps): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState<string>('')
  const [newPassword, setNewPassword] = useState<string>('')
  const [confirmPassword, setConfirmPassword] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<boolean>(false)

  const currentInputRef = useRef<HTMLInputElement | null>(null)
  const submittingRef = useRef<boolean>(false)

  useEffect(() => {
    currentInputRef.current?.focus()
  }, [])

  // 提交中不允许 Esc 关闭，避免用户以为已经取消
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submittingRef.current) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()

      if (submittingRef.current) {
        return
      }

      if (currentPassword.trim().length === 0) {
        setError('请输入原密码')
        return
      }

      if (newPassword.length === 0) {
        setError('请输入新密码')
        return
      }

      if (confirmPassword.length === 0) {
        setError('请再次输入新密码')
        return
      }

      if (newPassword !== confirmPassword) {
        setError('两次输入的新密码不一致')
        return
      }

      if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
        setError('新密码不符合密码要求（长度为 8～128 个字符）')
        return
      }

      if (newPassword === currentPassword) {
        setError('新密码不能与原密码相同')
        return
      }

      submittingRef.current = true
      setSubmitting(true)
      setError(null)

      try {
        await changeMyPassword(requestWithAuth, currentPassword, newPassword, getRefreshToken())
        onSuccess()
      } catch (submitError) {
        setError(getChangePasswordErrorMessage(submitError))
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [confirmPassword, currentPassword, getRefreshToken, newPassword, onSuccess, requestWithAuth]
  )

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submittingRef.current) {
          onClose()
        }
      }}
    >
      <form
        className="password-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="修改密码"
        onSubmit={handleSubmit}
      >
        <h2 className="password-dialog-title">修改密码</h2>

        <label className="password-field">
          <span className="password-field-label">原密码</span>
          <input
            ref={currentInputRef}
            className="password-input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="password-field">
          <span className="password-field-label">新密码</span>
          <input
            className="password-input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="password-field">
          <span className="password-field-label">确认新密码</span>
          <input
            className="password-input"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={submitting}
          />
        </label>

        <p className="password-hint">密码长度需为 8～128 个字符</p>

        {error ? (
          <p className="password-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="password-actions">
          <button className="password-cancel" type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="password-confirm" type="submit" disabled={submitting}>
            {submitting ? '修改中…' : '确认修改'}
          </button>
        </div>
      </form>
    </div>
  )
}
