import ical, { type VEvent } from 'node-ical'
import { Temporal } from 'temporal-polyfill'
import { TZ } from './time'

// Reads a linked calendar's iCalendar text (an iCloud public calendar, say). Pure: text in,
// events out. The events are only shown on Engram's calendar for reference: they never become
// blocks, so nothing is planned around them. Cancelled events are left out.

export interface LinkedEvent {
  /** Stable per event (and per occurrence of a repeating one, "<uid>#<start>"). */
  uid: string
  title: string
  allDay: boolean
  /** UTC ISO instants; for an all-day event, dates (YYYY-MM-DD) with the end not included. */
  start: string
  end: string
}

export interface ParsedCalendar {
  /** The calendar's own name (X-WR-CALNAME), when it has one. */
  name: string | null
  events: LinkedEvent[]
}

const MIN_MINUTES = 15
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
const pad = (n: number) => String(n).padStart(2, '0')
/** An all-day Date is a local midnight: its calendar day is read in local time. */
const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : v && typeof v === 'object' && 'val' in v
      ? String((v as { val: unknown }).val)
      : ''

/**
 * Parse calendar text. Repeating events are expanded within `window` (their exceptions and
 * changed occurrences are honoured); single events are kept when they overlap it.
 */
export function parseLinkedCalendar(
  icsText: string,
  window: { from: Date; to: Date }
): ParsedCalendar {
  const data = ical.sync.parseICS(icsText)
  const events: LinkedEvent[] = []
  let name: string | null = null

  for (const [key, component] of Object.entries(data)) {
    if (!component || typeof component !== 'object') continue
    const type = (component as { type?: string }).type
    if (type === 'VCALENDAR') {
      name = text((component as Record<string, unknown>)['WR-CALNAME']).trim() || null
      continue
    }
    if (type !== 'VEVENT') continue
    const ev = component as VEvent
    if (ev.status === 'CANCELLED') continue
    const uid = ev.uid || key
    const title = text(ev.summary).trim() || 'Busy'

    const instances: { uid: string; title: string; allDay: boolean; start: Date; end: Date }[] = []
    if (ev.rrule) {
      for (const inst of ical.expandRecurringEvent(ev, { from: window.from, to: window.to })) {
        // A changed occurrence can have its own title.
        instances.push({
          uid: `${uid}#${iso(inst.start)}`,
          title: text(inst.summary).trim() || title,
          allDay: !!inst.isFullDay,
          start: inst.start,
          end: inst.end
        })
      }
    } else if (ev.start instanceof Date && ev.end instanceof Date) {
      if (ev.end > window.from && ev.start < window.to) {
        instances.push({ uid, title, allDay: ev.datetype === 'date', start: ev.start, end: ev.end })
      }
    }

    for (const inst of instances) {
      let { start, end } = inst
      if (inst.allDay) {
        const first = day(start)
        let last = day(end)
        // An all-day event takes at least its own day.
        if (last <= first) {
          last = Temporal.PlainDate.from(first).add({ days: 1 }).toString()
        }
        events.push({ uid: inst.uid, title: inst.title, allDay: true, start: first, end: last })
        continue
      }
      // A timed event with no length still takes a moment on the calendar.
      if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + MIN_MINUTES * 60_000)
      events.push({
        uid: inst.uid,
        title: inst.title,
        allDay: false,
        start: iso(start),
        end: iso(end)
      })
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid))
  return { name, events }
}

/** The events that touch [startIso, endIso) (all-day ones by their London dates). */
export function eventsInRange(events: LinkedEvent[], startIso: string, endIso: string) {
  const first = Temporal.Instant.from(startIso).toZonedDateTimeISO(TZ).toPlainDate().toString()
  const last = Temporal.Instant.from(endIso).toZonedDateTimeISO(TZ).toPlainDate().toString()
  return events.filter((e) =>
    e.allDay ? e.start <= last && e.end > first : e.start < endIso && e.end > startIso
  )
}
