import { Temporal } from 'temporal-polyfill'
import { startOfWeek } from '../../core/time'
import { FEED_LEVEL, FEED_ONE_OFFS, FEED_PATTERN, TEACHING_WEEKS, type FeedSlot } from './demo-data'

// Writes the fake timetable as an iCalendar file in the UCL feed's format, with dates around
// the current week so the demo never goes stale. UIDs are derived from the date, so importing
// it again later only adds the new weeks.

const fold = (line: string): string => {
  // RFC 5545: lines longer than 75 octets are folded with CRLF + space.
  const out: string[] = []
  for (let i = 0; i < line.length; i += 74) out.push((i ? ' ' : '') + line.slice(i, i + 74))
  return out.join('\r\n')
}

const local = (date: Temporal.PlainDate, hhmm: string) =>
  `${date.toString().replace(/-/g, '')}T${hhmm.replace(':', '')}00`

function vevent(
  date: Temporal.PlainDate,
  slot: Omit<FeedSlot, 'weekday'>,
  feedName: string,
  uid: string,
  stamp: string
): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/London:${local(date, slot.start)}`,
    `DTEND;TZID=Europe/London:${local(date, slot.end)}`,
    `SUMMARY:${feedName} Level ${FEED_LEVEL} [${slot.feedType}]`,
    `CATEGORIES:${slot.categories ?? slot.feedType}`,
    'LOCATION:Demo building (fake)',
    'DESCRIPTION:Fake event generated for demo mode.',
    'END:VEVENT'
  ]
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
]

export function buildDemoTimetableIcs(now: Temporal.Instant): string {
  const monday = startOfWeek(now).toPlainDate()
  const stamp = now.toString({ smallestUnit: 'second' }).replace(/[-:]/g, '')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Engram//Demo timetable (fake)//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...VTIMEZONE
  ]
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  for (let w = TEACHING_WEEKS.from; w <= TEACHING_WEEKS.to; w++) {
    for (const slot of FEED_PATTERN) {
      const date = monday.add({ weeks: w }).add({ days: slot.weekday - 1 })
      for (const name of slot.feedNames) {
        const uid = `demo-${date}-${slot.start.replace(':', '')}-${slug(name)}@timetable.example`
        lines.push(...vevent(date, slot, name, uid, stamp))
      }
    }
  }
  for (const one of FEED_ONE_OFFS) {
    const date = monday.add({ weeks: one.week }).add({ days: one.weekday - 1 })
    for (const name of one.feedNames) {
      const uid = `demo-${date}-${one.start.replace(':', '')}-${slug(name)}-${slug(one.feedType)}@timetable.example`
      lines.push(...vevent(date, one, name, uid, stamp))
    }
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
