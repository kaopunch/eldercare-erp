import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from './stores/auth'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import EldersListPage from './pages/EldersListPage'
import ElderFormPage from './pages/ElderFormPage'
import BookPage from './pages/BookPage'
import BookingsPage from './pages/BookingsPage'
import TrackingPage from './pages/TrackingPage'

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
      <Route
        path="/book"
        element={
          <RequireAuth>
            <BookPage />
          </RequireAuth>
        }
      />
      <Route
        path="/bookings"
        element={
          <RequireAuth>
            <BookingsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/bookings/:id/track"
        element={
          <RequireAuth>
            <TrackingPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/bookings" replace />} />
    </Routes>
  )
}

export default App
