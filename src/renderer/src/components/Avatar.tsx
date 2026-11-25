import { useState } from 'react'
import defaultAvatarUrl from '../assets/default-avatar.png'
import { resolveApiUrl } from '../api/client'

type AvatarProps = {
  /** 服务端返回的头像地址；null/空串时使用永夜默认头像 */
  avatarUrl?: string | null
  /** 头像替代文本：装饰性头像传空字符串即可 */
  alt?: string
}

/**
 * 全局统一头像。
 *
 * - 有自定义头像：按 resolveApiUrl() 解析后的地址加载；
 * - 没有自定义头像：显示永夜默认头像；
 * - 自定义头像加载失败：自动回退默认头像，且不会无限重试。
 *
 * 尺寸完全由外层容器控制（头像图片填满容器），因此各页面保持原有尺寸。
 */
export function Avatar({ avatarUrl, alt = '' }: AvatarProps): React.JSX.Element {
  const resolved = resolveApiUrl(avatarUrl ?? null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const useCustom = resolved !== null && failedSrc !== resolved
  const src = useCustom ? resolved : defaultAvatarUrl

  return (
    <img
      className="avatar-image"
      src={src}
      alt={alt}
      draggable={false}
      onError={() => {
        // 只记录失败地址；下一次渲染会回退到内置默认头像
        if (src !== defaultAvatarUrl) {
          setFailedSrc(src)
        }
      }}
    />
  )
}
