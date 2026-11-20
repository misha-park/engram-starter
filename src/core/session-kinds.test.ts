import { describe, expect, it } from 'vitest'
import { guessKind, kindOf, sessionLabels, sessionLine } from './session-kinds'

describe('guessKind', () => {
  it('reads workshops, practicals and other sessions from Investigative Methods names', () => {
    const names: [string, string][] = [
      ['Ephys WS1', 'workshop'],
      ['Critical Analysis WS5', 'workshop'],
      ['Molecular Techniques II WS7', 'workshop'],
      ['Data analysis workshop', 'workshop'],
      ['Parkinsons Prac', 'practical'],
      ['INV Practical', 'practical'],
      ['Intro/Q&A', 'other'],
      ['Stats & Analysis Support', 'other'],
      ['General Support Session', 'other'],
      ['Revision session', 'other'],
      ['LVs', 'other'],
      ['LV presentations', 'other'],
      ['Ion channels', 'lecture'],
      ['Introduction to synaptic transmission', 'lecture'],
      ['Practically speaking', 'lecture']
    ]
    for (const [name, kind] of names) expect([name, guessKind(name)]).toEqual([name, kind])
  })

  it('treats an unnamed session as a lecture', () => {
    expect(guessKind(null)).toBe('lecture')
    expect(guessKind('  ')).toBe('lecture')
  })

  it('prefers what the user set', () => {
    expect(kindOf('lecture', 'Ephys WS1')).toBe('lecture')
    expect(kindOf(null, 'Ephys WS1')).toBe('workshop')
  })
})

describe('sessionLabels', () => {
  it('numbers each kind on its own, in time order, and gives other sessions none', () => {
    const labels = sessionLabels([
      { id: 'b', start: '2026-10-08T10:00:00Z', kind: 'workshop' },
      { id: 'a', start: '2026-10-01T10:00:00Z', kind: 'other' },
      { id: 'c', start: '2026-10-15T10:00:00Z', kind: 'workshop' },
      { id: 'd', start: '2026-10-16T10:00:00Z', kind: 'lecture' },
      { id: 'e', start: '2026-11-05T14:00:00Z', kind: 'practical' }
    ])
    expect(Object.fromEntries(labels)).toEqual({ a: '', b: 'WS1', c: 'WS2', d: 'L1', e: 'P1' })
  })

  it('gives a later session of one lecture its first session’s label, uncounted', () => {
    const labels = sessionLabels([
      { id: 'a', start: '2026-10-01T10:00:00Z', kind: 'lecture' },
      { id: 'b', start: '2026-10-02T10:00:00Z', kind: 'lecture', rootId: 'a' },
      { id: 'c', start: '2026-10-03T10:00:00Z', kind: 'lecture' }
    ])
    expect(Object.fromEntries(labels)).toEqual({ a: 'L1', b: 'L1', c: 'L2' })
  })
})

describe('sessionLine', () => {
  it('shows the label and name, or just the name for an other session', () => {
    expect(sessionLine('WS1', 'Ephys WS1')).toBe('WS1. Ephys WS1')
    expect(sessionLine('L12', null)).toBe('L12')
    expect(sessionLine('L3', 'Ion channels', 2)).toBe('L3 (part 2). Ion channels')
    expect(sessionLine('', 'Revision session')).toBe('Revision session')
    expect(sessionLine('', null)).toBe('Session')
  })
})
