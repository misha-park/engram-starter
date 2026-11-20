import { randomUUID } from 'crypto'
import { asc, eq } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import {
  eventsInRange,
  parseLinkedCalendar,
  type LinkedEvent,
  type ParsedCalendar
} from '../core/calendar-feed'
import { CATEGORY_COLOURS } from '../shared/palette'
import type { LinkedCalendar, LinkedEventView } from '../shared/types'
import type { Db } from './db/client'
import * as t from './db/schema'

// Linked calendars (an iCloud public calendar, say): each is a category (its toggle in the
// Calendars list) whose events are shown on the calendar for reference. They are never blocks,
// so nothing is planned around them, they don't go to Google Calendar and Claude doesn't see
// them. A calendar's link is a key to read it, so it's kept encrypted with safeStorage
// (secrets/calendars.bin), never in the database, settings, logs, results or error messages.
// Nothing is ever written back to the calendar.

export interface CalendarLink {
  /** The calendar's category id. */
  id: string
  url: string
}

export interface CalendarSecret {
  calendars: CalendarLink[]
}

/** What `EncryptedJson` offers (and what tests stand in for). */
export interface SecretStore<T> {
  has(): boolean
  get(): Promise<T | null>
  set(value: T): Promise<void>
  clear(): void
}

export type FetchText = (url: string) => Promise<string>

/** How often the links are re-read while Engram runs. */
const POLL_MINUTES = 30
/** Events from this long ago to this far ahead are read from each calendar. */
const DAYS_BACK = 14
const DAYS_AHEAD = 180
const STATUS_KEY = 'linkedCalendarStatus'
const EVENTS_KEY = 'linkedCalendarEvents'
/** Events you deleted from Engram's view, by calendar: they stay gone when the calendar is re-read. */
const HIDDEN_KEY = 'linkedCalendarHidden'

interface Status {
  lastCheckedAt: string | null
  lastError: string | null
  events: number
}

/** Tidy a pasted link: webcal:// becomes https://, and only https is accepted. */
export function normaliseCalendarUrl(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('Paste the calendar’s public link.')
  let url: URL
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, 'https://'))
  } catch {
    throw new Error('That isn’t a link. Copy the whole link from the Calendar app.')
  }
  if (url.protocol !== 'https:') throw new Error('The link must start with https:// or webcal://.')
  return url.toString()
}

/** Fetch a calendar. Errors never include the link. */
export const fetchCalendarText: FetchText = async (url) => {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  } catch {
    throw new Error('Couldn’t reach the calendar. Check your internet connection.')
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404 || res.status === 403 || res.status === 401 || res.status === 410
        ? 'The calendar didn’t accept that link. Is it still shared as a public calendar?'
        : `The calendar answered with an error (${res.status}). Try again later.`
    )
  }
  return res.text()
}

export function parseCalendarText(text: string, now: Temporal.Instant): ParsedCalendar {
  if (!/BEGIN:VCALENDAR/.test(text)) {
    throw new Error('That link doesn’t lead to a calendar. Use the calendar’s public (iCal) link.')
  }
  const day = 86_400_000
  return parseLinkedCalendar(text, {
    from: new Date(now.epochMilliseconds - DAYS_BACK * day),
    to: new Date(now.epochMilliseconds + DAYS_AHEAD * day)
  })
}

function readSetting<T>(db: Db, key: string): T | undefined {
  return db.select().from(t.settings).where(eq(t.settings.key, key)).get()?.value as T | undefined
}

