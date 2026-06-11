import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { eldersApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import type { ElderInput, LatLng, Medication, Mobility } from '@shared/api/types'

const STEPS = [th.customer.elder_step1, th.customer.elder_step2, th.customer.elder_step3]

const MOBILITY_OPTIONS: { value: Mobility; label: string }[] = [
  { value: 'walk', label: th.customer.mobility_walk },
  { value: 'cane', label: th.customer.mobility_cane },
  { value: 'walker', label: th.customer.mobility_walker },
  { value: 'wheelchair', label: th.customer.mobility_wheelchair },
  { value: 'bedridden', label: th.customer.mobility_bedridden },
]

const inputClass = 'rounded-xl border border-gray-300 p-3 text-base'

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export default function ElderFormPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = Boolean(id)
  const existing = useQuery({
    queryKey: ['elder', id],
    queryFn: () => eldersApi.get(id!),
    enabled: isEdit,
  })

  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // step 1
  const [fullName, setFullName] = useState('')
  const [nickname, setNickname] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [gender, setGender] = useState('')
  // step 2
  const [bloodType, setBloodType] = useState('')
  const [weight, setWeight] = useState('')
  const [height, setHeight] = useState('')
  const [chronic, setChronic] = useState('')
  const [allergies, setAllergies] = useState('')
  const [medications, setMedications] = useState<Medication[]>([])
  // step 3
  const [mobility, setMobility] = useState<Mobility | ''>('')
  const [hospital, setHospital] = useState('')
  const [address, setAddress] = useState('')
  const [location, setLocation] = useState<LatLng | null>(null)
  const [notes, setNotes] = useState('')
  const [consent, setConsent] = useState(false)

  useEffect(() => {
    const elder = existing.data
    if (!elder) return
    setFullName(elder.full_name)
    setNickname(elder.nickname ?? '')
    setBirthDate(elder.birth_date ?? '')
    setGender(elder.gender ?? '')
    setBloodType(elder.blood_type ?? '')
    setWeight(elder.weight_kg?.toString() ?? '')
    setHeight(elder.height_cm?.toString() ?? '')
    setChronic(elder.chronic_conditions.join(', '))
    setAllergies(elder.allergies.join(', '))
    setMedications(elder.medications)
    setMobility(elder.mobility ?? '')
    setHospital(elder.primary_hospital ?? '')
    setAddress(elder.home_address ?? '')
    setLocation(elder.home_location)
    setNotes(elder.special_notes ?? '')
  }, [existing.data])

  function useCurrentLocation() {
    navigator.geolocation?.getCurrentPosition(
      (position) => setLocation({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setError(th.common.error_generic),
    )
  }

  async function submit() {
    setBusy(true)
    setError(null)
    const payload: ElderInput = {
      full_name: fullName,
      nickname: nickname || null,
      birth_date: birthDate || null,
      gender: (gender || null) as ElderInput['gender'],
      blood_type: bloodType || null,
      weight_kg: weight ? Number(weight) : null,
      height_cm: height ? Number(height) : null,
      chronic_conditions: splitCsv(chronic),
      allergies: splitCsv(allergies),
      medications: medications.filter((med) => med.name.trim()),
      mobility: (mobility || null) as ElderInput['mobility'],
      primary_hospital: hospital || null,
      home_address: address || null,
      home_location: location,
      special_notes: notes || null,
    }
    try {
      if (isEdit) {
        await eldersApi.update(id!, payload)
      } else {
        await eldersApi.create({ ...payload, consent_accepted: consent })
      }
      navigate('/elders')
    } catch (err) {
      setError((err as ApiError).message || th.common.error_generic)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header>
        <h1 className="text-xl font-bold text-teal-700">
          {isEdit ? th.common.edit : th.customer.add_elder}
        </h1>
        <p className="text-sm text-gray-500">
          {th.common.step} {step + 1}/3 — {STEPS[step]}
        </p>
        <div className="mt-2 flex gap-1">
          {STEPS.map((label, index) => (
            <div
              key={label}
              className={`h-1.5 flex-1 rounded ${index <= step ? 'bg-teal-600' : 'bg-gray-200'}`}
            />
          ))}
        </div>
      </header>

      {step === 0 && (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.full_name}</span>
            <input required value={fullName} onChange={(event) => setFullName(event.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.nickname} {th.common.optional}</span>
            <input value={nickname} onChange={(event) => setNickname(event.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.birth_date} {th.common.optional}</span>
            <input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.gender} {th.common.optional}</span>
            <select value={gender} onChange={(event) => setGender(event.target.value)} className={inputClass}>
              <option value="">—</option>
              <option value="male">{th.customer.gender_male}</option>
              <option value="female">{th.customer.gender_female}</option>
              <option value="other">{th.customer.gender_other}</option>
            </select>
          </label>
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{th.customer.blood_type}</span>
              <input value={bloodType} onChange={(event) => setBloodType(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{th.customer.weight_kg}</span>
              <input type="number" value={weight} onChange={(event) => setWeight(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">{th.customer.height_cm}</span>
              <input type="number" value={height} onChange={(event) => setHeight(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.chronic_conditions}</span>
            <input
              value={chronic}
              onChange={(event) => setChronic(event.target.value)}
              placeholder={th.customer.chronic_placeholder}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.allergies}</span>
            <input
              value={allergies}
              onChange={(event) => setAllergies(event.target.value)}
              placeholder={th.customer.allergies_placeholder}
              className={inputClass}
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <span className="font-medium">{th.customer.medications}</span>
            {medications.map((med, index) => (
              <div key={index} className="grid grid-cols-3 gap-2">
                <input
                  placeholder={th.customer.med_name}
                  value={med.name}
                  onChange={(event) => {
                    const next = [...medications]
                    next[index] = { ...next[index], name: event.target.value }
                    setMedications(next)
                  }}
                  className={inputClass}
                />
                <input
                  placeholder={th.customer.med_dose}
                  value={med.dose ?? ''}
                  onChange={(event) => {
                    const next = [...medications]
                    next[index] = { ...next[index], dose: event.target.value }
                    setMedications(next)
                  }}
                  className={inputClass}
                />
                <input
                  placeholder={th.customer.med_schedule}
                  value={med.schedule ?? ''}
                  onChange={(event) => {
                    const next = [...medications]
                    next[index] = { ...next[index], schedule: event.target.value }
                    setMedications(next)
                  }}
                  className={inputClass}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => setMedications([...medications, { name: '' }])}
              className="self-start rounded-lg border border-teal-600 px-3 py-2 text-sm font-medium text-teal-700"
            >
              {th.customer.add_medication}
            </button>
          </fieldset>
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.mobility}</span>
            <select
              value={mobility}
              onChange={(event) => setMobility(event.target.value as Mobility | '')}
              className={inputClass}
            >
              <option value="">—</option>
              {MOBILITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.primary_hospital}</span>
            <input value={hospital} onChange={(event) => setHospital(event.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.home_address}</span>
            <textarea value={address} onChange={(event) => setAddress(event.target.value)} rows={2} className={inputClass} />
          </label>
          <div className="flex flex-col gap-2">
            <span className="font-medium">{th.customer.home_location}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={useCurrentLocation}
                className="rounded-lg border border-teal-600 px-3 py-2 text-sm font-medium text-teal-700"
              >
                {th.customer.use_current_location}
              </button>
              <span className={location ? 'text-teal-700' : 'text-gray-400'}>
                {location
                  ? `${th.customer.location_set} (${location.lat.toFixed(5)}, ${location.lng.toFixed(5)})`
                  : th.customer.location_unset}
              </span>
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.customer.special_notes}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={th.customer.special_notes_placeholder}
              rows={2}
              className={inputClass}
            />
          </label>
          {!isEdit && (
            <div className="rounded-xl bg-teal-50 p-4">
              <p className="font-semibold">{th.customer.consent_title}</p>
              <p className="mt-1 text-sm text-gray-600">{th.customer.consent_text}</p>
              <label className="mt-3 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  className="h-5 w-5"
                />
                <span className="font-medium">{th.customer.consent_accept}</span>
              </label>
            </div>
          )}
        </section>
      )}

      {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}

      <footer className="mt-auto flex gap-3 pb-4">
        <button
          type="button"
          onClick={() => (step === 0 ? navigate('/elders') : setStep(step - 1))}
          className="min-h-14 flex-1 rounded-xl border border-gray-300 text-lg font-medium"
        >
          {step === 0 ? th.common.cancel : th.common.back}
        </button>
        {step < 2 ? (
          <button
            type="button"
            disabled={step === 0 && !fullName.trim()}
            onClick={() => setStep(step + 1)}
            className="min-h-14 flex-1 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {th.common.next}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || (!isEdit && !consent) || !fullName.trim()}
            onClick={submit}
            className="min-h-14 flex-1 rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {busy ? th.common.loading : th.common.save}
          </button>
        )}
      </footer>
    </main>
  )
}
