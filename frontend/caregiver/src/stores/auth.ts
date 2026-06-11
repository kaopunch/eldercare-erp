import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setAccessToken, setTokenRefresher } from '@shared/api/client'
import { authApi } from '@shared/api/care'
import type { AuthSession, CareUser } from '@shared/api/types'

const PORTAL = 'caregiver' as const

interface AuthState {
  user: CareUser | null
  accessToken: string | null
  refreshToken: string | null
  setSession: (session: AuthSession) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setSession: (session) => {
        setAccessToken(session.access_token)
        set({
          user: session.user,
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
        })
      },
      clear: () => {
        setAccessToken(null)
        set({ user: null, accessToken: null, refreshToken: null })
      },
    }),
    {
      name: 'care-caregiver-auth',
      onRehydrateStorage: () => (state) => {
        setAccessToken(state?.accessToken ?? null)
      },
    },
  ),
)

// Auto-refresh: the api client calls this once on a 401, then retries.
setTokenRefresher(async () => {
  const refreshToken = useAuthStore.getState().refreshToken
  if (!refreshToken) return null
  try {
    const session = await authApi.refresh(PORTAL, refreshToken)
    useAuthStore.getState().setSession(session)
    return session.access_token
  } catch {
    useAuthStore.getState().clear()
    return null
  }
})