function writeSetting(db: Db, key: string, value: unknown): void {
  db.insert(t.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

const readEvents = (db: Db) => readSetting<Record<string, LinkedEvent[]>>(db, EVENTS_KEY) ?? {}
const readHidden = (db: Db) => readSetting<Record<string, string[]>>(db, HIDDEN_KEY) ?? {}

/** Keep a calendar's events (what the last read found), replacing the ones before. */
export function storeEvents(db: Db, categoryId: string, events: LinkedEvent[]): void {
  writeSetting(db, EVENTS_KEY, { ...readEvents(db), [categoryId]: events })
}

/** A category for a new calendar: its own name (made unique) and the first colour not in use. */
function createCalendarCategory(db: Db, wanted: string | null): string {
  const cats = db.select().from(t.categories).all()
  const base = (wanted ?? '').trim().slice(0, 60) || 'iCloud calendar'
  let name = base
  for (let n = 2; cats.some((c) => c.name === name); n++) name = `${base} ${n}`
  const used = new Set(cats.map((c) => c.colour.toLowerCase()))
  const colour =
    CATEGORY_COLOURS.find((c) => !used.has(c)) ??
    CATEGORY_COLOURS[cats.length % CATEGORY_COLOURS.length]
  const words = name.split(/\s+/).filter(Boolean)
  const shortLabel = (words.length > 1 ? words.map((w) => w[0]).join('') : name)
    .slice(0, 4)
    .toUpperCase()
  const id = `cal-${randomUUID().slice(0, 8)}`
  db.insert(t.categories)
    .values({ id, kind: 'calendar', name, shortLabel, colour, sortOrder: cats.length })
    .run()
  return id
}

function removeCalendarRows(db: Db, categoryId: string): void {
  db.delete(t.categories).where(eq(t.categories.id, categoryId)).run()
  const { [categoryId]: _events, ...events } = readEvents(db)
  const { [categoryId]: _status, ...statuses } = readStatuses(db)
  const { [categoryId]: _hidden, ...hidden } = readHidden(db)
  void _events
  void _status
  void _hidden
  writeSetting(db, EVENTS_KEY, events)
  writeSetting(db, STATUS_KEY, statuses)
  writeSetting(db, HIDDEN_KEY, hidden)
}

function readStatuses(db: Db): Record<string, Status> {
  return readSetting<Record<string, Status>>(db, STATUS_KEY) ?? {}
}

function setStatus(db: Db, id: string, status: Status): void {
  writeSetting(db, STATUS_KEY, { ...readStatuses(db), [id]: status })
}

export class LinkedCalendars {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null

  constructor(
    private readonly opts: {
      store: SecretStore<CalendarSecret>
      db: () => Db
      now: () => Temporal.Instant
      /** Only the real profile uses linked calendars. */
      isReal: () => boolean
      changed: () => void
      fetchText?: FetchText
    }
  ) {}

  private fetch(url: string) {
    return (this.opts.fetchText ?? fetchCalendarText)(url)
  }

  /** The linked calendars (never their links), in the order of the Calendars list. */
  list(): LinkedCalendar[] {
    const db = this.opts.db()
    const statuses = readStatuses(db)
    return db
      .select()
      .from(t.categories)
      .where(eq(t.categories.kind, 'calendar'))
      .orderBy(asc(t.categories.sortOrder))
      .all()
      .map((c) => {
        const s = statuses[c.id]
        return {
          id: c.id,
          name: c.name,
          colour: c.colour,
          events: s?.events ?? 0,
          lastCheckedAt: s?.lastCheckedAt ?? null,
          lastError: s?.lastError ?? null
        }
      })
  }

  /** Check the link by reading it, and keep it only if that works. */
  async add(raw: string): Promise<LinkedCalendar> {
    if (!this.opts.isReal()) throw new Error('Linked calendars are only used with real data.')
    const url = normaliseCalendarUrl(raw)
    const secret = (await this.opts.store.get()) ?? { calendars: [] }
    if (secret.calendars.some((c) => c.url === url)) {
      throw new Error('That calendar is already linked.')
    }
    const now = this.opts.now()
    const parsed = parseCalendarText(await this.fetch(url), now)
    const db = this.opts.db()
    const id = createCalendarCategory(db, parsed.name)
    try {
      storeEvents(db, id, parsed.events)
      await this.opts.store.set({ calendars: [...secret.calendars, { id, url }] })
    } catch (e) {
      removeCalendarRows(db, id)
      throw e
    }
    setStatus(db, id, {
      lastCheckedAt: now.toString(),
      lastError: null,
      events: parsed.events.length
    })
    this.opts.changed()
    return this.list().find((c) => c.id === id)!
  }

  /** The linked calendars' events that touch [startIso, endIso), for the calendar to draw. */
  listEvents(startIso: string, endIso: string): LinkedEventView[] {
    const db = this.opts.db()
    const stored = readEvents(db)
    const hidden = readHidden(db)
    const cats = db.select().from(t.categories).where(eq(t.categories.kind, 'calendar')).all()
    return cats.flatMap((c) =>
      eventsInRange(stored[c.id] ?? [], startIso, endIso)
        .filter((e) => !hidden[c.id]?.includes(e.uid))
        .map((e) => ({
          id: `${c.id}:${e.uid}`,
          uid: e.uid,
          calendarId: c.id,
          calendar: c.name,
          colour: c.colour,
          title: e.title,
          allDay: e.allDay,
          start: e.start,
          end: e.end
        }))
    )
  }

  /**
   * Delete one event from Engram's view (the calendar itself is never touched). It stays gone
   * when the calendar is read again; `restoreEvent` brings it back (Undo).
   */
  hideEvent(calendarId: string, uid: string): void {
    this.setHidden(calendarId, uid, true)
  }

  restoreEvent(calendarId: string, uid: string): void {
    this.setHidden(calendarId, uid, false)
  }

  private setHidden(calendarId: string, uid: string, hide: boolean): void {
    const db = this.opts.db()
    const cat = db.select().from(t.categories).where(eq(t.categories.id, calendarId)).get()
    if (!cat || cat.kind !== 'calendar') throw new Error('Calendar not found.')
    const all = readHidden(db)
    const rest = (all[calendarId] ?? []).filter((u) => u !== uid)
    writeSetting(db, HIDDEN_KEY, { ...all, [calendarId]: hide ? [...rest, uid] : rest })
    this.opts.changed()
  }

  /** Rename a calendar or change its colour. */
  update(id: string, patch: { name?: string; colour?: string }): void {
    const db = this.opts.db()
    const cat = db.select().from(t.categories).where(eq(t.categories.id, id)).get()
    if (!cat || cat.kind !== 'calendar') throw new Error('Calendar not found.')
    const values: Partial<typeof t.categories.$inferInsert> = {}
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('Give the calendar a name.')
      values.name = name.slice(0, 60)
    }
    if (patch.colour !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(patch.colour)) throw new Error('Invalid colour.')
      values.colour = patch.colour
    }
    if (Object.keys(values).length) {
      db.update(t.categories).set(values).where(eq(t.categories.id, id)).run()
      this.opts.changed()
    }
  }

  /** Unlink a calendar: its events leave Engram (the calendar itself is untouched). */
  async remove(id: string): Promise<void> {
    const db = this.opts.db()
    const cat = db.select().from(t.categories).where(eq(t.categories.id, id)).get()
    if (!cat || cat.kind !== 'calendar') throw new Error('Calendar not found.')
    const secret = await this.opts.store.get()
    const rest = (secret?.calendars ?? []).filter((c) => c.id !== id)
    if (rest.length) await this.opts.store.set({ calendars: rest })
    else this.opts.store.clear()
    removeCalendarRows(db, id)
    this.opts.changed()
  }

  /** Read every linked calendar now (Settings, or the poll). */
  syncNow(): Promise<void> {
    this.running ??= this.run().finally(() => (this.running = null))
    return this.running
  }

  private async run(): Promise<void> {
    if (!this.opts.isReal()) return
    const secret = await this.opts.store.get()
    if (!secret?.calendars.length) return
    const db = this.opts.db()
    for (const link of secret.calendars) {
      const cat = db.select().from(t.categories).where(eq(t.categories.id, link.id)).get()
      if (!cat) continue
      const now = this.opts.now()
      try {
        const parsed = parseCalendarText(await this.fetch(link.url), now)
        storeEvents(db, link.id, parsed.events)
        // Deleted ones no longer on the calendar needn't be remembered.
        const here = new Set(parsed.events.map((e) => e.uid))
        const all = readHidden(db)
        if (all[link.id]?.some((u) => !here.has(u))) {
          writeSetting(db, HIDDEN_KEY, {
            ...all,
            [link.id]: all[link.id].filter((u) => here.has(u))
          })
        }
        setStatus(db, link.id, {
          lastCheckedAt: now.toString(),
          lastError: null,
          events: parsed.events.length
        })
      } catch (e) {
        // The events shown stay as they were at the last good read.
        const old = readStatuses(db)[link.id]
        setStatus(db, link.id, {
          lastCheckedAt: now.toString(),
          lastError: e instanceof Error ? e.message : 'The calendar couldn’t be read.',
          events: old?.events ?? 0
        })
      }
    }
    // The status line changes on every check, so the Settings page is told either way.
    this.opts.changed()
  }

  start(): void {
    const poll = () => void this.syncNow().catch(() => {})
    setTimeout(poll, 30_000)
    this.timer = setInterval(poll, POLL_MINUTES * 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
