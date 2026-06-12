import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { bookingsApi, eldersApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import type {
  Booking,
  DurationType,
  LatLng,
  Quote,
  ServiceType,
  SpecialRequirements,
} from '@shared/api/types'

const STEPS = [th.booking.step1, th.booking.step2, th.booking.step3, th.booking.step4]

const SERVICE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: 'hospital_visit', label: th.booking.svc_hospital_visit },
  { value: 'errand', label: th.booking.svc_errand },
  { value: 'companion', label: th.booking.svc_companion },
]

const inputClass = 'rounded-xl border border-gray-300 p-3 text-base'

function baht(satang: number): string {
  return (satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

export default function BookPage() {
  const navigate = useNavigate()
  const elders = useQuery({ queryKey: ['elders'], queryFn: eldersApi.list })

  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // step 1
  const [elderId, setElderId] = useState('')
  const [serviceType, setServiceType] = useState<ServiceType>('hospital_visit')
  const [duration, setDuration] = useState<DurationType>('half_day')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('09:00')
  const [destName, setDestName] = useState('')
  const [destPin, setDestPin] = useState<LatLng | null>(null)
  const [appointment, setAppointment] = useState('')
  // step 2
  const [wheelchair, setWheelchair] = useState(false)
  const [english, setEnglish] = useState(false)
  const [gender, setGender] = useState('')
  // step 3-4
  const [quote, setQuote] = useState<Quote | null>(null)
  const [booking, setBooking] = useState<Booking | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [paidOk, setPaidOk] = useState(false)

  const requirements: SpecialRequirements = useMemo(
    () => ({
      wheelchair,
      english,
      caregiver_gender: (gender || null) as SpecialRequirements['caregiver_gender'],
    }),
    [wheelchair, english, gender],
  )

  function useDestinationHere() {
    navigator.geolocation?.getCurrentPosition(
      (position) => setDestPin({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setError(th.common.error_generic),
    )
  }

  async function fetchQuote() {
    setBusy(true)
    setError(null)
    try {
      const elder = await eldersApi.get(elderId)
      const pickup = elder.home_location
      if (!pickup) {
        setError(th.customer.location_unset + ' — ' + th.customer.home_location)
        setBusy(false)
        return
      }
      const result = await bookingsApi.quote({
        service_type: serviceType,
        duration_type: duration,
        pickup,
        destination: destPin!,
        special_requirements: requirements,
      })
      setQuote(result)
      setStep(2)
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function createBooking() {
    setBusy(true)
    setError(null)
    try {
      const result = await bookingsApi.create({
        elder_profile_id: elderId,
        service_type: serviceType,
        duration_type: duration,
        scheduled_date: date,
        pickup_time: time,
        destination_name: destName,
        destination_location: destPin!,
        appointment_detail: appointment || null,
        special_requirements: requirements,
      })
      setBooking(result.booking)
      setQuote(result.quote)
      setStep(3)
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  async function pay(method: 'promptpay' | 'mock') {
    if (!booking) return
    setBusy(true)
    setError(null)
    try {
      const result = await bookingsApi.pay(booking.id, { method })
      if (result.payment_status === 'held_escrow') {
        setPaidOk(true)
        setTimeout(() => navigate('/bookings'), 1800)
      } else if (result.qr_image_url) {
        setQrUrl(result.qr_image_url)
      }
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  const step1Valid = elderId && date && time && destName.trim() && destPin

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header>
        <h1 className="text-xl font-bold text-teal-700">{th.booking.book_title}</h1>
        <p className="text-sm text-gray-500">
          {th.common.step} {step + 1}/4 — {STEPS[step]}
        </p>
        <div className="mt-2 flex gap-1">
          {STEPS.map((label, index) => (
            <div key={label} className={`h-1.5 flex-1 rounded ${index <= step ? 'bg-teal-600' : 'bg-gray-200'}`} />
          ))}
        </div>
      </header>

      {step === 0 && (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.booking.select_elder}</span>
            <select required value={elderId} onChange={(event) => setElderId(event.target.value)} className={inputClass}>
              <option value="">—</option>
              {elders.data?.map((elder) => (
                <option key={elder.id} value={elder.id}>
                  {elder.full_name}
                  {elder.nickname ? ` (${elder.nickname})` : ''}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-2">
            <span className="font-medium">{th.booking.service_type}</span>
            {SERVICE_OPTIONS.map((option) => (
              <label key={option.value} className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 px-3">
                <input
                  type="radio"
                  name="service"
                  checked={serviceType === option.value}
                  onChange={() => setServiceType(option.value)}
                  className="h-5 w-5"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <fieldset className="flex flex-col gap-1">
              <span className="font-medium">{th.booking.duration}</span>
              <select value={duration} onChange={(event) => setDuration(event.target.value as DurationType)} className={inputClass}>
                <option value="half_day">{th.booking.half_day}</option>
                <option value="full_day">{th.booking.full_day}</option>
              </select>
            </fieldset>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.booking.date}</span>
              <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.booking.pickup_time}</span>
            <input type="time" required value={time} onChange={(event) => setTime(event.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.booking.destination_name}</span>
            <input
              required
              value={destName}
              onChange={(event) => setDestName(event.target.value)}
              placeholder={th.booking.destination_name_placeholder}
              className={inputClass}
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={useDestinationHere}
              className="rounded-lg border border-teal-600 px-3 py-2 text-sm font-medium text-teal-700"
            >
              {th.customer.use_current_location}
            </button>
            <span className={destPin ? 'text-teal-700' : 'text-gray-400'}>
              {destPin ? `${th.booking.destination_pin}: ${destPin.lat.toFixed(4)}, ${destPin.lng.toFixed(4)}` : th.customer.location_unset}
            </span>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">
              {th.booking.appointment_detail} {th.common.optional}
            </span>
            <textarea
              value={appointment}
              onChange={(event) => setAppointment(event.target.value)}
              placeholder={th.booking.appointment_placeholder}
              rows={2}
              className={inputClass}
            />
          </label>
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-3">
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 px-3">
            <input type="checkbox" checked={wheelchair} onChange={(event) => setWheelchair(event.target.checked)} className="h-5 w-5" />
            <span>{th.booking.req_wheelchair}</span>
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-gray-200 px-3">
            <input type="checkbox" checked={english} onChange={(event) => setEnglish(event.target.checked)} className="h-5 w-5" />
            <span>{th.booking.req_english}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.booking.req_gender}</span>
            <select value={gender} onChange={(event) => setGender(event.target.value)} className={inputClass}>
              <option value="">{th.booking.req_gender_any}</option>
              <option value="female">{th.customer.gender_female}</option>
              <option value="male">{th.customer.gender_male}</option>
            </select>
          </label>
        </section>
      )}

      {step === 2 && quote && (
        <section className="flex flex-col gap-3">
          <div className="rounded-xl border border-gray-200 p-4">
            <dl className="flex flex-col gap-2">
              <div className="flex justify-between">
                <dt>{th.booking.price_base}</dt>
                <dd>{baht(quote.breakdown.base_satang)} {th.booking.baht}</dd>
              </div>
              {quote.breakdown.distance_surcharge_satang > 0 && (
                <div className="flex justify-between">
                  <dt>
                    {th.booking.price_distance} ({quote.distance_km} {th.booking.km})
                  </dt>
                  <dd>{baht(quote.breakdown.distance_surcharge_satang)} {th.booking.baht}</dd>
                </div>
              )}
              {quote.breakdown.english_premium_satang > 0 && (
                <div className="flex justify-between">
                  <dt>{th.booking.price_english}</dt>
                  <dd>{baht(quote.breakdown.english_premium_satang)} {th.booking.baht}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt>{th.booking.price_insurance}</dt>
                <dd>{baht(quote.breakdown.insurance_fee_satang)} {th.booking.baht}</dd>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 text-lg font-bold">
                <dt>{th.booking.price_total}</dt>
                <dd className="text-teal-700">{baht(quote.price_total_satang)} {th.booking.baht}</dd>
              </div>
            </dl>
          </div>
        </section>
      )}

      {step === 3 && booking && (
        <section className="flex flex-col gap-4">
          {paidOk ? (
            <p className="rounded-xl bg-green-50 p-6 text-center text-lg font-semibold text-green-700">
              {th.booking.paid_searching}
            </p>
          ) : qrUrl ? (
            <div className="flex flex-col items-center gap-3">
              <img src={qrUrl} alt="PromptPay QR" className="w-64 rounded-xl border border-gray-200" />
              <p className="text-gray-600">{th.booking.pay_expires_note}</p>
            </div>
          ) : (
            <>
              <p className="text-center text-2xl font-bold text-teal-700">
                {baht(booking.price_total_satang ?? 0)} {th.booking.baht}
              </p>
              <p className="text-center text-sm text-gray-500">{th.booking.pay_expires_note}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => pay('promptpay')}
                className="min-h-14 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
              >
                {busy ? th.common.loading : th.booking.pay_mock}
              </button>
            </>
          )}
        </section>
      )}

      {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}

      {step < 3 && (
        <footer className="mt-auto flex gap-3 pb-4">
          <button
            type="button"
            onClick={() => (step === 0 ? navigate('/bookings') : setStep(step - 1))}
            className="min-h-14 flex-1 rounded-xl border border-gray-300 text-lg font-medium"
          >
            {step === 0 ? th.common.cancel : th.common.back}
          </button>
          {step === 0 && (
            <button
              type="button"
              disabled={!step1Valid}
              onClick={() => setStep(1)}
              className="min-h-14 flex-1 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              {th.common.next}
            </button>
          )}
          {step === 1 && (
            <button
              type="button"
              disabled={busy}
              onClick={fetchQuote}
              className="min-h-14 flex-1 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              {busy ? th.common.loading : th.common.next}
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              disabled={busy}
              onClick={createBooking}
              className="min-h-14 flex-1 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              {busy ? th.common.loading : th.booking.pay_now}
            </button>
          )}
        </footer>
      )}
    </main>
  )
}
