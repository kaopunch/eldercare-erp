import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { th } from '@shared/i18n/th'
import { authApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import { useAuthStore } from '../stores/auth'

export default function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAuthStore((state) => state.setSession)
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const session = await authApi.login('customer', { phone, password })
      setSession(session)
      navigate('/elders')
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <header className="text-center">
        <h1 className="text-2xl font-bold text-teal-700">{th.customer.portalName}</h1>
        <p className="mt-1 text-gray-500">{th.customer.tagline}</p>
      </header>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="font-medium">{th.auth.phone}</span>
          <input
            type="tel"
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder={th.auth.phone_placeholder}
            className="rounded-xl border border-gray-300 p-3 text-base"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{th.auth.password}</span>
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-xl border border-gray-300 p-3 text-base"
          />
        </label>
        {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="min-h-14 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
        >
          {busy ? th.common.loading : th.auth.login}
        </button>
      </form>
      <p className="text-center text-gray-600">
        {th.auth.no_account}{' '}
        <Link to="/register" className="font-semibold text-teal-700 underline">
          {th.auth.register}
        </Link>
      </p>
    </main>
  )
}
