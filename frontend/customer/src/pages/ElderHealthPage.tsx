import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { eldersApi, healthApi } from '@shared/api/care'

export default function ElderHealthPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const elder = useQuery({ queryKey: ['elder', id], queryFn: () => eldersApi.get(id!) })
  const records = useQuery({ queryKey: ['health-records', id], queryFn: () => healthApi.records(id!) })

  const upcoming = records.data?.find(
    (record) => record.next_appointment && record.next_appointment.date >= new Date().toISOString().slice(0, 10),
  )

  function bookForAppointment() {
    if (!upcoming?.next_appointment) return
    const params = new URLSearchParams({
      elder: id!,
      date: upcoming.next_appointment.date,
      destination: upcoming.destination_name || '',
      detail: [upcoming.next_appointment.department, upcoming.next_appointment.note].filter(Boolean).join(' '),
    })
    navigate(`/book?${params.toString()}`)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4 print:max-w-none">
      <header className="flex items-center justify-between print:hidden">
        <div>
          <Link to="/elders" className="text-sm text-gray-500 underline">
            ← {th.customer.elders_title}
          </Link>
          <h1 className="text-xl font-bold text-teal-700">
            {th.health.title} — {elder.data?.nickname || elder.data?.full_name}
          </h1>
        </div>
        <button type="button" onClick={() => window.print()} className="text-sm text-teal-700 underline">
          {th.health.print}
        </button>
      </header>
      <h1 className="hidden text-xl font-bold print:block">
        {th.health.title} — {elder.data?.full_name}
      </h1>

      {upcoming?.next_appointment && (
        <section className="rounded-xl bg-teal-50 p-4 print:hidden">
          <p className="font-semibold text-teal-900">
            {th.health.next_appointment}: {upcoming.next_appointment.date}
            {upcoming.next_appointment.department && ` · ${upcoming.next_appointment.department}`}
          </p>
          {upcoming.destination_name && <p className="text-sm text-gray-600">{upcoming.destination_name}</p>}
          <button
            type="button"
            onClick={bookForAppointment}
            className="mt-3 min-h-12 w-full rounded-xl bg-teal-600 font-semibold text-white"
          >
            {th.health.book_for_appointment}
          </button>
        </section>
      )}

      {records.isLoading && <p className="text-gray-500">{th.common.loading}</p>}
      {records.data?.length === 0 && (
        <p className="rounded-xl bg-gray-50 p-6 text-center text-gray-500">{th.health.empty}</p>
      )}

      <ul className="flex flex-col gap-4">
        {records.data?.map((record) => (
          <li key={record.id} className="rounded-xl border border-gray-200 p-4">
            <p className="font-semibold">
              {record.service_date} · {record.destination_name}
            </p>
            {(record.vital_signs.bp || record.vital_signs.pulse || record.vital_signs.temp) && (
              <p className="mt-1 text-sm text-gray-600">
                {th.health.vitals}:
                {record.vital_signs.bp && ` ${th.caregiver.hr_bp} ${record.vital_signs.bp}`}
                {record.vital_signs.pulse && ` · ${th.caregiver.hr_pulse} ${record.vital_signs.pulse}`}
                {record.vital_signs.temp && ` · ${th.caregiver.hr_temp} ${record.vital_signs.temp}`}
              </p>
            )}
            {record.doctor_summary && (
              <p className="mt-2 rounded-lg bg-blue-50 p-3 text-sm">
                <strong>{th.health.doctor_said}:</strong> {record.doctor_summary}
              </p>
            )}
            {record.medications_received.length > 0 && (
              <div className="mt-2 text-sm">
                <strong>{th.health.meds_received}:</strong>
                <ul className="ml-4 list-disc">
                  {record.medications_received.map((med, index) => (
                    <li key={index}>
                      {med.name}
                      {med.note && ` — ${med.note}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {record.next_appointment && (
              <p className="mt-2 text-sm text-teal-800">
                📅 {th.health.next_appointment}: {record.next_appointment.date}
                {record.next_appointment.department && ` · ${record.next_appointment.department}`}
              </p>
            )}
            {record.attachments.length > 0 && (
              <div className="mt-2 flex gap-2 print:hidden">
                {record.attachments.map((url, index) => (
                  <a key={index} href={url} target="_blank" rel="noreferrer">
                    <img src={url} alt={th.health.attachments} className="h-20 rounded-lg border border-gray-200" />
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
