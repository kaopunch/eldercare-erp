import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { availabilityApi } from '@shared/api/care'
import type { AvailabilityDay } from '@shared/api/types'
import CaregiverNav from '../components/CaregiverNav'

const DAYS_SHOWN = 14
const THAI_WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']

function dateKey(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10)
}

function dayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00`)
  return `${THAI_WEEKDAYS[date.getDay()]} ${date.getDate()}/${date.getMonth() + 1}`
}

export default function AvailabilityPage() {
  const queryClient = useQueryClient()
  const saved = useQuery({
    queryKey: ['availability'],
    queryFn: () => availabilityApi.list(dateKey(0), dateKey(DAYS_SHOWN + 28)),
  })
  const [days, setDays] = useState<Record<string, { morning: boolean; afternoon: boolean }>>({})
  const [savedNote, setSavedNote] = useState(false)

  useEffect(() => {
    if (!saved.data) return
    const map: Record<string, { morning: boolean; afternoon: boolean }> = {}
    for (const row of saved.data) {
      map[row.date] = { morning: Boolean(row.slots.morning), afternoon: Boolean(row.slots.afternoon) }
    }
    setDays(map)
  }, [saved.data])

  const saveMutation = useMutation({
    mutationFn: (payload: AvailabilityDay[]) => availabilityApi.save(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['availability'] })
      setSavedNote(true)
      setTimeout(() => setSavedNote(false), 2000)
    },
  })

  function toggle(date: string, slot: 'morning' | 'afternoon') {
    setDays((current) => ({
      ...current,
      [date]: {
        morning: slot === 'morning' ? !current[date]?.morning : Boolean(current[date]?.morning),
        afternoon: slot === 'afternoon' ? !current[date]?.afternoon : Boolean(current[date]?.afternoon),
      },
    }))
  }

  function save() {
    const payload: AvailabilityDay[] = []
    for (let offset = 0; offset < DAYS_SHOWN; offset += 1) {
      const date = dateKey(offset)
      payload.push({ date, slots: days[date] ?? { morning: false, afternoon: false } })
    }
    saveMutation.mutate(payload)
  }

  /** Copy this week's pattern (next 7 days) to the following 4 weeks. */
  function repeatWeekly() {
    const next = { ...days }
    for (let week = 1; week <= 4; week += 1) {
      for (let offset = 0; offset < 7; offset += 1) {
        const source = days[dateKey(offset)] ?? { morning: false, afternoon: false }
        next[dateKey(offset + week * 7)] = { ...source }
      }
    }
    setDays(next)
    const payload: AvailabilityDay[] = Object.entries(next).map(([date, slots]) => ({ date, slots }))
    saveMutation.mutate(payload)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4 pb-24">
      <h1 className="text-xl font-bold text-amber-700">{th.caregiver.availability_title}</h1>
      {savedNote && <p className="rounded-lg bg-green-50 p-3 text-green-700">{th.caregiver.availability_saved}</p>}

      <ul className="flex flex-col gap-2">
        {Array.from({ length: DAYS_SHOWN }, (_, offset) => {
          const date = dateKey(offset)
          const slots = days[date] ?? { morning: false, afternoon: false }
          return (
            <li key={date} className="flex items-center justify-between rounded-xl border border-gray-200 p-3">
              <span className="w-20 font-medium">{dayLabel(date)}</span>
              <div className="flex gap-2">
                {(['morning', 'afternoon'] as const).map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => toggle(date, slot)}
                    className={`min-h-12 rounded-xl px-5 font-semibold ${
                      slots[slot] ? 'bg-amber-600 text-white' : 'border border-gray-300 text-gray-500'
                    }`}
                  >
                    {slot === 'morning' ? th.caregiver.slot_morning : th.caregiver.slot_afternoon}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={repeatWeekly}
        disabled={saveMutation.isPending}
        className="min-h-12 rounded-xl border border-amber-600 font-medium text-amber-700 disabled:opacity-50"
      >
        {th.caregiver.repeat_weekly}
      </button>
      <button
        type="button"
        onClick={save}
        disabled={saveMutation.isPending}
        className="min-h-14 rounded-xl bg-amber-600 text-lg font-semibold text-white disabled:opacity-50"
      >
        {saveMutation.isPending ? th.common.loading : th.common.save}
      </button>

      <CaregiverNav active="availability" />
    </main>
  )
}
