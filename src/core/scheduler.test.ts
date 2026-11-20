import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import type { AvailabilitySettings } from '../shared/types'
import { fromLegacy } from './availability'
import {
  findSlot,
  firstFit,
  freeIntervals,
  placeNextWeek,
  placeWriteUp,
  snapUp,
  writeUpLimit,
  type Interval
} from './scheduler'
import { localRange, toIso } from './time'

const av: AvailabilitySettings = fromLegacy({
  noWorkBefore: '09:00',
  workingHoursEnd: '22:00',
  protectedEvenings: [5], // Friday
  protectedEveningFrom: '18:00'
})

/** A local-time interval on a date, as UTC ISO strings. */
const at = (date: string, start: string, end: string): Interval => {
  const r = localRange(date, start, end)
  return { start: toIso(r.start), end: toIso(r.end) }
}
/** Fill a whole local day (00:00–00:00) so nothing fits. */
const fullDay = (date: string): Interval => at(date, '00:00', '00:00')

// Week of Mon 16 Nov 2026 (GMT, so UTC = local).
const MON = '2026-11-16'
const TUE = '2026-11-17'
const WED = '2026-11-18'
const THU = '2026-11-19'
const FRI = '2026-11-20'

describe('snapUp', () => {
  it('rounds up to the next quarter hour', () => {
    expect(toIso(snapUp(Temporal.Instant.from('2026-11-16T10:01:00Z')))).toBe(
      '2026-11-16T10:15:00Z'
    )
    expect(toIso(snapUp(Temporal.Instant.from('2026-11-16T10:15:00Z')))).toBe(
      '2026-11-16T10:15:00Z'
    )
  })
})

describe('freeIntervals', () => {
  it('returns gaps between busy intervals, merging overlaps', () => {
    const gaps = freeIntervals(at(MON, '09:00', '18:00'), [
      at(MON, '10:00', '11:00'),
      at(MON, '10:30', '12:00'),
      at(MON, '14:00', '15:00')
    ])
    expect(gaps).toEqual([
      at(MON, '09:00', '10:00'),
      at(MON, '12:00', '14:00'),
      at(MON, '15:00', '18:00')
    ])
  })

  it('snaps gap starts after a busy block that ends off-grid', () => {
    const gaps = freeIntervals(at(MON, '09:00', '12:00'), [at(MON, '09:00', '10:05')])
    expect(gaps).toEqual([at(MON, '10:15', '12:00')])
  })

  it('ignores busy time outside the range and returns nothing for a full range', () => {
    expect(freeIntervals(at(MON, '09:00', '10:00'), [at(TUE, '09:00', '10:00')])).toEqual([
      at(MON, '09:00', '10:00')
    ])
    expect(freeIntervals(at(MON, '09:00', '10:00'), [at(MON, '08:00', '11:00')])).toEqual([])
  })
})

describe('firstFit', () => {
  it('skips gaps that are too short', () => {
    const fit = firstFit(at(MON, '09:00', '18:00'), 90, [
      at(MON, '10:00', '12:00'),
      at(MON, '13:00', '17:00')
    ])
    expect(fit).toBeNull() // the 12:00–13:00 and 17:00–18:00 gaps are only 60 min
  })

  it('returns the earliest fitting slot', () => {
    expect(firstFit(at(MON, '09:00', '18:00'), 90, [at(MON, '09:30', '12:00')])).toEqual(
      at(MON, '12:00', '13:30')
    )
  })
})

describe('findSlot', () => {
  it('stays inside availability and respects protected evenings', () => {
    // Friday: available 09:00–18:00 only; 09:00–17:00 busy → 60 min fits, 90 doesn't
    const busy = [at(FRI, '09:00', '17:00')]
    const from = at(FRI, '00:00', '01:00').start
    const fridayOnly = { from, until: at(FRI, '00:00', '00:00').end, busy, availability: av }
    expect(findSlot({ ...fridayOnly, durationMinutes: 60 })).toEqual({
      ...at(FRI, '17:00', '18:00'),
      withinAvailability: true
    })
    // 90 min doesn't fit before 18:00: it runs into the protected evening (flagged), but never
    // starts before "no work before" even though 07:00–09:00 is free
    expect(findSlot({ ...fridayOnly, durationMinutes: 90 })).toEqual({
      ...at(FRI, '17:00', '18:30'),
      withinAvailability: false
    })
  })

  it('never starts before noWorkBefore', () => {
    const slot = findSlot({
      from: at(MON, '06:00', '07:00').start,
      until: at(MON, '00:00', '00:00').end,
      durationMinutes: 60,
      busy: [],
      availability: av
    })
    expect(slot?.start).toBe(at(MON, '09:00', '10:00').start)
  })

  it('returns null when every day is completely full', () => {
    expect(
      findSlot({
        from: at(MON, '00:00', '01:00').start,
        until: at(MON, '00:00', '00:00').end,
        durationMinutes: 30,
        busy: [fullDay(MON)],
        availability: av
      })
    ).toBeNull()
  })

  it('is deterministic', () => {
    const args = {
      from: at(MON, '10:00', '11:00').start,
      until: at(THU, '00:00', '00:00').start,
      durationMinutes: 90,
      busy: [at(MON, '12:00', '13:00')],
      availability: av
    }
    expect(findSlot(args)).toEqual(findSlot(args))
  })
})

