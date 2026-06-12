import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from './stores/auth'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import OnboardPage from './pages/OnboardPage'
import JobsPage from './pages/JobsPage'
import AvailabilityPage from './pages/AvailabilityPage'
import ActiveJobPage from './pages/ActiveJobPage'
import WalletPage from './pages/WalletPage'

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
      <Route
        path="/jobs"
        element={
          <RequireAuth>
            <JobsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/jobs/:id/active"
        element={
          <RequireAuth>
            <ActiveJobPage />
          </RequireAuth>
        }
      />
      <Route
        path="/availability"
        element={
          <RequireAuth>
            <AvailabilityPage />
          </RequireAuth>
        }
      />
      <Route
        path="/wallet"
        element={
          <RequireAuth>
            <WalletPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  )
}

export default App
