import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { th } from '@shared/i18n/th'
import { authApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import { useAuthStore } from '../stores/auth'

type Step = 'phone' | 'otp'

export default function RegisterPage() {
  const navigate = useNavigate()
  const setSession = useAuthStore((state) => state.setSession)
  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [devOtp, setDevOtp] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function requestOtp(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await authApi.register('customer', phone)
      setDevOtp(result.dev_otp ?? null)
      setStep('otp')
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const session = await authApi.verifyOtpAndRegister('customer', { phone, code, password })
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
        <h1 className="text-2xl font-bold text-teal-700">{th.auth.register}</h1>
        <p className="mt-1 text-gray-500">{th.customer.portalName}</p>
      </header>

      {step === 'phone' && (
        <form onSubmit={requestOtp} className="flex flex-col gap-4">
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
          {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="min-h-14 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {busy ? th.common.loading : th.auth.request_otp}
          </button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={verify} className="flex flex-col gap-4">
          <p className="text-gray-600">
            {th.auth.otp_sent_to} <strong>{phone}</strong>
          </p>
          {devOtp && (
            <p className="rounded-lg bg-amber-50 p-3 text-amber-800">
              {th.auth.otp_dev_hint} <strong>{devOtp}</strong>
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.auth.otp_title}</span>
            <input
              inputMode="numeric"
              pattern="\d{6}"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="rounded-xl border border-gray-300 p-3 text-center text-2xl tracking-widest"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.auth.set_password}</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-xl border border-gray-300 p-3 text-base"
            />
            <span className="text-sm text-gray-500">{th.auth.password_hint}</span>
          </label>
          {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="min-h-14 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {busy ? th.common.loading : th.auth.create_account}
          </button>
        </form>
      )}

      <p className="text-center text-gray-600">
        {th.auth.have_account}{' '}
        <Link to="/login" className="font-semibold text-teal-700 underline">
          {th.auth.login}
        </Link>
      </p>
    </main>
  )
}
