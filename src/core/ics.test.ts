import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { collapseRepeatedName, mapEventType, parseSummary, parseTimetable } from './ics'

const sample = readFileSync(resolve(__dirname, '../../resources/fixtures/ucl-sample.ics'), 'utf8')
const window = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-12-31T00:00:00Z') }
const parsed = parseTimetable(sample, window)
const byUid = (uid: string) => parsed.events.find((e) => e.uid === uid)

describe('parseSummary', () => {
  it('splits module, level and bracketed type', () => {
    expect(parseSummary('Cellular Neurophysiology Level 6 [Lecture]')).toEqual({
      moduleName: 'Cellular Neurophysiology',
      level: 6,
      feedType: 'Lecture'
    })
  })
  it('handles multi-word types and missing levels', () => {
    expect(parseSummary('X Level 5 [Problem Based Learning]')?.feedType).toBe(
      'Problem Based Learning'
    )
    expect(parseSummary('Some Module [Workshop]')).toEqual({
      moduleName: 'Some Module',
      level: null,
      feedType: 'Workshop'
    })
  })
  it('returns null without a bracketed type', () => {
    expect(parseSummary('Departmental seminar')).toBeNull()
  })
})

describe('collapseRepeatedName', () => {
  it('collapses a name repeated for each cross-listing', () => {
    expect(collapseRepeatedName('A, A, A')).toBe('A')
    expect(collapseRepeatedName('Methods in X, Y and Z, Methods in X, Y and Z')).toBe(
      'Methods in X, Y and Z'
    )
  })
  it('keeps names with commas and genuine lists of different names', () => {
    expect(collapseRepeatedName('Methods in X, Y and Z')).toBe('Methods in X, Y and Z')
    expect(collapseRepeatedName('P in A, P in B, P in C')).toBe('P in A, P in B, P in C')
  })
})

it('mapEventType covers the feed types', () => {
  expect(mapEventType('Problem Based Learning')).toBe('pbl')
  expect(mapEventType('VIVA')).toBe('viva')
  expect(mapEventType('None')).toBeNull()
  expect(mapEventType('Field trip')).toBe('other')
})

describe('parseTimetable (fake UCL fixture)', () => {
  it('reads a TZID local time as the right UTC instant', () => {
    expect(byUid('fake-0001@timetable.example')).toMatchObject({
      start: '2026-11-16T10:00:00Z',
      end: '2026-11-16T11:00:00Z',
      moduleName: 'Cellular Neurophysiology',
      level: 6,
      type: 'lecture'
    })
  })

  it('takes the type from the bracket even when CATEGORIES is None', () => {
    expect(byUid('fake-0002@timetable.example')?.type).toBe('practical')
  })

  it('keeps cross-listed names as written (merging happens later)', () => {
    expect(byUid('fake-0003@timetable.example')?.moduleName).toBe('Neuroscience Research Project')
    expect(byUid('fake-0004@timetable.example')?.moduleName).toBe('Pharmacology Research Project')
  })

  it('marks [None] events with a null type', () => {
    expect(byUid('fake-0005@timetable.example')?.type).toBeNull()
  })

  it('skips cancelled events and summaries it cannot read', () => {
    expect(byUid('fake-0006@timetable.example')).toBeUndefined()
    expect(parsed.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['cancelled', expect.stringContaining('format')])
    )
  })

  it('expands weekly recurrences, honouring EXDATE, with stable instance uids', () => {
    const instances = parsed.events.filter((e) => e.uid.startsWith('fake-0008'))
    expect(instances.map((e) => e.start)).toEqual(['2026-10-20T10:00:00Z', '2026-11-03T11:00:00Z'])
    expect(instances[0].uid).toBe('fake-0008@timetable.example#2026-10-20T10:00:00Z')
  })

  it('handles BST dates and future vivas', () => {
    expect(byUid('fake-0010@timetable.example')?.start).toBe('2026-06-23T08:30:00Z')
    expect(byUid('fake-0009@timetable.example')?.type).toBe('viva')
  })

  it('unescapes commas and collapses repeated cross-listed names (as in the real feed)', () => {
    expect(byUid('fake-0011@timetable.example')?.moduleName).toBe('Foundations of Testing')
    expect(byUid('fake-0012@timetable.example')?.moduleName).toBe(
      'Methods in Alpha, Beta and Gamma'
    )
    expect(byUid('fake-0013@timetable.example')?.moduleName).toBe(
      'Big Project in Alpha, Big Project in Beta, Big Project in Gamma'
    )
  })

  it('returns events sorted by start', () => {
    const starts = parsed.events.map((e) => e.start)
    expect([...starts].sort()).toEqual(starts)
  })
})