describe('placeWriteUp', () => {
  const lecture = at(MON, '10:00', '11:00')

  it('goes on the same day, straight after the lecture, when free', () => {
    const slot = placeWriteUp({
      lectureEnd: lecture.end,
      durationMinutes: 90,
      busy: [lecture],
      availability: av
    })
    expect(slot).toEqual({ ...at(MON, '11:00', '12:30'), withinAvailability: true })
  })

  it('works around other commitments the same day', () => {
    const busy = [lecture, at(MON, '11:00', '13:00'), at(MON, '14:00', '16:00')]
    const slot = placeWriteUp({
      lectureEnd: lecture.end,
      durationMinutes: 90,
      busy,
      availability: av
    })
    expect(slot).toEqual({ ...at(MON, '16:00', '17:30'), withinAvailability: true })
  })

  it('moves to the next day when the lecture day is full', () => {
    const busy = [lecture, at(MON, '11:00', '22:00'), at(TUE, '09:00', '10:00')]
    const slot = placeWriteUp({
      lectureEnd: lecture.end,
      durationMinutes: 90,
      busy,
      availability: av
    })
    expect(slot).toEqual({ ...at(TUE, '10:00', '11:30'), withinAvailability: true })
  })

  it('never goes later than 3 days after the lecture', () => {
    // Mon–Thu are full inside availability; Friday would be free but is too late.
    const busy = [MON, TUE, WED, THU].map((d) => at(d, '09:00', '22:00'))
    const slot = placeWriteUp({
      lectureEnd: lecture.end,
      durationMinutes: 90,
      busy,
      availability: av
    })
    expect(slot?.withinAvailability).toBe(false)
    expect(slot!.start < at(FRI, '00:00', '01:00').start).toBe(true)
    // Fallback is the earliest least-bad slot: Monday evening after 22:00.
    expect(slot).toEqual({ ...at(MON, '22:00', '23:30'), withinAvailability: false })
  })

  it('returns null when the whole window is genuinely full', () => {
    const busy = [MON, TUE, WED, THU].map(fullDay)
    expect(
      placeWriteUp({ lectureEnd: lecture.end, durationMinutes: 90, busy, availability: av })
    ).toBeNull()
  })

  it('does not place into the past when the window is still open', () => {
    const now = at(MON, '15:07', '16:00').start
    const slot = placeWriteUp({
      lectureEnd: lecture.end,
      durationMinutes: 90,
      busy: [lecture],
      availability: av,
      now
    })
    expect(slot).toEqual({ ...at(MON, '15:15', '16:45'), withinAvailability: true })
  })

  it('places historically when the whole window is already over', () => {
    const now = at(FRI, '12:00', '13:00').start
    const slot = placeWriteUp({
      lectureEnd: lecture.end,
      durationMinutes: 90,
      busy: [lecture],
      availability: av,
      now
    })
    expect(slot?.start).toBe(at(MON, '11:00', '12:30').start)
  })

  it('treats the pub shift (17:00–00:00) as busy', () => {
    const SAT = '2026-11-21'
    const satLecture = at(SAT, '15:00', '16:00')
    const busy = [satLecture, at(SAT, '17:00', '00:00')]
    const slot = placeWriteUp({
      lectureEnd: satLecture.end,
      durationMinutes: 90,
      busy,
      availability: av
    })
    expect(slot).toEqual({ ...at('2026-11-22', '09:00', '10:30'), withinAvailability: true })
  })

  it('uses local wall-clock time across the clock change', () => {
    // Sunday 25 Oct 2026: clocks go back. A 09:00 local start is 09:00Z (GMT).
    const sunLecture = at('2026-10-24', '20:00', '21:00') // Saturday evening, BST
    const busy = [sunLecture, at('2026-10-24', '21:00', '22:00')]
    const slot = placeWriteUp({
      lectureEnd: sunLecture.end,
      durationMinutes: 60,
      busy,
      availability: av
    })
    expect(slot).toEqual({ ...at('2026-10-25', '09:00', '10:00'), withinAvailability: true })
    expect(slot!.start).toBe('2026-10-25T09:00:00Z')
  })

  it('places a sequence of lectures without overlapping (callers add each placement to busy)', () => {
    const busy: Interval[] = [lecture]
    const placed: Interval[] = []
    for (const lec of [lecture, at(MON, '11:00', '12:00')]) {
      busy.push(lec)
      const slot = placeWriteUp({
        lectureEnd: lec.end,
        durationMinutes: 90,
        busy,
        availability: av
      })!
      busy.push(slot)
      placed.push(slot)
    }
    expect(placed[0].end <= placed[1].start || placed[1].end <= placed[0].start).toBe(true)
  })
})

