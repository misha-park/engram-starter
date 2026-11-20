import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { CalendarEvent } from '../../core/gcal'
import { TZ } from '../../core/time'

// Where the calendar is pushed: Google Calendar (REST API v3), or in the demo a JSON file
// standing in for it. Engram only ever touches the one calendar it created.

export const CALENDAR_NAME = 'Engram'
const API = 'https://www.googleapis.com/calendar/v3'

export class NotFound extends Error {}

export interface CalendarTarget {
  readonly kind: 'google' | 'file'
  /** The calendar's id: `id` if it still exists, otherwise a newly created "Engram" calendar. */
  ensureCalendar(id: string | null): Promise<string>
  /** Engram's events already in the calendar (to recover after the local record is lost). */
  listEngramEvents(calendarId: string): Promise<{ eventId: string; key: string }[]>
  insert(calendarId: string, event: CalendarEvent): Promise<string>
  update(calendarId: string, eventId: string, event: CalendarEvent): Promise<void>
  remove(calendarId: string, eventId: string): Promise<void>
  deleteCalendar(calendarId: string): Promise<void>
}

/** The body Google gets for an event. No reminders: Engram's blocks shouldn't ping the phone. */
export const googleBody = (e: CalendarEvent) => ({
  summary: e.summary,
  description: e.description,
  start: e.start,
  end: e.end,
  ...(e.colorId ? { colorId: e.colorId } : {}),
  reminders: { useDefault: false, overrides: [] },
  extendedProperties: { private: { engram: e.key } }
})

export class GoogleCalendar implements CalendarTarget {
  readonly kind = 'google' as const

  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly http: typeof fetch = fetch
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    })
    if (res.status === 404 || res.status === 410) throw new NotFound(`${method} ${path}`)
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(`Google Calendar: ${json?.error?.message ?? `error ${res.status}`}`)
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
  }

  async ensureCalendar(id: string | null): Promise<string> {
    if (id) {
      try {
        await this.call('GET', `/calendars/${encodeURIComponent(id)}`)
        return id
      } catch (e) {
        if (!(e instanceof NotFound)) throw e
      }
    }
    const created = await this.call<{ id: string }>('POST', '/calendars', {
      summary: CALENDAR_NAME,
      description: 'Your Engram planner, kept up to date by Engram. Edit in Engram, not here.',
      timeZone: TZ
    })
    return created.id
  }

  async listEngramEvents(calendarId: string): Promise<{ eventId: string; key: string }[]> {
    const out: { eventId: string; key: string }[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({
        maxResults: '2500',
        fields: 'items(id,extendedProperties),nextPageToken',
        ...(pageToken ? { pageToken } : {})
      })
      const page = await this.call<{
        items?: { id: string; extendedProperties?: { private?: { engram?: string } } }[]
        nextPageToken?: string
      }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${q}`)
      for (const item of page.items ?? []) {
        const key = item.extendedProperties?.private?.engram
        if (key) out.push({ eventId: item.id, key })
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }

  async insert(calendarId: string, event: CalendarEvent): Promise<string> {
    const r = await this.call<{ id: string }>(
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      googleBody(event)
    )
    return r.id
  }

  async update(calendarId: string, eventId: string, event: CalendarEvent): Promise<void> {
    // PUT replaces the event, so a colour that's been removed goes too.
    await this.call(
      'PUT',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      googleBody(event)
    )
  }

  async remove(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.call(
        'DELETE',
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
      )
    } catch (e) {
      if (!(e instanceof NotFound)) throw e // Already gone: fine.
    }
  }

  async deleteCalendar(calendarId: string): Promise<void> {
    try {
      await this.call('DELETE', `/calendars/${encodeURIComponent(calendarId)}`)
    } catch (e) {
      if (!(e instanceof NotFound)) throw e
    }
  }
}

interface FakeFile {
  calendarId: string | null
  events: Record<string, CalendarEvent>
}

/** The demo's Google Calendar: a JSON file in the demo profile folder. */
export class FileCalendar implements CalendarTarget {
  readonly kind = 'file' as const
  constructor(readonly file: string) {}

  private load(): FakeFile {
    return existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as FakeFile)
      : { calendarId: null, events: {} }
  }

  private save(f: FakeFile): void {
    writeFileSync(this.file, JSON.stringify(f, null, 2))
  }

  /** For Settings: how many events the demo calendar holds. */
  count(): number {
    return Object.keys(this.load().events).length
  }

  async ensureCalendar(id: string | null): Promise<string> {
    const f = this.load()
    if (id && f.calendarId === id) return id
    const fresh = { calendarId: `demo-${randomUUID()}`, events: {} }
    this.save(fresh)
    return fresh.calendarId
  }

  async listEngramEvents(): Promise<{ eventId: string; key: string }[]> {
    return Object.entries(this.load().events).map(([eventId, e]) => ({ eventId, key: e.key }))
  }

  async insert(_calendarId: string, event: CalendarEvent): Promise<string> {
    const f = this.load()
    const id = randomUUID()
    f.events[id] = event
    this.save(f)
    return id
  }

  async update(_calendarId: string, eventId: string, event: CalendarEvent): Promise<void> {
    const f = this.load()
    if (!f.events[eventId]) throw new NotFound(eventId)
    f.events[eventId] = event
    this.save(f)
  }

  async remove(_calendarId: string, eventId: string): Promise<void> {
    const f = this.load()
    delete f.events[eventId]
    this.save(f)
  }

  async deleteCalendar(): Promise<void> {
    this.save({ calendarId: null, events: {} })
  }
}
