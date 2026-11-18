import { useEffect, useMemo, useRef, useState } from 'react'

type Message = {
  id: string
  text: string
  time: string
  mine: boolean
}

type Friend = {
  id: string
  name: string
  avatar: string
  color: string
}

// 模拟的好友列表（头像用姓名首字代替，避免引入图片资源）
const FRIENDS: Friend[] = [
  { id: 'lin', name: '林小满', avatar: '林', color: '#4f7cf7' },
  { id: 'zhou', name: '周一鸣', avatar: '周', color: '#ef8b4a' },
  { id: 'chen', name: '陈可欣', avatar: '陈', color: '#2fb3a3' },
  { id: 'wang', name: '王老师', avatar: '王', color: '#9a6ff2' }
]

// 模拟的聊天记录：键是好友 id，值是消息数组
const INITIAL_MESSAGES: Record<string, Message[]> = {
  lin: [
    { id: 'lin-1', text: '在吗？周末一起去看新开的插画展吧。', time: '09:12', mine: false },
    { id: 'lin-2', text: '可以呀，我周六下午有空。', time: '09:15', mine: true },
    { id: 'lin-3', text: '那周六下午两点，展馆门口见～', time: '09:16', mine: false }
  ],
  zhou: [
    { id: 'zhou-1', text: '昨天的会议纪要发你邮箱了。', time: '10:02', mine: false },
    { id: 'zhou-2', text: '收到，我下午看。', time: '10:05', mine: true }
  ],
  chen: [
    { id: 'chen-1', text: '你说的那家咖啡店叫什么名字？', time: '13:20', mine: true },
    { id: 'chen-2', text: '叫「午后」，在城南路 18 号。', time: '13:22', mine: false },
    { id: 'chen-3', text: '好的，我周末去试试。', time: '13:24', mine: true }
  ],
  wang: [{ id: 'wang-1', text: '作业记得周五之前提交。', time: '16:40', mine: false }]
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function App(): React.JSX.Element {
  // 当前选中的好友 id
  const [activeFriendId, setActiveFriendId] = useState<string>(FRIENDS[0].id)
  // 所有好友的聊天记录
  const [messages, setMessages] = useState<Record<string, Message[]>>(INITIAL_MESSAGES)
  // 输入框里的文字
  const [draft, setDraft] = useState<string>('')
  // 指向消息列表容器，用来让它滚动到底部
  const messageListRef = useRef<HTMLDivElement>(null)

  const activeFriend = FRIENDS.find((friend) => friend.id === activeFriendId) ?? FRIENDS[0]
  // 当前好友的消息列表；用 useMemo 保持引用稳定，避免 useEffect 依赖每次都变化
  const activeMessages = useMemo(() => messages[activeFriendId] ?? [], [messages, activeFriendId])

  // 切换好友或新增消息后，把消息列表滚到最底部
  useEffect(() => {
    const list = messageListRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [activeFriendId, activeMessages])

  const sendMessage = (): void => {
    const text = draft.trim()
    if (!text) {
      return
    }
    const message: Message = {
      id: crypto.randomUUID(),
      text,
      time: formatTime(new Date()),
      mine: true
    }
    // 只把新消息追加到“当前好友”的聊天记录里，其他好友的记录保持不变
    setMessages((previous) => ({
      ...previous,
      [activeFriendId]: [...(previous[activeFriendId] ?? []), message]
    }))
    setDraft('')
  }

  const handleDraftChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value)
  }

  // 按 Enter 发送；使用中文输入法选词时（isComposing 为 true）不发送
  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      sendMessage()
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    sendMessage()
  }

  return (
    <div className="app">
      {/* 左侧：好友列表 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1 className="brand">MyChatApp</h1>
          <p className="brand-subtitle">我的好友 · {FRIENDS.length}</p>
        </div>

        <div className="friend-list">
          {FRIENDS.map((friend) => {
            const friendMessages = messages[friend.id] ?? []
            const lastMessage = friendMessages[friendMessages.length - 1]
            return (
              <button
                key={friend.id}
                type="button"
                className={friend.id === activeFriendId ? 'friend-item active' : 'friend-item'}
                onClick={() => setActiveFriendId(friend.id)}
              >
                <span className="avatar" style={{ backgroundColor: friend.color }}>
                  {friend.avatar}
                </span>
                <span className="friend-info">
                  <span className="friend-name">{friend.name}</span>
                  <span className="friend-preview">
                    {lastMessage ? lastMessage.text : '还没有消息'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* 右侧：聊天区域 */}
      <main className="chat">
        <header className="chat-header">
          <span className="avatar" style={{ backgroundColor: activeFriend.color }}>
            {activeFriend.avatar}
          </span>
          <div className="chat-title">
            <span className="chat-name">{activeFriend.name}</span>
            <span className="chat-status">在线</span>
          </div>
        </header>

        <div className="messages" ref={messageListRef}>
          {activeMessages.map((message) => (
            <div key={message.id} className={message.mine ? 'message-row mine' : 'message-row'}>
              {!message.mine && (
                <span className="bubble-avatar" style={{ backgroundColor: activeFriend.color }}>
                  {activeFriend.avatar}
                </span>
              )}
              <div className="bubble">
                <p className="bubble-text">{message.text}</p>
                <span className="bubble-time">{message.time}</span>
              </div>
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <input
            className="composer-input"
            type="text"
            value={draft}
            onChange={handleDraftChange}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入消息，按 Enter 发送"
            aria-label="消息输入框"
          />
          <button className="send-button" type="submit" disabled={draft.trim() === ''}>
            发送
          </button>
        </form>
      </main>
    </div>
  )
}

export default App
