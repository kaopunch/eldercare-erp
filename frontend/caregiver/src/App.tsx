import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from './stores/auth'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import OnboardPage from './pages/OnboardPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  if (!user) return <Navigate to="/login" replace />
  return children
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/onboard"
        element={
          <RequireAuth>
            <OnboardPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/onboard" replace />} />
    </Routes>
  )
}

export default App
