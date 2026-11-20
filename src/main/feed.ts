import type { Temporal } from 'temporal-polyfill'
import { parseTimetable } from '../core/ics'
import type { FeedStatus, ImportSummary } from '../shared/types'
import type { Db } from './db/client'
import type { EncryptedJson } from './secrets'
import { importTimetable } from './timetable'
import * as t from './db/schema'
import { eq } from 'drizzle-orm'

// The real UCL timetable feed (Phase 10). Its link is a personal key: it's kept encrypted with
// safeStorage (secrets/timetable.bin), never in the database, settings, logs or error messages.
// The real profile polls it every few hours; the demo imports its fake feed instead.

export interface FeedSecret {
  url: string
}

/** How often the real feed is checked while Engram runs. */
const POLL_HOURS = 3
const STATUS_KEY = 'timetableFeedStatus'

/**
 * Check and tidy a pasted feed link: webcal:// becomes https://, and only https is accepted
 * (the link carries a personal key, so it must not travel in the clear).
 */
export function normaliseFeedUrl(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('Paste your timetable’s calendar link.')
  let url: URL
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, 'https://'))
  } catch {
    throw new Error('That isn’t a link. Copy the whole calendar (iCal) link from the timetable.')
  }
  if (url.protocol !== 'https:') throw new Error('The link must start with https:// or webcal://.')
  return url.toString()
}

export type FetchText = (url: string) => Promise<string>

/** Fetch the feed. Errors never include the link. */
export const fetchFeedText: FetchText = async (url) => {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  } catch {
    throw new Error('Couldn’t reach the timetable. Check your internet connection.')
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404 || res.status === 403 || res.status === 401
        ? 'The timetable didn’t accept that link. Copy it again from the timetable website.'
        : `The timetable answered with an error (${res.status}). Try again later.`
    )
  }
  return res.text()
}

export function getFeedStatus(db: Db): Omit<FeedStatus, 'connected'> {
  const row = db.select().from(t.settings).where(eq(t.settings.key, STATUS_KEY)).get()
  const v = (row?.value ?? {}) as Partial<FeedStatus>
  return { lastCheckedAt: v.lastCheckedAt ?? null, lastError: v.lastError ?? null }
}

function setFeedStatus(db: Db, status: Omit<FeedStatus, 'connected'>): void {
  db.insert(t.settings)
    .values({ key: STATUS_KEY, value: status })
    .onConflictDoUpdate({ target: t.settings.key, set: { value: status } })
    .run()
}

/** Parse feed text and import it. Throws if it isn't a timetable. */
export function importFeedText(db: Db, text: string, now: Temporal.Instant): ImportSummary {
  if (!/BEGIN:VCALENDAR/.test(text)) {
    throw new Error(
      'That link doesn’t lead to a calendar. Use the iCal/calendar subscription link.'
    )
  }
  const parsed = parseTimetable(text)
  if (!parsed.events.length) throw new Error('The calendar at that link has no events.')
  return importTimetable(db, parsed.events, now, {
    source: 'ucl-feed',
    skipped: parsed.skipped.length
  })
}

export class TimetableFeed {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<ImportSummary | null> | null = null

  constructor(
    private readonly opts: {
      store: EncryptedJson<FeedSecret>
      db: () => Db
      now: () => Temporal.Instant
      /** Only the real profile uses the real feed. */
      isReal: () => boolean
      changed: () => void
      fetchText?: FetchText
    }
  ) {}

  connected(): boolean {
    return this.opts.store.has()
  }

  status(): FeedStatus {
    return { connected: this.connected(), ...getFeedStatus(this.opts.db()) }
  }

  /** Check the link by importing from it, and keep it only if that works. */
  async connect(raw: string): Promise<ImportSummary> {
    if (!this.opts.isReal()) throw new Error('The timetable link is only used with real data.')
    const url = normaliseFeedUrl(raw)
    const text = await (this.opts.fetchText ?? fetchFeedText)(url)
    const summary = importFeedText(this.opts.db(), text, this.opts.now())
    await this.opts.store.set({ url })
    setFeedStatus(this.opts.db(), { lastCheckedAt: summary.at, lastError: null })
    this.opts.changed()
    return summary
  }

  disconnect(): void {
    this.opts.store.clear()
  }

  /** Import now (Settings, the wizard, or the poll). Null when there's no link or no real profile. */
  importNow(): Promise<ImportSummary | null> {
    this.running ??= this.run().finally(() => (this.running = null))
    return this.running
  }

  private async run(): Promise<ImportSummary | null> {
    if (!this.opts.isReal()) return null
    const secret = await this.opts.store.get()
    if (!secret) return null
    const db = this.opts.db()
    try {
      const text = await (this.opts.fetchText ?? fetchFeedText)(secret.url)
      const summary = importFeedText(db, text, this.opts.now())
      setFeedStatus(db, { lastCheckedAt: summary.at, lastError: null })
      this.opts.changed()
      return summary
    } catch (e) {
      setFeedStatus(db, {
        lastCheckedAt: this.opts.now().toString(),
        lastError: e instanceof Error ? e.message : 'The timetable couldn’t be imported.'
      })
      this.opts.changed()
      throw e
    }
  }

  start(): void {
    const poll = () => void this.importNow().catch(() => {})
    setTimeout(poll, 20_000)
    this.timer = setInterval(poll, POLL_HOURS * 3600_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
