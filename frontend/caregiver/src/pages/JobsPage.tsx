import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { jobsApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import type { BookingStatus, JobOffer } from '@shared/api/types'
import CaregiverNav from '../components/CaregiverNav'

const SERVICE_LABEL: Record<string, string> = {
  hospital_visit: th.booking.svc_hospital_visit,
  errand: th.booking.svc_errand,
  companion: th.booking.svc_companion,
}

const STATUS_LABEL: Partial<Record<BookingStatus, string>> = {
  matched: th.booking.status_matched,
  confirmed: th.booking.status_confirmed,
  in_progress_pickup: th.booking.status_in_progress_pickup,
  at_destination: th.booking.status_at_destination,
  returning: th.booking.status_returning,
  pending_confirmation: th.booking.status_pending_confirmation,
}

function baht(satang: number | null): string {
  return satang === null ? '-' : (satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 0 })
}

function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState('')
  useEffect(() => {
    const tick = () => {
      const ms = new Date(until).getTime() - Date.now()
      if (ms <= 0) {
        setLeft('0:00')
        return
      }
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.floor((ms % 60000) / 1000)
      setLeft(`${minutes}:${String(seconds).padStart(2, '0')}`)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [until])
  return <span className="font-mono font-semibold text-red-600">{left}</span>
}

export default function JobsPage() {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [acceptedNote, setAcceptedNote] = useState(false)

  const offers = useQuery({
    queryKey: ['job-offers'],
    queryFn: jobsApi.offers,
    refetchInterval: 30000, // poll: new batches advance lazily server-side
  })
  const active = useQuery({ queryKey: ['active-jobs'], queryFn: jobsApi.active })

  const acceptMutation = useMutation({
    mutationFn: (bookingId: string) => jobsApi.accept(bookingId),
    onSuccess: async () => {
      setAcceptedNote(true)
      setTimeout(() => setAcceptedNote(false), 2500)
      await queryClient.invalidateQueries({ queryKey: ['job-offers'] })
      await queryClient.invalidateQueries({ queryKey: ['active-jobs'] })
    },
    onError: async (err) => {
      setError((err as unknown as ApiError).message || th.common.error_generic)
      await queryClient.invalidateQueries({ queryKey: ['job-offers'] })
    },
  })

  function accept(offer: JobOffer) {
    setError(null)
    if (window.confirm(th.caregiver.accept_confirm)) {
      acceptMutation.mutate(offer.booking_id)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4 pb-24">
      <h1 className="text-xl font-bold text-amber-700">{th.caregiver.jobs_title}</h1>
      {acceptedNote && <p className="rounded-lg bg-green-50 p-3 text-green-700">{th.caregiver.accepted_ok}</p>}
      {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}

      {offers.data?.length === 0 && (
        <p className="rounded-xl bg-amber-50 p-5 text-center text-gray-600">{th.caregiver.no_offers}</p>
      )}

      <ul className="flex flex-col gap-3">
        {offers.data?.map((offer) => (
          <li key={offer.booking_id} className="rounded-xl border-2 border-amber-200 p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <p className="text-lg font-semibold">{SERVICE_LABEL[offer.service_type]}</p>
              <Countdown until={offer.expires_at} />
            </div>
            <p className="text-gray-700">
              {offer.scheduled_date} · {offer.pickup_time.slice(0, 5)} น. ·{' '}
              {offer.duration_type === 'half_day' ? th.booking.half_day : th.booking.full_day}
            </p>
            <p className="text-gray-700">→ {offer.destination_name}</p>
            <div className="mt-1 flex flex-wrap gap-2 text-sm text-gray-500">
              {offer.distance_km !== null && (
                <span>
                  {th.caregiver.offer_distance} {offer.distance_km} {th.booking.km}
                </span>
              )}
              {offer.special_requirements.wheelchair && <span>♿ {th.booking.req_wheelchair}</span>}
              {offer.special_requirements.english && <span>EN</span>}
            </div>
            <p className="mt-2 text-xl font-bold text-amber-700">
              {th.caregiver.offer_payout} {baht(offer.payout_satang)} {th.booking.baht}
            </p>
            <button
              type="button"
              disabled={acceptMutation.isPending}
              onClick={() => accept(offer)}
              className="mt-3 min-h-14 w-full rounded-xl bg-amber-600 text-lg font-bold text-white disabled:opacity-50"
            >
              {acceptMutation.isPending ? th.common.loading : th.caregiver.accept_job}
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mt-2 text-lg font-bold text-gray-700">{th.caregiver.my_jobs}</h2>
      {active.data?.length === 0 && <p className="text-gray-500">{th.caregiver.no_active_jobs}</p>}
      <ul className="flex flex-col gap-3">
        {active.data?.map((job) => (
          <li key={job.id} className="rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between">
              <p className="font-semibold">{SERVICE_LABEL[job.service_type]}</p>
              <span className="rounded-full bg-teal-100 px-3 py-1 text-sm font-medium text-teal-800">
                {STATUS_LABEL[job.status] ?? job.status}
              </span>
            </div>
            <p className="text-sm text-gray-600">
              {job.scheduled_date} · {job.pickup_time.slice(0, 5)} น.
            </p>
            <p className="text-sm text-gray-600">{job.pickup_address}</p>
            <p className="text-sm text-gray-600">→ {job.destination_name}</p>
            {job.appointment_detail && <p className="mt-1 text-sm text-gray-500">{job.appointment_detail}</p>}
            <p className="mt-1 font-medium text-amber-700">
              {baht(job.payout_satang)} {th.booking.baht}
            </p>
            <Link
              to={`/jobs/${job.id}/active`}
              className="mt-3 flex min-h-12 items-center justify-center rounded-xl bg-amber-600 font-semibold text-white"
            >
              {th.caregiver.open_active_job}
            </Link>
          </li>
        ))}
      </ul>

      <CaregiverNav active="jobs" />
    </main>
  )
}
