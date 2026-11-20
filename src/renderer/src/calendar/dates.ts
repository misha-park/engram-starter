import { Temporal } from 'temporal-polyfill'
import { atLocalTime, toIso, TZ } from '@core/time'

/**
 * Convert a FullCalendar date string to a UTC ISO instant.
 * Timed values carry an offset ("2026-11-17T10:00:00+00:00"); all-day values are plain
 * local dates ("2026-11-17"), which mean local midnight.
 */
export function fcToIso(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return toIso(atLocalTime(value, '00:00'))
  return toIso(Temporal.Instant.from(value))
}

/**
 * The New event button's default: the next whole hour, for an hour. At night (before 08:00
 * or from 22:00) that's 09:00 the next morning, so the event lands where the grid shows it.
 */
export function nextHourSlot(now: Temporal.ZonedDateTime = Temporal.Now.zonedDateTimeISO(TZ)): {
  start: string
  end: string
} {
  let start = now.round({ smallestUnit: 'hour', roundingMode: 'ceil' })
  if (start.hour < 8) start = start.with({ hour: 9 })
  else if (start.hour >= 22 || start.toPlainDate().equals(now.toPlainDate()) === false)
    start = now.toPlainDate().add({ days: 1 }).toZonedDateTime({ timeZone: TZ, plainTime: '09:00' })
  return { start: toIso(start), end: toIso(start.add({ hours: 1 })) }
}
