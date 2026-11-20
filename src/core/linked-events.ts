import { Temporal } from 'temporal-polyfill'
import type { LinkedEvent } from './calendar-feed'
import { TZ } from './time'

// Kept apart from calendar-feed.ts (which needs node-ical, a Node library) so the window can use it.

const same = (a: string, b: string) => {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (x === y) return true
  // "Dentist" and "Dentist (Dr Lee)": one name holds the other (but not just a letter or two).
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 3 && long.includes(short)
}

/**
 * Whether the user has already added a linked event to Engram by hand: a block with the same
 * (or a containing) title that overlaps it, or, for an all-day event, falls on one of its days.
 * The same time alone isn't enough: a clash with something else is what's worth seeing.
 */
export function copiedIntoEngram(
  event: Pick<LinkedEvent, 'title' | 'allDay' | 'start' | 'end'>,
  blocks: { title: string; start: string; end: string }[]
): boolean {
  return blocks.some((b) => {
    if (!same(event.title, b.title)) return false
    if (!event.allDay) return b.start < event.end && b.end > event.start
    const day = Temporal.Instant.from(b.start).toZonedDateTimeISO(TZ).toPlainDate().toString()
    return day >= event.start && day < event.end
  })
}
