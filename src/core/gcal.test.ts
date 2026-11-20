import { describe, expect, it } from 'vitest'
import type { Block, Deadline } from '../shared/types'
import {
  blockEvent,
  deadlineEvent,
  eventHash,
  nearestColour,
  planPush,
  type PushedEvent
} from './gcal'

const block = (over: Partial<Block> = {}): Block => ({
  id: 'b1',
  kind: 'flexible',
  type: 'write-up',
  title: 'PHYS L7 write-up',
  start: '2026-11-19T18:00:00Z',
  end: '2026-11-19T19:00:00Z',
  categoryId: 'phys',
  linkedType: null,
  linkedId: null,
  source: 'auto',
  outcome: 'none',
  recurrenceId: null,
  occurrenceDate: null,
  debriefPending: false,
  detached: false,
  attention: null,
  notes: null,
  colour: null,
  ...over
})

describe('blocks and deadlines as Google events', () => {
  it('uses London local time, a tick for done work, and no event for skipped work', () => {
    const e = blockEvent(
      block({ start: '2026-07-01T09:00:00Z', end: '2026-07-01T10:00:00Z' }),
      '#d9a33f'
    )!
    expect(e.start).toEqual({ dateTime: '2026-07-01T10:00:00', timeZone: 'Europe/London' })
    expect(e.key).toBe('block:b1')
    expect(e.summary).toBe('PHYS L7 write-up')
    expect(blockEvent(block({ outcome: 'done' }), null)!.summary).toBe('✓ PHYS L7 write-up')
    expect(blockEvent(block({ outcome: 'skipped' }), null)).toBeNull()
  })

  it('makes a deadline an all-day event with its time in the description', () => {
    const d: Deadline = {
      id: 'a1',
      title: 'Ion channels essay',
      at: '2026-11-30T12:00:00Z',
      categoryId: 'neur',
      kind: 'assignment'
    }
    const e = deadlineEvent(d, null)
    expect(e.start).toEqual({ date: '2026-11-30' })
    expect(e.end).toEqual({ date: '2026-12-01' })
    expect(e.description).toContain('12:00')
  })

  it('maps colours to the nearest of Google’s eleven', () => {
    expect(nearestColour('#d50000')).toBe('11')
    expect(nearestColour('#e8807a')).toBe('4')
    expect(nearestColour('#33b679')).toBe('2')
    expect(nearestColour(null)).toBeNull()
    expect(nearestColour('teal')).toBeNull()
  })
})

describe('planning a push', () => {
  const a = blockEvent(block(), null)!
  const b = blockEvent(block({ id: 'b2', title: 'Pub shift', kind: 'fixed' }), null)!
  const pushed = (e: typeof a, eventId: string, hash = eventHash(e)): PushedEvent => ({
    key: e.key,
    eventId,
    hash,
    start: 'dateTime' in e.start ? e.start.dateTime : e.start.date
  })

  it('inserts new events, updates changed ones and leaves the rest', () => {
    const plan = planPush([a, b], [pushed(a, 'g1', 'stale')], '2026-11-01')
    expect(plan.insert.map((e) => e.key)).toEqual(['block:b2'])
    expect(plan.update).toEqual([{ eventId: 'g1', event: a }])
    expect(plan.remove).toEqual([])
    expect(planPush([a], [pushed(a, 'g1')], '2026-11-01')).toEqual({
      insert: [],
      update: [],
      remove: []
    })
  })

  it('removes events that are gone, but only inside the window', () => {
    const old = { key: 'block:old', eventId: 'g9', hash: 'x', start: '2026-10-01T09:00:00' }
    const gone = pushed(b, 'g2')
    const plan = planPush([a], [pushed(a, 'g1'), gone, old], '2026-11-01')
    expect(plan.remove).toEqual([gone])
  })
})
