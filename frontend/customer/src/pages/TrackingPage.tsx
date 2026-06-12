import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { th } from '@shared/i18n/th'
import { trackApi } from '@shared/api/care'
import type { BookingEvent, TrackMessage } from '@shared/api/types'
import { useAuthStore } from '../stores/auth'

const EVENT_LABEL: Record<string, string> = {
  created: th.booking.event_created,
  paid: th.booking.event_paid,
  matched: th.booking.event_matched,
  accepted: th.booking.event_accepted,
  checkin_home: th.booking.event_checkin_home,
  arrived_destination: th.booking.event_arrived_destination,
  service_note_added: th.booking.event_service_note_added,
  departing: th.booking.event_departing,
  checkout_home: th.booking.event_checkout_home,
  customer_confirmed: th.booking.event_customer_confirmed,
  completed: th.booking.event_completed,
  cancelled: th.booking.event_cancelled,
  sos: th.booking.event_sos,
  geofence_alert: th.booking.event_geofence_alert,
}

const caregiverIcon = L.divIcon({
  className: '',
  html: '<div style="font-size:28px;line-height:28px">🚗</div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

export default function TrackingPage() {
  const { id } = useParams()
  const queryClient = useQueryClient()
  const accessToken = useAuthStore((state) => state.accessToken)
  const snapshot = useQuery({ queryKey: ['track', id], queryFn: () => trackApi.snapshot(id!) })

  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const mapNodeRef = useRef<HTMLDivElement | null>(null)
  const [liveEvents, setLiveEvents] = useState<BookingEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const booking = snapshot.data?.booking

  // map init + static markers
  useEffect(() => {
    if (!mapNodeRef.current || mapRef.current || !booking) return
    const center = snapshot.data?.last_location || booking.pickup_location || { lat: 13.7563, lng: 100.5018 }
    const map = L.map(mapNodeRef.current).setView([center.lat, center.lng], 13)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)
    if (booking.pickup_location) {
      L.marker([booking.pickup_location.lat, booking.pickup_location.lng])
        .addTo(map)
        .bindPopup('🏠')
    }
    if (booking.destination_location) {
      L.marker([booking.destination_location.lat, booking.destination_location.lng])
        .addTo(map)
        .bindPopup(`🏥 ${booking.destination_name}`)
    }
    if (snapshot.data?.last_location) {
      markerRef.current = L.marker(
        [snapshot.data.last_location.lat, snapshot.data.last_location.lng],
        { icon: caregiverIcon },
      ).addTo(map)
    }
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.id, snapshot.data?.last_location === undefined])

  // live WS with auto-reconnect
  useEffect(() => {
    if (!id || !accessToken || !booking) return
    if (['completed', 'cancelled'].includes(booking.status)) return
    let socket: WebSocket | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    function connect() {
      socket = new WebSocket(trackApi.wsUrl(id!, accessToken!))
      socket.onopen = () => setConnected(true)
      socket.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 3000)
      }
      socket.onmessage = (messageEvent) => {
        const message = JSON.parse(messageEvent.data) as TrackMessage
        if (message.type === 'location' && mapRef.current) {
          const position: [number, number] = [message.lat, message.lng]
          if (!markerRef.current) {
            markerRef.current = L.marker(position, { icon: caregiverIcon }).addTo(mapRef.current)
          } else {
            markerRef.current.setLatLng(position)
          }
          mapRef.current.panTo(position)
        } else if (message.type === 'event') {
          setLiveEvents((current) => [
            ...current,
            {
              id: `live-${current.length}`,
              event_type: message.event_type,
              actor: message.actor,
              lat: null,
              lng: null,
              payload: message.payload,
              created_at: message.created_at,
            },
          ])
        } else if (message.type === 'status') {
          queryClient.invalidateQueries({ queryKey: ['track', id] })
        }
      }
    }
    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, accessToken, booking?.status])

  async function confirmComplete() {
    setConfirming(true)
    try {
      await trackApi.confirmComplete(id!)
      await queryClient.invalidateQueries({ queryKey: ['track', id] })
      await queryClient.invalidateQueries({ queryKey: ['bookings'] })
    } finally {
      setConfirming(false)
    }
  }

  const events = [...(snapshot.data?.events ?? []), ...liveEvents]

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col">
      <header className="flex items-center justify-between p-4">
        <div>
          <Link to="/bookings" className="text-sm text-gray-500 underline">
            ← {th.booking.my_bookings}
          </Link>
          <h1 className="text-lg font-bold text-teal-700">{th.booking.track_title}</h1>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {connected ? th.booking.live_connected : th.booking.live_disconnected}
        </span>
      </header>

      <div ref={mapNodeRef} className="h-72 w-full" />

      {booking?.status === 'pending_confirmation' && (
        <div className="m-4 rounded-xl bg-teal-50 p-4">
          <p className="text-sm text-gray-700">{th.booking.confirm_complete_note}</p>
          <button
            type="button"
            disabled={confirming}
            onClick={confirmComplete}
            className="mt-3 min-h-14 w-full rounded-xl bg-teal-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {confirming ? th.common.loading : th.booking.confirm_complete}
          </button>
        </div>
      )}
      {booking?.status === 'completed' && (
        <p className="m-4 rounded-xl bg-green-50 p-4 text-center font-semibold text-green-700">
          {th.booking.completed_thanks}
        </p>
      )}

      <section className="flex flex-col gap-2 p-4">
        <h2 className="font-bold text-gray-700">{th.booking.timeline_title}</h2>
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.id} className="flex items-start gap-3 rounded-lg border border-gray-100 p-3">
              <span className="text-sm font-mono text-gray-400">{timeOf(event.created_at)}</span>
              <div>
                <p className="font-medium">{EVENT_LABEL[event.event_type] ?? event.event_type}</p>
                {typeof event.payload?.photo_url === 'string' && (
                  <img src={event.payload.photo_url} alt="" className="mt-2 max-h-40 rounded-lg" />
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
