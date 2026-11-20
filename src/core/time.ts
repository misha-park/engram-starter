import { Temporal } from 'temporal-polyfill'

/** All wall-clock reasoning happens in this zone; instants are stored as UTC ISO strings. */
export const TZ = 'Europe/London'

export type Instant = Temporal.Instant
export type ZonedDateTime = Temporal.ZonedDateTime

export function instant(iso: string): Instant {
  return Temporal.Instant.from(iso)
}

export function toIso(value: Instant | ZonedDateTime): string {
  const i = value instanceof Temporal.Instant ? value : value.toInstant()
  return i.toString({ smallestUnit: 'second' })
}

export function zoned(value: Instant | string): ZonedDateTime {
  const i = typeof value === 'string' ? instant(value) : value
  return i.toZonedDateTimeISO(TZ)
}

/** Midnight at the start of the local day containing `value`. */
export function startOfDay(value: Instant | string): ZonedDateTime {
  return zoned(value).startOfDay()
}

/** Monday 00:00 local time of the week containing `value`. */
export function startOfWeek(value: Instant | string): ZonedDateTime {
  const z = zoned(value)
  return z
    .toPlainDate()
    .subtract({ days: z.dayOfWeek - 1 })
    .toZonedDateTime({ timeZone: TZ })
}

/** [start, end) of the Monday–Sunday week containing `value`. */
export function weekRange(value: Instant | string): { start: ZonedDateTime; end: ZonedDateTime } {
  const start = startOfWeek(value)
  return { start, end: start.toPlainDate().add({ days: 7 }).toZonedDateTime({ timeZone: TZ }) }
}

/** Local wall-clock time `HH:MM` on a local date, as a zoned date-time (DST-safe). */
export function atLocalTime(date: Temporal.PlainDate | string, hhmm: string): ZonedDateTime {
  const d = typeof date === 'string' ? Temporal.PlainDate.from(date) : date
  return d.toZonedDateTime({ timeZone: TZ, plainTime: Temporal.PlainTime.from(hhmm) })
}

/**
 * A local time range on a date. An end at or before the start rolls over to the next day,
 * so 17:00–00:00 ends at midnight after the shift.
 */
export function localRange(
  date: Temporal.PlainDate | string,
  startTime: string,
  endTime: string
): { start: ZonedDateTime; end: ZonedDateTime } {
  const d = typeof date === 'string' ? Temporal.PlainDate.from(date) : date
  const start = atLocalTime(d, startTime)
  const endSameDay = atLocalTime(d, endTime)
  const end =
    Temporal.ZonedDateTime.compare(endSameDay, start) <= 0
      ? atLocalTime(d.add({ days: 1 }), endTime)
      : endSameDay
  return { start, end }
}

export function minutesBetween(a: Instant | string, b: Instant | string): number {
  const ia = typeof a === 'string' ? instant(a) : a
  const ib = typeof b === 'string' ? instant(b) : b
  return Math.round(ia.until(ib).total({ unit: 'minutes' }))
}

/** "45m", "2h", "14h 05m" */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total))
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h === 0) return `${mm}m`
  if (mm === 0) return `${h}h`
  return `${h}h ${String(mm).padStart(2, '0')}m`
}

/** "09:30" in local time */
export function formatClock(value: Instant | string): string {
  const z = zoned(value)
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`
}

export function todayLocalDate(now: Instant): Temporal.PlainDate {
  return zoned(now).toPlainDate()
}

/**
 * Parse what people type: "9", "930", "0930", "9:30", "9.30", "21:15" → "HH:MM", or null.
 */
export function parseTimeInput(input: string): string | null {
  const s = input.trim().replace('.', ':')
  let h: number, m: number
  const colon = /^(\d{1,2}):(\d{1,2})$/.exec(s)
  const digits = /^(\d{1,4})$/.exec(s)
  if (colon) {
    h = Number(colon[1])
    m = Number(colon[2])
  } else if (digits) {
    const d = digits[1]
    if (d.length <= 2) {
      h = Number(d)
      m = 0
    } else {
      h = Number(d.slice(0, d.length - 2))
      m = Number(d.slice(-2))
    }
  } else {
    return null
  }
  if (h > 23 || m > 59) return null
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
