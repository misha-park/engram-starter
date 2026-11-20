import { Temporal } from 'temporal-polyfill'
import type { AvailabilitySettings, DayHours, LegacyAvailability } from '../shared/types'
import { localRange, type ZonedDateTime } from './time'

// Availability rules constrain automatic placement only (the scheduler and the assistant).
// The user can still drag a block anywhere by hand. Each weekday has its own hours, or none.

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const NINE_TO_TEN: DayHours = { start: '09:00', end: '22:00' }
export const DEFAULT_AVAILABILITY: AvailabilitySettings = {
  days: Array.from({ length: 7 }, () => ({ ...NINE_TO_TEN }))
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** The old "working hours + protected evenings" settings as per-day hours. */
export function fromLegacy(l: LegacyAvailability): AvailabilitySettings {
  return {
    days: Array.from({ length: 7 }, (_, i) => {
      let end = l.workingHoursEnd
      if (
        l.protectedEvenings.includes(i + 1) &&
        minutesOf(l.protectedEveningFrom) < minutesOf(end)
      ) {
        end = l.protectedEveningFrom
      }
      return minutesOf(end) > minutesOf(l.noWorkBefore) ? { start: l.noWorkBefore, end } : null
    })
  }
}

/** Whatever was stored (new shape, old shape or nothing) as per-day settings. */
export function normalizeAvailability(raw: unknown): AvailabilitySettings {
  const value = (raw ?? {}) as Partial<AvailabilitySettings & LegacyAvailability>
  if (Array.isArray(value.days) && value.days.length === 7) {
    return { days: value.days.map((d) => (d ? { start: d.start, end: d.end } : null)) }
  }
  if (value.noWorkBefore || value.workingHoursEnd || value.protectedEvenings) {
    return fromLegacy({
      noWorkBefore: value.noWorkBefore ?? '09:00',
      workingHoursEnd: value.workingHoursEnd ?? '22:00',
      protectedEvenings: value.protectedEvenings ?? [],
      protectedEveningFrom: value.protectedEveningFrom ?? '18:00'
    })
  }
  return structuredClone(DEFAULT_AVAILABILITY)
}

/** The local [start, end) times work may be placed on a given ISO weekday (1 = Monday). */
export function dayWindow(
  av: AvailabilitySettings,
  isoWeekday: number
): { start: string; end: string } | null {
  const day = av.days[isoWeekday - 1]
  return day && minutesOf(day.end) > minutesOf(day.start)
    ? { start: day.start, end: day.end }
    : null
}

/**
 * The hard "no work before" for a day: its start, or on a day off the earliest start of any
 * day. When nothing fits, the scheduler's fallback may run late, but never earlier than this.
 */
export function noWorkBefore(av: AvailabilitySettings, isoWeekday: number): string {
  const own = dayWindow(av, isoWeekday)
  if (own) return own.start
  const starts = av.days.filter((d): d is DayHours => !!d).map((d) => d.start)
  return starts.sort((a, b) => minutesOf(a) - minutesOf(b))[0] ?? NINE_TO_TEN.start
}

/** The available window on a specific local date, as zoned date-times. */
export function availableWindow(
  av: AvailabilitySettings,
  date: Temporal.PlainDate
): { start: ZonedDateTime; end: ZonedDateTime } | null {
  const w = dayWindow(av, date.dayOfWeek)
  return w ? localRange(date, w.start, w.end) : null
}

/** FullCalendar `businessHours` input (its daysOfWeek uses 0 = Sunday). */
export function toBusinessHours(
  av: AvailabilitySettings
): { daysOfWeek: number[]; startTime: string; endTime: string }[] {
  const out: { daysOfWeek: number[]; startTime: string; endTime: string }[] = []
  for (let iso = 1; iso <= 7; iso++) {
    const w = dayWindow(av, iso)
    if (!w) continue
    const existing = out.find((o) => o.startTime === w.start && o.endTime === w.end)
    const fcDay = iso % 7
    if (existing) existing.daysOfWeek.push(fcDay)
    else out.push({ daysOfWeek: [fcDay], startTime: w.start, endTime: w.end })
  }
  return out
}

/** "Mon–Thu 09:00–22:00, Fri 09:00–18:00, Sat off, …" (runs of equal days are joined). */
export function describeAvailability(av: AvailabilitySettings): string {
  const label = (i: number) => {
    const w = dayWindow(av, i + 1)
    return w ? `${w.start}–${w.end}` : 'off'
  }
  const parts: string[] = []
  for (let i = 0; i < 7;) {
    let j = i
    while (j + 1 < 7 && label(j + 1) === label(i)) j++
    const days = i === j ? WEEKDAY_NAMES[i] : `${WEEKDAY_NAMES[i]}–${WEEKDAY_NAMES[j]}`
    parts.push(`${days} ${label(i)}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** Validates user-entered settings; returns an error message or null. */
export function validateAvailability(av: AvailabilitySettings): string | null {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/
  if (!Array.isArray(av.days) || av.days.length !== 7) return 'Give hours for each day.'
  for (let i = 0; i < 7; i++) {
    const d = av.days[i]
    if (!d) continue
    for (const t of [d.start, d.end]) if (!time.test(t)) return `Invalid time: ${t}`
    if (minutesOf(d.end) <= minutesOf(d.start))
      return `${WEEKDAY_NAMES[i]}: the day must end after it starts.`
  }
  return null
}
