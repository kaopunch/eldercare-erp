import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { activeJobApi } from '@shared/api/care'
import { postCritical, onOutboxChange } from '../lib/outbox'
import type { ApiError } from '@shared/api/client'
import type { BookingStatus, LatLng, PhotoUpload } from '@shared/api/types'

const MOBILITY_LABEL: Record<string, string> = {
  walk: th.customer.mobility_walk,
  cane: th.customer.mobility_cane,
  walker: th.customer.mobility_walker,
  wheelchair: th.customer.mobility_wheelchair,
  bedridden: th.customer.mobility_bedridden,
}

const PING_INTERVAL_MS = 30_000
const PINGABLE: BookingStatus[] = ['in_progress_pickup', 'at_destination', 'returning']

const inputClass = 'rounded-xl border border-gray-300 p-3 text-base'

function getLocation(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('no geolocation'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => reject(error),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  })
}

function fileToPhoto(file: File): Promise<PhotoUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve({ content_type: file.type, data_base64: result.includes(',') ? result.split(',')[1] : result })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export default function ActiveJobPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const job = useQuery({ queryKey: ['job', id], queryFn: () => activeJobApi.get(id!) })

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [checkinPhoto, setCheckinPhoto] = useState<PhotoUpload | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)
  useEffect(() => onOutboxChange(setQueuedCount), [])
  // health record form
  const [bp, setBp] = useState('')
  const [pulse, setPulse] = useState('')
  const [temp, setTemp] = useState('')
  const [doctorSummary, setDoctorSummary] = useState('')
  const [meds, setMeds] = useState<{ name: string; note: string }[]>([])
  const [nextDate, setNextDate] = useState('')
  const [nextDept, setNextDept] = useState('')
  const [attachments, setAttachments] = useState<PhotoUpload[]>([])
  const [healthSaved, setHealthSaved] = useState(false)

  const status = job.data?.status
  // pending pings buffered while offline/failed, flushed on the next tick
  const pingBuffer = useRef<{ lat: number; lng: number }[]>([])

  useEffect(() => {
    if (!id || !status || !PINGABLE.includes(status)) return
    let cancelled = false
    async function tick() {
      try {
        const location = await getLocation()
        pingBuffer.current.push(location)
        while (pingBuffer.current.length && !cancelled) {
          const next = pingBuffer.current[0]
          await activeJobApi.ping(id!, next.lat, next.lng)
          pingBuffer.current.shift()
        }
      } catch {
        // keep buffered; retry next interval (full offline queue lands in M6)
      }
    }
    tick()
    const timer = setInterval(tick, PING_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [id, status])

  async function runStep(action: (location: LatLng) => Promise<unknown>, needsLocation = true) {
    setBusy(true)
    setError(null)
    try {
      const location = needsLocation ? await getLocation() : ({ lat: 0, lng: 0 } as LatLng)
      await action(location)
      await queryClient.invalidateQueries({ queryKey: ['job', id] })
    } catch (err) {
      const apiError = err as ApiError
      setError(apiError.message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function saveHealth() {
    setBusy(true)
    setError(null)
    try {
      await postCritical(`/api/v1/caregiver/jobs/${id}/health-record`, {
        vital_signs: { ...(bp && { bp }), ...(pulse && { pulse }), ...(temp && { temp }) },
        doctor_summary: doctorSummary || null,
        medications_received: meds.filter((med) => med.name.trim()),
        next_appointment: nextDate ? { date: nextDate, department: nextDept || undefined } : null,
        attachments,
      })
      setHealthSaved(true)
      setNotice(th.caregiver.hr_saved)
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function sendSos() {
    if (!window.confirm(th.caregiver.sos_confirm)) return
    try {
      const location = await getLocation().catch(() => null)
      await activeJobApi.sos(id!, location)
      setNotice(th.caregiver.sos_sent)
    } catch {
      setError(th.common.error_generic)
    }
  }

  const elder = job.data?.elder
  const bigButton =
    'min-h-16 w-full rounded-2xl bg-amber-600 text-xl font-bold text-white disabled:opacity-50'

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex items-start justify-between">
        <div>
          <button type="button" onClick={() => navigate('/jobs')} className="text-sm text-gray-500 underline">
            ← {th.caregiver.my_jobs}
          </button>
          <h1 className="text-xl font-bold text-amber-700">{job.data?.destination_name}</h1>
          <p className="text-sm text-gray-500">
            {job.data?.scheduled_date} · {job.data?.pickup_time?.slice(0, 5)} น.
          </p>
        </div>
        <button
          type="button"
          onClick={sendSos}
          className="min-h-14 rounded-2xl bg-red-600 px-5 text-lg font-extrabold text-white"
        >
          {th.caregiver.sos}
        </button>
      </header>

      {elder && (
        <section className="rounded-xl bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">{th.caregiver.elder_card_title}</p>
          <p className="text-lg font-bold">
            {elder.nickname || elder.full_name}
            {elder.mobility && (
              <span className="ml-2 text-sm font-medium text-amber-800">{MOBILITY_LABEL[elder.mobility]}</span>
            )}
          </p>
          {elder.chronic_conditions.length > 0 && (
            <p className="text-sm text-gray-700">{elder.chronic_conditions.join(', ')}</p>
          )}
          {elder.special_notes && <p className="mt-1 text-sm font-medium text-red-700">⚠ {elder.special_notes}</p>}
          {elder.family_phone && (
            <a href={`tel:${elder.family_phone}`} className="mt-1 block text-sm font-semibold text-amber-800 underline">
              {th.caregiver.family_phone}: {elder.family_phone}
            </a>
          )}
        </section>
      )}

      {queuedCount > 0 && (
        <p className="rounded-lg bg-amber-100 p-3 text-amber-900">
          {th.common.offline_notice} ({queuedCount})
        </p>
      )}
      {notice && <p className="rounded-lg bg-green-50 p-3 text-green-700">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
      {status && PINGABLE.includes(status) && (
        <p className="text-center text-xs text-gray-400">{th.caregiver.ping_active}</p>
      )}

      {status === 'confirmed' && (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">{th.caregiver.step_checkin_hint}</p>
          <label className="flex min-h-14 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-amber-400 font-semibold text-amber-700">
            {checkinPhoto ? th.caregiver.photo_ready : `📷 ${th.caregiver.take_photo}`}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (file) setCheckinPhoto(await fileToPhoto(file))
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy || !checkinPhoto}
            onClick={() => runStep((location) => postCritical(`/api/v1/caregiver/jobs/${id}/checkin`, { photo: checkinPhoto, location }))}
            className={bigButton}
          >
            {busy ? th.common.loading : th.caregiver.step_checkin}
          </button>
        </section>
      )}

      {status === 'in_progress_pickup' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => runStep((location) => postCritical(`/api/v1/caregiver/jobs/${id}/arrive`, { location }))}
          className={bigButton}
        >
          {busy ? th.common.loading : th.caregiver.step_arrive}
        </button>
      )}

      {status === 'at_destination' && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-bold">{th.caregiver.step_health}</h2>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm">{th.caregiver.hr_bp}</span>
              <input value={bp} onChange={(event) => setBp(event.target.value)} className={inputClass} placeholder="120/80" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{th.caregiver.hr_pulse}</span>
              <input value={pulse} onChange={(event) => setPulse(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{th.caregiver.hr_temp}</span>
              <input value={temp} onChange={(event) => setTemp(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.caregiver.hr_doctor_summary}</span>
            <textarea
              value={doctorSummary}
              onChange={(event) => setDoctorSummary(event.target.value)}
              rows={3}
              className={inputClass}
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <span className="font-medium">{th.caregiver.hr_meds}</span>
            {meds.map((med, index) => (
              <div key={index} className="grid grid-cols-2 gap-2">
                <input
                  placeholder={th.caregiver.hr_med_name}
                  value={med.name}
                  onChange={(event) => {
                    const next = [...meds]
                    next[index] = { ...next[index], name: event.target.value }
                    setMeds(next)
                  }}
                  className={inputClass}
                />
                <input
                  placeholder={th.caregiver.hr_med_note}
                  value={med.note}
                  onChange={(event) => {
                    const next = [...meds]
                    next[index] = { ...next[index], note: event.target.value }
                    setMeds(next)
                  }}
                  className={inputClass}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => setMeds([...meds, { name: '', note: '' }])}
              className="self-start rounded-lg border border-amber-600 px-3 py-2 text-sm font-medium text-amber-700"
            >
              {th.caregiver.hr_add_med}
            </button>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.caregiver.hr_next_appointment}</span>
              <input type="date" value={nextDate} onChange={(event) => setNextDate(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.caregiver.hr_next_department}</span>
              <input value={nextDept} onChange={(event) => setNextDept(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-gray-300 text-gray-600">
            📎 {th.caregiver.hr_attach} {attachments.length > 0 && `(${attachments.length})`}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (file) setAttachments([...attachments, await fileToPhoto(file)])
              }}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={saveHealth}
            className="min-h-14 rounded-xl border-2 border-amber-600 text-lg font-bold text-amber-700 disabled:opacity-50"
          >
            {busy ? th.common.loading : th.caregiver.step_health}
          </button>
          <button
            type="button"
            disabled={busy || !healthSaved}
            onClick={() => runStep((location) => postCritical(`/api/v1/caregiver/jobs/${id}/departing`, { location }))}
            className={bigButton}
          >
            {busy ? th.common.loading : th.caregiver.step_departing}
          </button>
        </section>
      )}

      {status === 'returning' && (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">{th.caregiver.step_checkout_hint}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => runStep((location) => postCritical(`/api/v1/caregiver/jobs/${id}/checkout`, { location }))}
            className={bigButton}
          >
            {busy ? th.common.loading : th.caregiver.step_checkout}
          </button>
        </section>
      )}

      {(status === 'pending_confirmation' || status === 'completed') && (
        <p className="rounded-xl bg-green-50 p-6 text-center text-lg font-semibold text-green-700">
          {th.caregiver.step_done}
        </p>
      )}
    </main>
  )
}
