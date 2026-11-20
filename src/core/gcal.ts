// Google Calendar push (Phase 9): pure logic, no I/O. Engram mirrors its calendar into its own
// Google calendar, one way. Each block (and each deadline, as an all-day event) becomes one
// event, keyed so it can be found again; a hash of the event says whether it needs updating.

import { Temporal } from 'temporal-polyfill'
import type { Block, Deadline } from '../shared/types'
import { TZ } from './time'

/** The event fields Engram sets. Times are London local for timed events, dates for all-day. */
export interface CalendarEvent {
  summary: string
  description: string
  start: { dateTime: string; timeZone: string } | { date: string }
  end: { dateTime: string; timeZone: string } | { date: string }
  colorId: string | null
  /** Engram's key, also stored on the event (extendedProperties.private.engram). */
  key: string
}

/** Google Calendar's event colours (GET /colors), so a category maps to the nearest one. */
export const GOOGLE_EVENT_COLOURS: [string, string][] = [
  ['1', '#7986cb'],
  ['2', '#33b679'],
  ['3', '#8e24aa'],
  ['4', '#e67c73'],
  ['5', '#f6bf26'],
  ['6', '#f4511e'],
  ['7', '#039be5'],
  ['8', '#616161'],
  ['9', '#3f51b5'],
  ['10', '#0b8043'],
  ['11', '#d50000']
]

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}

/** The Google event colour closest to a hex colour (null for no colour). */
export function nearestColour(hex: string | null): string | null {
  const c = hex ? rgb(hex) : null
  if (!c) return null
  let best: [string, number] = ['8', Infinity]
  for (const [id, h] of GOOGLE_EVENT_COLOURS) {
    const g = rgb(h)!
    // Weighted RGB distance: close enough to the eye for picking one of eleven.
    const d = 2 * (c[0] - g[0]) ** 2 + 4 * (c[1] - g[1]) ** 2 + 3 * (c[2] - g[2]) ** 2
    if (d < best[1]) best = [id, d]
  }
  return best[0]
}

const localDateTime = (iso: string) =>
  Temporal.Instant.from(iso)
    .toZonedDateTimeISO(TZ)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })

const TYPE_LABEL: Partial<Record<Block['type'], string>> = {
  'write-up': 'Write-up',
  lecture: 'Lecture',
  practical: 'Practical',
  workshop: 'Workshop',
  pbl: 'Problem-based learning',
  presentation: 'Presentation',
  assessment: 'Assessment',
  'assignment-stage': 'Assignment work',
  dissertation: 'Dissertation',
  review: 'Review'
}

/** How a block appears in Google Calendar. Done ones get a tick; skipped ones aren't shown. */
export function blockEvent(block: Block, colour: string | null): CalendarEvent | null {
  if (block.outcome === 'skipped') return null
  const tick = block.outcome === 'done' ? '✓ ' : block.outcome === 'partial' ? '½ ' : ''
  const lines = [
    TYPE_LABEL[block.type] ?? null,
    block.outcome === 'partial' ? 'Partly done' : null,
    block.kind === 'flexible' ? 'Planned in Engram (moves when you replan there).' : 'From Engram.'
  ].filter(Boolean)
  return {
    key: `block:${block.id}`,
    summary: `${tick}${block.title}`,
    description: lines.join('\n'),
    start: { dateTime: localDateTime(block.start), timeZone: TZ },
    end: { dateTime: localDateTime(block.end), timeZone: TZ },
    colorId: nearestColour(block.colour ?? colour)
  }
}

/** A deadline as an all-day event on its day. */
export function deadlineEvent(d: Deadline, colour: string | null): CalendarEvent {
  const day = Temporal.Instant.from(d.at).toZonedDateTimeISO(TZ).toPlainDate()
  const time = Temporal.Instant.from(d.at).toZonedDateTimeISO(TZ).toPlainTime()
  const at = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
  return {
    key: `deadline:${d.id}`,
    summary: `Due: ${d.title}`,
    description: `Deadline at ${at}. From Engram.`,
    start: { date: day.toString() },
    end: { date: day.add({ days: 1 }).toString() },
    colorId: nearestColour(colour)
  }
}

/** A stable hash of what Engram sets on an event (FNV-1a, 2 × 32 bits; not for security). */
export function eventHash(e: CalendarEvent): string {
  const text = JSON.stringify([e.summary, e.description, e.start, e.end, e.colorId])
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** What was pushed last time, per key. */
export interface PushedEvent {
  key: string
  eventId: string
  hash: string
  /** The event's start (ISO date or date-time), to tell whether it's inside the window. */
  start: string
}

export interface PushPlan {
  insert: CalendarEvent[]
  update: { eventId: string; event: CalendarEvent }[]
  remove: PushedEvent[]
}

/**
 * Compare what should be in Google (`wanted`, everything inside the window) with what was
 * pushed. Events from before the window are left alone (history), as is anything Engram
 * didn't create.
 */
export function planPush(
  wanted: CalendarEvent[],
  pushed: PushedEvent[],
  windowStart: string
): PushPlan {
  const byKey = new Map(pushed.map((p) => [p.key, p]))
  const wantedKeys = new Set<string>()
  const plan: PushPlan = { insert: [], update: [], remove: [] }
  for (const e of wanted) {
    if (wantedKeys.has(e.key)) continue
    wantedKeys.add(e.key)
    const was = byKey.get(e.key)
    if (!was) plan.insert.push(e)
    else if (was.hash !== eventHash(e)) plan.update.push({ eventId: was.eventId, event: e })
  }
  for (const p of pushed) {
    if (!wantedKeys.has(p.key) && p.start >= windowStart) plan.remove.push(p)
  }
  return plan
}

/** Where an event starts, comparable with a window start (YYYY-MM-DD…). */
export const eventStart = (e: CalendarEvent): string =>
  'date' in e.start ? e.start.date : e.start.dateTime
