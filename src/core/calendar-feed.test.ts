import { describe, expect, it } from 'vitest'
import { eventsInRange, parseLinkedCalendar } from './calendar-feed'

const WINDOW = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z') }

const TZ_LONDON = `BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:STANDARD
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
END:DAYLIGHT
END:VTIMEZONE`

const calendar = (...events: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iCloud Calendar//EN',
    'X-WR-CALNAME:Personal',
    TZ_LONDON,
    ...events.map((e) => `BEGIN:VEVENT\nDTSTAMP:20261101T000000Z\n${e}\nEND:VEVENT`),
    'END:VCALENDAR'
  ].join('\n')

describe('parseLinkedCalendar', () => {
  it('reads the calendar name and single timed events', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:one\nDTSTART;TZID=Europe/London:20261126T140000\nDTEND;TZID=Europe/London:20261126T150000\nSUMMARY:Dentist',
        'UID:utc\nDTSTART:20261124T093000Z\nDTEND:20261124T103000Z\nSUMMARY:Call'
      ),
      WINDOW
    )
    expect(r.name).toBe('Personal')
    expect(r.events).toEqual([
      {
        uid: 'utc',
        title: 'Call',
        allDay: false,
        start: '2026-11-24T09:30:00Z',
        end: '2026-11-24T10:30:00Z'
      },
      {
        uid: 'one',
        title: 'Dentist',
        allDay: false,
        start: '2026-11-26T14:00:00Z',
        end: '2026-11-26T15:00:00Z'
      }
    ])
  })

  it('expands a repeating event, honouring its exceptions and changed occurrences', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:climb\nDTSTART;TZID=Europe/London:20261102T180000\nDTEND;TZID=Europe/London:20261102T200000\nRRULE:FREQ=WEEKLY;COUNT=6\nEXDATE;TZID=Europe/London:20261116T180000\nSUMMARY:Climbing',
        'UID:climb\nRECURRENCE-ID;TZID=Europe/London:20261123T180000\nDTSTART;TZID=Europe/London:20261123T190000\nDTEND;TZID=Europe/London:20261123T210000\nSUMMARY:Climbing (late)'
      ),
      WINDOW
    )
    expect(r.events.map((e) => [e.title, e.start])).toEqual([
      ['Climbing', '2026-11-02T18:00:00Z'],
      ['Climbing', '2026-11-09T18:00:00Z'],
      ['Climbing (late)', '2026-11-23T19:00:00Z'],
      ['Climbing', '2026-11-30T18:00:00Z'],
      ['Climbing', '2026-12-07T18:00:00Z']
    ])
    // Every occurrence has its own stable id.
    expect(new Set(r.events.map((e) => e.uid)).size).toBe(5)
    expect(r.events[0].uid).toBe('climb#2026-11-02T18:00:00Z')
  })

  it('follows summer time (BST) for a repeating evening event', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:run\nDTSTART;TZID=Europe/London:20260323T180000\nDTEND;TZID=Europe/London:20260323T190000\nRRULE:FREQ=WEEKLY;COUNT=2\nSUMMARY:Run'
      ),
      { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-04-30T00:00:00Z') }
    )
    expect(r.events.map((e) => e.start)).toEqual(['2026-03-23T18:00:00Z', '2026-03-30T17:00:00Z'])
  })

  it('keeps all-day events (as dates) and free-time ones, and leaves out cancelled ones', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:bday\nDTSTART;VALUE=DATE:20261125\nDTEND;VALUE=DATE:20261126\nSUMMARY:Birthday',
        'UID:trip\nDTSTART;VALUE=DATE:20261128\nDTEND;VALUE=DATE:20261201\nSUMMARY:Away',
        'UID:free\nDTSTART:20261124T090000Z\nDTEND:20261124T100000Z\nTRANSP:TRANSPARENT\nSUMMARY:Maybe',
        'UID:gone\nDTSTART:20261124T110000Z\nDTEND:20261124T120000Z\nSTATUS:CANCELLED\nSUMMARY:Cancelled'
      ),
      WINDOW
    )
    expect(r.events.map((e) => [e.title, e.allDay, e.start, e.end])).toEqual([
      ['Maybe', false, '2026-11-24T09:00:00Z', '2026-11-24T10:00:00Z'],
      ['Birthday', true, '2026-11-25', '2026-11-26'],
      ['Away', true, '2026-11-28', '2026-12-01']
    ])
  })

  it('expands a repeating all-day event', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:bin\nDTSTART;VALUE=DATE:20261102\nDTEND;VALUE=DATE:20261103\nRRULE:FREQ=WEEKLY;COUNT=3\nSUMMARY:Bins'
      ),
      WINDOW
    )
    expect(r.events.map((e) => [e.allDay, e.start, e.end])).toEqual([
      [true, '2026-11-02', '2026-11-03'],
      [true, '2026-11-09', '2026-11-10'],
      [true, '2026-11-16', '2026-11-17']
    ])
  })

  it('ignores events outside the window and gives empty ones a moment', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:old\nDTSTART:20250101T090000Z\nDTEND:20250101T100000Z\nSUMMARY:Old',
        'UID:blip\nDTSTART:20261124T090000Z\nDTEND:20261124T090000Z\nSUMMARY:Blip'
      ),
      WINDOW
    )
    expect(r.events).toEqual([
      {
        uid: 'blip',
        title: 'Blip',
        allDay: false,
        start: '2026-11-24T09:00:00Z',
        end: '2026-11-24T09:15:00Z'
      }
    ])
  })

  it('keeps an event that runs past midnight whole', () => {
    const r = parseLinkedCalendar(
      calendar(
        'UID:night\nDTSTART;TZID=Europe/London:20261120T230000\nDTEND;TZID=Europe/London:20261121T020000\nSUMMARY:Night out'
      ),
      WINDOW
    )
    expect(r.events.map((e) => [e.start, e.end])).toEqual([
      ['2026-11-20T23:00:00Z', '2026-11-21T02:00:00Z']
    ])
  })

  it('names an untitled event "Busy"', () => {
    const r = parseLinkedCalendar(
      calendar('UID:x\nDTSTART:20261124T090000Z\nDTEND:20261124T100000Z'),
      WINDOW
    )
    expect(r.events[0].title).toBe('Busy')
  })
})

describe('eventsInRange', () => {
  const events = parseLinkedCalendar(
    calendar(
      'UID:a\nDTSTART:20261124T090000Z\nDTEND:20261124T100000Z\nSUMMARY:A',
      'UID:b\nDTSTART;VALUE=DATE:20261125\nDTEND;VALUE=DATE:20261126\nSUMMARY:B'
    ),
    WINDOW
  ).events

  it('picks the timed and all-day events that touch a week', () => {
    const week = eventsInRange(events, '2026-11-23T00:00:00Z', '2026-11-30T00:00:00Z')
    expect(week.map((e) => e.title)).toEqual(['A', 'B'])
  })

  it('leaves out the ones before or after', () => {
    expect(eventsInRange(events, '2026-11-30T00:00:00Z', '2026-12-07T00:00:00Z')).toEqual([])
    expect(eventsInRange(events, '2026-11-16T00:00:00Z', '2026-11-23T00:00:00Z')).toEqual([])
  })
})
