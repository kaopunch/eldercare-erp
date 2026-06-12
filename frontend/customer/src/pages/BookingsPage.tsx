import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { bookingsApi, bookingConfirmApi } from '@shared/api/care'
import type { Booking, BookingStatus, CancelPreview } from '@shared/api/types'

const STATUS_LABEL: Record<BookingStatus, string> = {
  draft: th.booking.status_pending_payment,
  pending_payment: th.booking.status_pending_payment,
  searching: th.booking.status_searching,
  matched: th.booking.status_matched,
  confirmed: th.booking.status_confirmed,
  in_progress_pickup: th.booking.status_in_progress_pickup,
  at_destination: th.booking.status_at_destination,
  returning: th.booking.status_returning,
  pending_confirmation: th.booking.status_pending_confirmation,
  completed: th.booking.status_completed,
  cancelled: th.booking.status_cancelled,
  disputed: th.booking.status_disputed,
}

const STATUS_COLOR: Partial<Record<BookingStatus, string>> = {
  pending_payment: 'bg-amber-100 text-amber-800',
  searching: 'bg-blue-100 text-blue-800',
  matched: 'bg-teal-100 text-teal-800',
  confirmed: 'bg-teal-100 text-teal-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-200 text-gray-600',
}

const SERVICE_LABEL: Record<string, string> = {
  hospital_visit: th.booking.svc_hospital_visit,
  errand: th.booking.svc_errand,
  companion: th.booking.svc_companion,
}

const CANCELLABLE: BookingStatus[] = ['pending_payment', 'searching', 'matched', 'confirmed']

function baht(satang: number | null): string {
  return satang === null ? '-' : (satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

function CancelDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const queryClient = useQueryClient()
  const preview = useQuery<CancelPreview>({
    queryKey: ['cancel-preview', booking.id],
    queryFn: () => bookingsApi.cancelPreview(booking.id),
  })
  const [reason, setReason] = useState('')
  const cancelMutation = useMutation({
    mutationFn: () => bookingsApi.cancel(booking.id, reason || undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bookings'] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5">
        <h2 className="text-lg font-bold">{th.booking.cancel_booking}</h2>
        {preview.data && preview.data.paid && (
          <p className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-800">
            {th.booking.cancel_refund_preview}: <strong>{baht(preview.data.refund_satang)} {th.booking.baht}</strong>{' '}
            ({preview.data.refund_pct}%)
          </p>
        )}
        <label className="mt-3 flex flex-col gap-1">
          <span className="font-medium">
            {th.booking.cancel_reason} {th.common.optional}
          </span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="rounded-xl border border-gray-300 p-3" />
        </label>
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={onClose} className="min-h-12 flex-1 rounded-xl border border-gray-300 font-medium">
            {th.common.back}
          </button>
          <button
            type="button"
            disabled={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
            className="min-h-12 flex-1 rounded-xl bg-red-600 font-semibold text-white disabled:opacity-50"
          >
            {cancelMutation.isPending ? th.common.loading : th.booking.cancel_confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function BookingsPage() {
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming')
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null)
  const queryClient = useQueryClient()
  const bookings = useQuery({
    queryKey: ['bookings', scope],
    queryFn: () => bookingsApi.list(scope),
  })
  const confirmMutation = useMutation({
    mutationFn: (id: string) => bookingConfirmApi.confirm(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bookings'] }),
  })

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-teal-700">{th.booking.my_bookings}</h1>
        <Link to="/elders" className="text-sm text-gray-500 underline">
          {th.customer.elders_title}
        </Link>
      </header>

      <div className="flex rounded-xl bg-gray-100 p-1">
        {(['upcoming', 'past'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setScope(tab)}
            className={`min-h-10 flex-1 rounded-lg font-medium ${scope === tab ? 'bg-white shadow' : 'text-gray-500'}`}
          >
            {tab === 'upcoming' ? th.booking.upcoming : th.booking.past}
          </button>
        ))}
      </div>

      {bookings.isLoading && <p className="text-gray-500">{th.common.loading}</p>}
      {bookings.data?.length === 0 && (
        <p className="rounded-xl bg-teal-50 p-6 text-center text-gray-600">{th.booking.empty}</p>
      )}

      <ul className="flex flex-col gap-3">
        {bookings.data?.map((booking) => (
          <li key={booking.id} className="rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{SERVICE_LABEL[booking.service_type]}</p>
                <p className="text-sm text-gray-600">
                  {booking.scheduled_date} · {booking.pickup_time.slice(0, 5)} น.
                </p>
                <p className="text-sm text-gray-600">→ {booking.destination_name}</p>
                <p className="mt-1 font-medium text-teal-700">
                  {baht(booking.price_total_satang)} {th.booking.baht}
                </p>
              </div>
              <span className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLOR[booking.status] ?? 'bg-gray-100 text-gray-700'}`}>
                {STATUS_LABEL[booking.status]}
              </span>
            </div>
            {booking.caregiver && (
              <div className="mt-2 rounded-lg bg-teal-50 p-3">
                <p className="text-sm font-medium text-teal-900">
                  {th.booking.your_caregiver}: {booking.caregiver.full_name}
                  {booking.caregiver.verified_badge && ' ✓'}
                </p>
                <p className="text-sm text-teal-800">
                  ★ {booking.caregiver.rating_avg.toFixed(1)} · {booking.caregiver.jobs_completed}{' '}
                  {th.booking.jobs_done}
                  {booking.caregiver.phone && ` · ${booking.caregiver.phone}`}
                </p>
                {booking.status === 'matched' && (
                  <>
                    <button
                      type="button"
                      disabled={confirmMutation.isPending}
                      onClick={() => confirmMutation.mutate(booking.id)}
                      className="mt-2 min-h-12 w-full rounded-xl bg-teal-600 font-semibold text-white disabled:opacity-50"
                    >
                      {th.booking.confirm_caregiver}
                    </button>
                    <p className="mt-1 text-xs text-gray-500">{th.booking.auto_confirm_note}</p>
                  </>
                )}
              </div>
            )}
            {booking.status === 'searching' && booking.search_timed_out && (
              <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                {th.booking.search_timeout_note}
              </p>
            )}
            {booking.status === 'cancelled' && booking.refund_pct !== null && (
              <p className="mt-2 text-sm text-gray-500">
                {th.booking.refund_done} {booking.refund_pct}%
              </p>
            )}
            {CANCELLABLE.includes(booking.status) && (
              <button
                type="button"
                onClick={() => setCancelTarget(booking)}
                className="mt-3 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600"
              >
                {th.booking.cancel_booking}
              </button>
            )}
          </li>
        ))}
      </ul>

      <Link
        to="/book"
        className="mt-2 flex min-h-14 items-center justify-center rounded-xl bg-teal-600 text-lg font-semibold text-white"
      >
        + {th.booking.book_title}
      </Link>

      {cancelTarget && <CancelDialog booking={cancelTarget} onClose={() => setCancelTarget(null)} />}
    </main>
  )
}
