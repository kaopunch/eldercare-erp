// Offline outbox (spec M6 / CLAUDE.md: check-in/out + health record must never
// lose data on a dropped connection). Critical mutations that fail with a
// NETWORK error are queued in localStorage and replayed in order when the
// connection returns. Server steps are idempotent, so replays are safe.
import { api } from '@shared/api/client'

const STORAGE_KEY = 'care-caregiver-outbox'
const RETRY_INTERVAL_MS = 15_000

interface OutboxItem {
  id: string
  path: string
  body: unknown
  queued_at: string
}

type Listener = (count: number) => void
const listeners = new Set<Listener>()
let flushing = false

function load(): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as OutboxItem[]
  } catch {
    return []
  }
}

function save(items: OutboxItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  for (const listener of listeners) listener(items.length)
}

export function outboxCount(): number {
  return load().length
}

export function onOutboxChange(listener: Listener): () => void {
  listeners.add(listener)
  listener(outboxCount())
  return () => listeners.delete(listener)
}

function isNetworkError(error: unknown): boolean {
  // fetch rejects with TypeError on network failure; API errors have a code
  return error instanceof TypeError || (error instanceof Error && error.name === 'TypeError')
}

/**
 * POST through the outbox: on network failure the request is queued and
 * replayed later instead of being lost. API-level errors (4xx/5xx) still
 * throw — those are business errors the user must see.
 */
export async function postCritical<T>(path: string, body: unknown): Promise<T | { queued: true }> {
  try {
    return await api<T>(path, { method: 'POST', body: JSON.stringify(body) })
  } catch (error) {
    if (!isNetworkError(error)) throw error
    const items = load()
    items.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      body,
      queued_at: new Date().toISOString(),
    })
    save(items)
    return { queued: true }
  }
}

/** Replay queued items in order; stop at the first network failure. */
export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    let items = load()
    while (items.length > 0) {
      const next = items[0]
      try {
        await api(next.path, { method: 'POST', body: JSON.stringify(next.body) })
      } catch (error) {
        if (isNetworkError(error)) return // still offline — keep the queue
        // business error (e.g. step already done) — drop the item, keep going
      }
      items = load().filter((item) => item.id !== next.id)
      save(items)
    }
  } finally {
    flushing = false
  }
}

export function startOutbox(): void {
  window.addEventListener('online', () => void flushOutbox())
  setInterval(() => {
    if (navigator.onLine && outboxCount() > 0) void flushOutbox()
  }, RETRY_INTERVAL_MS)
}