describe('the write-up limit (3 working days)', () => {
  // November 2026: London time = UTC. Mon 16, Wed 18, Thu 19, Fri 20, Mon 23.
  const limit = (lectureEnd: string) => writeUpLimit(lectureEnd).toString()
  it('skips the weekend, so the Monday after counts', () => {
    expect(limit('2026-11-16T11:00:00Z')).toBe('2026-11-20T00:00:00Z') // Mon → end of Thu
    expect(limit('2026-11-18T11:00:00Z')).toBe('2026-11-24T00:00:00Z') // Wed → end of Mon
    expect(limit('2026-11-19T11:00:00Z')).toBe('2026-11-25T00:00:00Z') // Thu → end of Tue
    expect(limit('2026-11-20T11:00:00Z')).toBe('2026-11-26T00:00:00Z') // Fri → end of Wed
    expect(limit('2026-11-21T11:00:00Z')).toBe('2026-11-26T00:00:00Z') // Sat → end of Wed
  })
})

describe('placeNextWeek', () => {
  const block = at(TUE, '14:00', '15:30')
  const now = at(MON, '08:00', '08:00').start
  const NEXT_MON = '2026-11-23'
  const NEXT_TUE = '2026-11-24'

  it('keeps the same day and time when that slot is free', () => {
    const slot = placeNextWeek({ ...block, busy: [], availability: av, now })
    expect(slot).toEqual({
      ...at(NEXT_TUE, '14:00', '15:30'),
      withinAvailability: true,
      sameTime: true
    })
  })

  it('takes the first free slot of next week when the same time is taken', () => {
    const busy = [at(NEXT_TUE, '15:00', '16:00'), at(NEXT_MON, '09:00', '22:00')]
    const slot = placeNextWeek({ ...block, busy, availability: av, now })
    expect(slot).toEqual({
      ...at(NEXT_TUE, '09:00', '10:30'),
      withinAvailability: true,
      sameTime: false
    })
  })

  it('never starts before "no work before", even when it has to go outside availability', () => {
    // Every working day of next week (09:00–22:00) is taken, so it runs into the evening.
    const busy = ['23', '24', '25', '26', '27', '28', '29'].map((d) =>
      at(`2026-11-${d}`, '09:00', '22:00')
    )
    const slot = placeNextWeek({ ...block, busy, availability: av, now })
    expect(slot).toEqual({
      ...at(NEXT_MON, '22:00', '23:30'),
      withinAvailability: false,
      sameTime: false
    })
    expect(slot!.start >= at(NEXT_MON, '09:00', '09:00').start).toBe(true)
  })

  it('returns null when next week is completely full', () => {
    const busy = ['23', '24', '25', '26', '27', '28', '29'].map((d) => fullDay(`2026-11-${d}`))
    expect(placeNextWeek({ ...block, busy, availability: av, now })).toBeNull()
  })

  it('respects a write-up limit: same time only if it ends in time', () => {
    const limit = at(NEXT_TUE, '12:00', '12:00').start
    const slot = placeNextWeek({ ...block, busy: [], availability: av, now, limit })
    expect(slot).toEqual({
      ...at(NEXT_MON, '09:00', '10:30'),
      withinAvailability: true,
      sameTime: false
    })
  })

  it('returns null when the limit is before next week', () => {
    const limit = writeUpLimit(at(MON, '10:00', '11:00').end) // end of Thursday this week
    const slot = placeNextWeek({ ...block, busy: [], availability: av, now, limit: toIso(limit) })
    expect(slot).toBeNull()
  })
})
