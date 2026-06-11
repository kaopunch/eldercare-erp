import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from './stores/auth'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import EldersListPage from './pages/EldersListPage'
import ElderFormPage from './pages/ElderFormPage'

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
        path="/elders"
        element={
          <RequireAuth>
            <EldersListPage />
          </RequireAuth>
        }
      />
      <Route
        path="/elders/new"
        element={
          <RequireAuth>
            <ElderFormPage />
          </RequireAuth>
        }
      />
      <Route
        path="/elders/:id/edit"
        element={
          <RequireAuth>
            <ElderFormPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/elders" replace />} />
    </Routes>
  )
}

export default App
