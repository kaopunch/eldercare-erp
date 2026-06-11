import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { onboardApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import type { CaregiverBackground, DocumentType, LatLng } from '@shared/api/types'
import { useAuthStore } from '../stores/auth'

const STEPS = [
  th.caregiver.onboard_step1,
  th.caregiver.onboard_step2,
  th.caregiver.onboard_step3,
  th.caregiver.onboard_step4,
]

const BACKGROUND_OPTIONS: { value: CaregiverBackground; label: string }[] = [
  { value: 'nurse_retired', label: th.caregiver.bg_nurse_retired },
  { value: 'nurse_assistant', label: th.caregiver.bg_nurse_assistant },
  { value: 'health_student', label: th.caregiver.bg_health_student },
  { value: 'trained_general', label: th.caregiver.bg_trained_general },
]

const DOCUMENTS: { type: DocumentType; label: string }[] = [
  { type: 'photo', label: th.caregiver.doc_photo },
  { type: 'id_card', label: th.caregiver.doc_id_card },
  { type: 'certificate', label: th.caregiver.doc_certificate },
]

const STATUS_LABEL: Record<string, string> = {
  pending: th.caregiver.status_pending,
  documents_submitted: th.caregiver.status_documents_submitted,
  verified: th.caregiver.status_verified,
  rejected: th.caregiver.status_rejected,
}

const inputClass = 'rounded-xl border border-gray-300 p-3 text-base'

export default function OnboardPage() {
  const navigate = useNavigate()
  const clear = useAuthStore((state) => state.clear)
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['onboard-status'], queryFn: onboardApi.status })

  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // step 1
  const [fullName, setFullName] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [gender, setGender] = useState('')
  const [idCard, setIdCard] = useState('')
  const [background, setBackground] = useState<CaregiverBackground | ''>('')
  const [english, setEnglish] = useState(false)
  // step 3
  const [center, setCenter] = useState<LatLng | null>(null)
  const [radius, setRadius] = useState('10')
  const [rateHalf, setRateHalf] = useState('')
  const [rateFull, setRateFull] = useState('')

  const checklist = status.data?.checklist
  const profile = status.data?.profile

  useEffect(() => {
    if (!profile) return
    setFullName(profile.full_name)
    setBirthDate(profile.birth_date ?? '')
    setGender(profile.gender ?? '')
    setBackground(profile.background ?? '')
    setEnglish(profile.languages.includes('en'))
    if (profile.service_area) {
      setCenter({ lat: profile.service_area.lat, lng: profile.service_area.lng })
      setRadius(String(profile.service_area.radius_km ?? 10))
    }
    if (profile.base_rate_half_day_satang !== null) {
      setRateHalf(String(profile.base_rate_half_day_satang / 100))
    }
    if (profile.base_rate_full_day_satang !== null) {
      setRateFull(String(profile.base_rate_full_day_satang / 100))
    }
  }, [profile])

  // jump to the status step when documents are already submitted
  useEffect(() => {
    if (status.data && status.data.verification_status !== 'pending') {
      setStep(3)
    }
  }, [status.data])

  function useCurrentLocation() {
    navigator.geolocation?.getCurrentPosition(
      (position) => setCenter({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setError(th.common.error_generic),
    )
  }

  async function saveStep1() {
    setBusy(true)
    setError(null)
    try {
      await onboardApi.saveProfile({
        full_name: fullName,
        birth_date: birthDate || null,
        gender: (gender || null) as 'male' | 'female' | 'other' | null,
        ...(idCard ? { id_card_number: idCard } : {}),
        background: background || null,
        languages: english ? ['th', 'en'] : ['th'],
      })
      await queryClient.invalidateQueries({ queryKey: ['onboard-status'] })
      setStep(1)
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function saveStep3() {
    setBusy(true)
    setError(null)
    try {
      await onboardApi.saveProfile({
        full_name: fullName,
        ...(center ? { service_area: { ...center, radius_km: Number(radius) } } : {}),
        ...(rateHalf ? { base_rate_half_day_baht: Number(rateHalf) } : {}),
        ...(rateFull ? { base_rate_full_day_baht: Number(rateFull) } : {}),
      })
      await queryClient.invalidateQueries({ queryKey: ['onboard-status'] })
      setStep(3)
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function upload(type: DocumentType, file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await onboardApi.uploadDocument(type, file)
      await queryClient.invalidateQueries({ queryKey: ['onboard-status'] })
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  const verificationStatus = status.data?.verification_status ?? 'pending'

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-amber-700">{th.caregiver.onboard_title}</h1>
          <p className="text-sm text-gray-500">
            {th.common.step} {step + 1}/4 — {STEPS[step]}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            clear()
            navigate('/login')
          }}
          className="text-sm text-gray-500 underline"
        >
          {th.common.logout}
        </button>
      </header>
      <div className="flex gap-1">
        {STEPS.map((label, index) => (
          <div key={label} className={`h-1.5 flex-1 rounded ${index <= step ? 'bg-amber-600' : 'bg-gray-200'}`} />
        ))}
      </div>

      {step === 0 && (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.caregiver.full_name}</span>
            <input required value={fullName} onChange={(event) => setFullName(event.target.value)} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.caregiver.birth_date}</span>
              <input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.caregiver.gender}</span>
              <select value={gender} onChange={(event) => setGender(event.target.value)} className={inputClass}>
                <option value="">—</option>
                <option value="male">{th.customer.gender_male}</option>
                <option value="female">{th.customer.gender_female}</option>
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.caregiver.id_card}</span>
            <input
              inputMode="numeric"
              maxLength={13}
              value={idCard}
              onChange={(event) => setIdCard(event.target.value.replace(/\D/g, ''))}
              placeholder={checklist?.id_card_number ? '••••••••••••• (บันทึกแล้ว)' : ''}
              className={inputClass}
            />
            <span className="text-sm text-gray-500">{th.caregiver.id_card_secure_note}</span>
          </label>
          <fieldset className="flex flex-col gap-2">
            <span className="font-medium">{th.caregiver.background}</span>
            {BACKGROUND_OPTIONS.map((option) => (
              <label key={option.value} className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 px-3">
                <input
                  type="radio"
                  name="background"
                  checked={background === option.value}
                  onChange={() => setBackground(option.value)}
                  className="h-5 w-5"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <span className="font-medium">{th.caregiver.languages}</span>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 px-3 text-gray-500">
              <input type="checkbox" checked disabled className="h-5 w-5" />
              <span>{th.caregiver.lang_th}</span>
            </label>
            <label className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 px-3">
              <input type="checkbox" checked={english} onChange={(event) => setEnglish(event.target.checked)} className="h-5 w-5" />
              <span>{th.caregiver.lang_en}</span>
            </label>
          </fieldset>
          {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
          <button
            type="button"
            disabled={busy || !fullName.trim() || !background}
            onClick={saveStep1}
            className="min-h-14 rounded-xl bg-amber-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {busy ? th.common.loading : th.caregiver.submit_profile}
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-gray-500">{th.caregiver.upload_hint}</p>
          {DOCUMENTS.map((doc) => {
            const done = checklist?.documents[doc.type]
            return (
              <div key={doc.type} className="flex items-center justify-between rounded-xl border border-gray-200 p-4">
                <div>
                  <p className="font-medium">{doc.label}</p>
                  {done && <p className="text-sm text-green-600">{th.caregiver.uploaded}</p>}
                </div>
                <label className="cursor-pointer rounded-xl bg-amber-600 px-4 py-3 font-semibold text-white">
                  {th.caregiver.upload}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={(event) => upload(doc.type, event.target.files?.[0])}
                  />
                </label>
              </div>
            )
          })}
          {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
          <div className="mt-auto flex gap-3">
            <button type="button" onClick={() => setStep(0)} className="min-h-14 flex-1 rounded-xl border border-gray-300 text-lg font-medium">
              {th.common.back}
            </button>
            <button
              type="button"
              disabled={busy || !checklist?.documents.id_card || !checklist?.documents.photo}
              onClick={() => setStep(2)}
              className="min-h-14 flex-1 rounded-xl bg-amber-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              {th.common.next}
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="font-medium">{th.caregiver.service_area}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={useCurrentLocation}
                className="rounded-lg border border-amber-600 px-3 py-2 text-sm font-medium text-amber-700"
              >
                {th.customer.use_current_location}
              </button>
              <span className={center ? 'text-amber-700' : 'text-gray-400'}>
                {center
                  ? `${th.caregiver.service_center}: ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`
                  : th.customer.location_unset}
              </span>
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.caregiver.radius_km}</span>
            <input type="number" min={1} max={100} value={radius} onChange={(event) => setRadius(event.target.value)} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.caregiver.rate_half_day}</span>
              <input type="number" min={0} value={rateHalf} onChange={(event) => setRateHalf(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.caregiver.rate_full_day}</span>
              <input type="number" min={0} value={rateFull} onChange={(event) => setRateFull(event.target.value)} className={inputClass} />
            </label>
          </div>
          {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
          <div className="mt-auto flex gap-3">
            <button type="button" onClick={() => setStep(1)} className="min-h-14 flex-1 rounded-xl border border-gray-300 text-lg font-medium">
              {th.common.back}
            </button>
            <button
              type="button"
              disabled={busy || !center || !rateHalf || !rateFull}
              onClick={saveStep3}
              className="min-h-14 flex-1 rounded-xl bg-amber-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              {busy ? th.common.loading : th.common.save}
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="flex flex-col gap-4">
          <div
            className={`rounded-xl p-4 ${
              verificationStatus === 'verified'
                ? 'bg-green-50 text-green-800'
                : verificationStatus === 'rejected'
                  ? 'bg-red-50 text-red-700'
                  : 'bg-amber-50 text-amber-800'
            }`}
          >
            <p className="text-lg font-semibold">{th.caregiver.status_title}</p>
            <p className="mt-1">{STATUS_LABEL[verificationStatus]}</p>
            {status.data?.verification_note && (
              <p className="mt-2 text-sm">
                {th.caregiver.note_from_team}: {status.data.verification_note}
              </p>
            )}
          </div>
          {checklist && (
            <ul className="flex flex-col gap-2">
              {[
                { ok: checklist.profile_complete, label: th.caregiver.checklist_profile },
                { ok: checklist.id_card_number, label: th.caregiver.checklist_id_card_no },
                { ok: checklist.documents.id_card, label: th.caregiver.doc_id_card },
                { ok: checklist.documents.photo, label: th.caregiver.doc_photo },
                { ok: checklist.service_area, label: th.caregiver.checklist_area },
                { ok: checklist.rates, label: th.caregiver.checklist_rates },
              ].map((item) => (
                <li key={item.label} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3">
                  <span className={item.ok ? 'text-green-600' : 'text-gray-300'}>{item.ok ? '✓' : '○'}</span>
                  <span className={item.ok ? '' : 'text-gray-500'}>{item.label}</span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setStep(0)}
            className="min-h-14 rounded-xl border border-amber-600 text-lg font-medium text-amber-700"
          >
            {th.common.edit}
          </button>
        </section>
      )}
    </main>
  )
}
