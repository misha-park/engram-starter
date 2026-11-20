import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { dueIn, dueOn } from './due'

const at = (iso: string) => Temporal.Instant.from(iso)

describe('dueIn', () => {
  it('counts London days and names the near ones', () => {
    const now = at('2026-11-19T10:00:00Z')
    expect(dueIn('2026-11-19T17:00:00Z', now)).toMatchObject({
      days: 0,
      label: 'Today',
      late: false,
      urgency: 'soon'
    })
    expect(dueIn('2026-11-20T09:00:00Z', now)).toMatchObject({ days: 1, label: 'Tomorrow' })
    expect(dueIn('2026-11-25T12:00:00Z', now)).toMatchObject({
      days: 6,
      label: '6 days',
      urgency: 'near'
    })
    expect(dueIn('2026-12-10T12:00:00Z', now)).toMatchObject({ days: 21, urgency: 'far' })
  })

  it('is late once the due time has passed, even on the same day', () => {
    const now = at('2026-11-19T15:00:00Z')
    expect(dueIn('2026-11-19T09:00:00Z', now)).toMatchObject({
      days: 0,
      late: true,
      label: 'Late',
      urgency: 'late'
    })
    expect(dueIn('2026-11-17T12:00:00Z', now)).toMatchObject({
      days: -2,
      late: true,
      label: '2d late'
    })
  })

  it('uses London dates across midnight in summer time', () => {
    // 23:30 UTC on 1 June is 00:30 on 2 June in London.
    expect(dueIn('2026-06-01T23:30:00Z', at('2026-06-01T12:00:00Z')).days).toBe(1)
  })
})

describe('dueOn', () => {
  it('is only late once the day has gone', () => {
    const today = Temporal.PlainDate.from('2026-11-19')
    expect(dueOn(Temporal.PlainDate.from('2026-11-19'), today)).toMatchObject({
      late: false,
      label: 'Today'
    })
    expect(dueOn(Temporal.PlainDate.from('2026-11-18'), today)).toMatchObject({
      late: true,
      label: '1d late'
    })
  })
})
