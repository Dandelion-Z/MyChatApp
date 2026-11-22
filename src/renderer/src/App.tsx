import { useAuth } from './auth/AuthContext'
import AuthScreen from './components/AuthScreen'
import ChatScreen from './components/ChatScreen'

function App(): React.JSX.Element {
  const { status } = useAuth()

  if (status === 'loading') {
    return (
      <div className="app-loading">
        <p>正在加载…</p>
      </div>
    )
  }

  return status === 'authenticated' ? <ChatScreen /> : <AuthScreen />
}

export default App
