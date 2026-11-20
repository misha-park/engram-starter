import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import {
  blockEvent,
  deadlineEvent,
  eventHash,
  eventStart,
  planPush,
  type CalendarEvent,
  type PushedEvent
} from '../../core/gcal'
import { atLocalTime, todayLocalDate, toIso } from '../../core/time'
import type { GoogleStatus } from '../../shared/types'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { getSetting, listBlocksInRange, listDeadlines } from '../repo'
import { NotFound, type CalendarTarget } from './calendar'

// Google Calendar push (Phase 9). One way: the calendar Engram created mirrors Engram's
// calendar from two weeks ago to four months ahead. Runs shortly after any change and every
// 5 minutes; a push with nothing to change makes no calls to Google.

const PAST_DAYS = 14
const FUTURE_DAYS = 120
const KEY = 'google'

interface GoogleSettings {
  enabled: boolean
  calendarId: string | null
  lastSyncedAt: string | null
  lastError: string | null
}

export function getGoogleSettings(db: Db, defaultEnabled: boolean): GoogleSettings {
  return {
    enabled: defaultEnabled,
    calendarId: null,
    lastSyncedAt: null,
    lastError: null,
    ...(getSetting<Partial<GoogleSettings>>(db, KEY) ?? {})
  }
}

function saveGoogleSettings(db: Db, patch: Partial<GoogleSettings>, defaultEnabled: boolean) {
  const value = { ...getGoogleSettings(db, defaultEnabled), ...patch }
  db.insert(t.settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

/** Everything that should be in the calendar now, and the window it covers. */
export function wantedEvents(
  db: Db,
  now: Temporal.Instant
): { events: CalendarEvent[]; windowStart: string } {
  const today = todayLocalDate(now)
  const from = today.subtract({ days: PAST_DAYS })
  const fromIso = toIso(atLocalTime(from, '00:00'))
  const toIso_ = toIso(atLocalTime(today.add({ days: FUTURE_DAYS }), '00:00'))
  const colours = new Map(
    db
      .select({ id: t.categories.id, colour: t.categories.colour })
      .from(t.categories)
      .all()
      .map((c) => [c.id, c.colour])
  )
  const colourOf = (id: string | null) => (id ? (colours.get(id) ?? null) : null)
  const events: CalendarEvent[] = []
  for (const b of listBlocksInRange(db, fromIso, toIso_)) {
    const e = blockEvent(b, colourOf(b.categoryId))
    if (e) events.push(e)
  }
  // Todos stay in Engram: Google Calendar gets blocks and real deadlines only.
  for (const d of listDeadlines(db, fromIso, toIso_).filter((d) => d.kind !== 'todo')) {
    events.push(deadlineEvent(d, colourOf(d.categoryId)))
  }
  return { events, windowStart: from.toString() }
}

export interface PushResult {
  inserted: number
  updated: number
  removed: number
}

/** One push. `verified` is the calendar id already checked this session (skips a call). */
export async function pushOnce(
  db: Db,
  target: CalendarTarget,
  now: Temporal.Instant,
  defaultEnabled: boolean,
  verified: string | null
): Promise<PushResult & { calendarId: string }> {
  const settings = getGoogleSettings(db, defaultEnabled)
  let calendarId = settings.calendarId
  if (!calendarId || calendarId !== verified) {
    const id = await target.ensureCalendar(calendarId)
    if (id !== calendarId) {
      // A new calendar (first push, or the old one was deleted): nothing is in it yet.
      db.delete(t.gcalEvents).run()
      saveGoogleSettings(db, { calendarId: id }, defaultEnabled)
      calendarId = id
    }
  }

  let pushed: PushedEvent[] = db.select().from(t.gcalEvents).all()
  if (pushed.length === 0) {
    // Nothing recorded (a restore or a reset): take Engram's events already in the calendar,
    // so they're updated rather than duplicated. Unknown hashes force an update.
    const seen = new Set<string>()
    for (const e of await target.listEngramEvents(calendarId)) {
      const row = {
        key: seen.has(e.key) ? `dup:${e.eventId}` : e.key,
        eventId: e.eventId,
        hash: '',
        start: '9999'
      }
      seen.add(e.key)
      db.insert(t.gcalEvents).values(row).run()
    }
    pushed = db.select().from(t.gcalEvents).all()
  }

  const { events, windowStart } = wantedEvents(db, now)
  const plan = planPush(events, pushed, windowStart)
  const record = (key: string, eventId: string, e: CalendarEvent) => {
    const row = { key, eventId, hash: eventHash(e), start: eventStart(e) }
    db.insert(t.gcalEvents)
      .values(row)
      .onConflictDoUpdate({ target: t.gcalEvents.key, set: row })
      .run()
  }

  // Each change is recorded as it's made, so a failure part-way loses nothing.
  for (const e of plan.insert) record(e.key, await target.insert(calendarId, e), e)
  for (const { eventId, event } of plan.update) {
    try {
      await target.update(calendarId, eventId, event)
      record(event.key, eventId, event)
    } catch (err) {
      if (!(err instanceof NotFound)) throw err
      record(event.key, await target.insert(calendarId, event), event) // Deleted in Google.
    }
  }
  for (const p of plan.remove) {
    await target.remove(calendarId, p.eventId)
    db.delete(t.gcalEvents).where(eq(t.gcalEvents.key, p.key)).run()
  }
  saveGoogleSettings(db, { lastSyncedAt: toIso(now), lastError: null }, defaultEnabled)
  return {
    calendarId,
    inserted: plan.insert.length,
    updated: plan.update.length,
    removed: plan.remove.length
  }
}

export interface GcalSyncDeps {
  db(): Db
  now(): Temporal.Instant
  /** Where to push, or null when Google isn't set up (real profile, not signed in). */
  target(): Promise<CalendarTarget | null>
  /** 'google' for the real profile, 'file' for the demo. */
  kind(): 'google' | 'file'
  /** The demo pushes by default; the real profile once the user signs in. */
  defaultEnabled(): boolean
  account(): Promise<{ hasClient: boolean; signedIn: boolean }>
  eventsInDemo(): number
}

const POLL_MS = 5 * 60_000
const SOON_MS = 3_000

/** Runs pushes one at a time: shortly after changes and every 5 minutes. */
export class GcalSync {
  private running: Promise<void> | null = null
  private queued: Promise<void> | null = null
  private soonTimer: NodeJS.Timeout | null = null
  private poller: NodeJS.Timeout | null = null
  private verified: string | null = null

  constructor(private readonly deps: GcalSyncDeps) {}

  start(): void {
    this.poller ??= setInterval(() => void this.sync(), POLL_MS)
    void this.sync()
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller)
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.poller = this.soonTimer = null
  }

  /** Something changed: push in a few seconds (many changes make one push). */
  soon(): void {
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      void this.sync()
    }, SOON_MS)
  }

  /** The profile changed: check the calendar again on the next push. */
  reset(): void {
    this.verified = null
  }

  async status(): Promise<GoogleStatus> {
    const db = this.deps.db()
    const s = getGoogleSettings(db, this.deps.defaultEnabled())
    const kind = this.deps.kind()
    const account =
      kind === 'google' ? await this.deps.account() : { hasClient: true, signedIn: true }
    return {
      source: kind,
      enabled: s.enabled,
      hasClient: account.hasClient,
      signedIn: account.signedIn,
      calendarId: s.calendarId,
      lastSyncedAt: s.lastSyncedAt,
      lastError: s.lastError,
      events: db.select().from(t.gcalEvents).all().length,
      demoEvents: kind === 'file' ? this.deps.eventsInDemo() : null
    }
  }

  async setEnabled(enabled: boolean): Promise<GoogleStatus> {
    saveGoogleSettings(this.deps.db(), { enabled, lastError: null }, this.deps.defaultEnabled())
    if (enabled) await this.sync()
    return this.status()
  }

  /** After the calendar was deleted from Engram's side: start afresh next time. */
  forgetCalendar(): void {
    const db = this.deps.db()
    db.delete(t.gcalEvents).run()
    saveGoogleSettings(db, { calendarId: null }, this.deps.defaultEnabled())
    this.verified = null
  }

  /** Push now unless it's off. Never throws (errors go in the status). */
  sync(force = false): Promise<void> {
    if (this.running) {
      this.queued ??= this.running.then(() => {
        this.queued = null
        return this.sync(force)
      })
      return this.queued
    }
    const run = this.runOnce(force)
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = null
    })
    return run
  }

  private async runOnce(force: boolean): Promise<void> {
    const defaultEnabled = this.deps.defaultEnabled()
    try {
      const db = this.deps.db()
      if (!force && !getGoogleSettings(db, defaultEnabled).enabled) return
      const target = await this.deps.target()
      if (!target) return
      const r = await pushOnce(db, target, this.deps.now(), defaultEnabled, this.verified)
      this.verified = r.calendarId
    } catch (e) {
      this.verified = null
      try {
        saveGoogleSettings(this.deps.db(), { lastError: (e as Error).message }, defaultEnabled)
      } catch {
        // The profile may be switching; the next push tries again.
      }
    }
  }
}
