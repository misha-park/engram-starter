import { describe, expect, it } from 'vitest'
import {
  datesMatch,
  matchLectureList,
  validCuts,
  type ListedLecture,
  type TimetabledLecture
} from './lecture-list'

// Autumn 2026 (GMT from 25 Oct): London time = UTC in November, BST (UTC+1) in early October.
let n = 0
const lec = (start: string, end: string): TimetabledLecture => ({
  id: `l${++n}`,
  number: n,
  start,
  end
})
const listed = (
  title: string,
  date: string | null,
  start: string,
  end: string,
  weekday: number | null = null
): ListedLecture => ({ title, date, weekday, start, end })

const summary = (m: ReturnType<typeof matchLectureList>) =>
  m.proposals.map((p) => [p.number, p.parts.map((x) => x.title), p.cuts, p.confidence])

describe('valid cuts', () => {
  it('needs parts of at least 15 minutes, in order', () => {
    expect(validCuts([60], 120)).toBe(true)
    expect(validCuts([30, 80], 90)).toBe(false)
    expect(validCuts([30, 60], 120)).toBe(true)
    expect(validCuts([10], 120)).toBe(false)
    expect(validCuts([], 120)).toBe(false)
    expect(validCuts([60, 45], 120)).toBe(false)
  })
})

describe('matching a lecture list by date (this year’s list)', () => {
  it('splits a 2-hour event holding two lectures, leaves a 2-hour lecture whole', () => {
    n = 0
    const tt = [
      lec('2026-11-17T11:00:00Z', '2026-11-17T13:00:00Z'), // Tue 11–13  Intro I + Intro II
      lec('2026-11-19T09:00:00Z', '2026-11-19T11:00:00Z'), // Thu 09–11  The hypothalamus
      lec('2026-11-24T11:00:00Z', '2026-11-24T12:00:00Z') //  Tue 11–12  Limbic system
    ]
    const list = [
      listed('Intro I', '2026-11-17', '11:00', '12:00'),
      listed('Intro II', '2026-11-17', '12:00', '13:00'),
      listed('The hypothalamus', '2026-11-19', '09:00', '11:00'),
      listed('Limbic system', '2026-11-24', '11:00', '12:00'),
      listed('Not in the timetable', '2026-11-26', '11:00', '12:00')
    ]
    expect(datesMatch(list, tt)).toBe(true)
    const m = matchLectureList(list, tt)
    expect(m.method).toBe('dates')
    expect(summary(m)).toEqual([[1, ['Intro I', 'Intro II'], [60], 'sure']])
    expect(m.unmatched).toBe(1)
  })

  it('flags a split to check when the parts don’t fill the event', () => {
    n = 0
    const tt = [
      lec('2026-11-17T11:00:00Z', '2026-11-17T13:00:00Z'),
      lec('2026-11-18T11:00:00Z', '2026-11-18T12:00:00Z'),
      lec('2026-11-19T11:00:00Z', '2026-11-19T12:00:00Z')
    ]
    const list = [
      listed('A', '2026-11-17', '11:00', '11:50'),
      listed('B', '2026-11-17', '12:00', '12:50'),
      listed('C', '2026-11-18', '11:00', '12:00'),
      listed('D', '2026-11-19', '11:00', '12:00')
    ]
    expect(summary(matchLectureList(list, tt))).toEqual([[1, ['A', 'B'], [60], 'check']])
  })
})

describe('matching by order (last year’s booklet, same order)', () => {
  it('fills each timetabled lecture with back-to-back listed lectures', () => {
    n = 0
    // This year: Wed 11–13, Fri 10–11, Wed 11–13, Fri 10–11.
    const tt = [
      lec('2026-11-11T11:00:00Z', '2026-11-11T13:00:00Z'),
      lec('2026-11-13T10:00:00Z', '2026-11-13T11:00:00Z'),
      lec('2026-11-18T11:00:00Z', '2026-11-18T13:00:00Z'),
      lec('2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z')
    ]
    const list = [
      listed('Intro to neural networks', '2025-10-15', '11:00', '13:00', 3),
      listed('Intro, cont.', '2025-10-17', '10:00', '11:00', 5),
      listed('Supervised learning', '2025-10-22', '11:00', '12:00', 3),
      listed('Unsupervised learning', '2025-10-22', '12:00', '13:00', 3),
      listed('Reinforcement learning', '2025-10-24', '10:00', '11:00', 5)
    ]
    expect(datesMatch(list, tt)).toBe(false)
    const m = matchLectureList(list, tt)
    expect(m.method).toBe('order')
    expect(summary(m)).toEqual([
      [3, ['Supervised learning', 'Unsupervised learning'], [60], 'sure']
    ])
    expect(m.unmatched).toBe(0)
  })

  it('flags a split to check when the day or time doesn’t line up', () => {
    n = 0
    const tt = [lec('2026-11-11T14:00:00Z', '2026-11-11T16:00:00Z')]
    const m = matchLectureList(
      [listed('One', null, '11:00', '12:00', 2), listed('Two', null, '12:00', '13:00', 2)],
      tt
    )
    expect(summary(m)).toEqual([[1, ['One', 'Two'], [60], 'check']])
  })

  it('skips workshops and practicals, so they don’t shift the list', () => {
    n = 0
    const tt = [
      lec('2026-11-11T11:00:00Z', '2026-11-11T12:00:00Z'),
      { ...lec('2026-11-12T14:00:00Z', '2026-11-12T16:00:00Z'), kind: 'workshop' as const },
      lec('2026-11-18T11:00:00Z', '2026-11-18T13:00:00Z')
    ]
    const list = [
      listed('Ion channels', null, '11:00', '12:00'),
      listed('Synapses I', null, '11:00', '12:00'),
      listed('Synapses II', null, '12:00', '13:00')
    ]
    const m = matchLectureList(list, tt)
    expect(m.titled.map((x) => [x.number, x.title])).toEqual([[1, 'Ion channels']])
    expect(summary(m)).toEqual([[3, ['Synapses I', 'Synapses II'], [60], 'sure']])
    expect(m.unmatched).toBe(0)
  })

  it('never joins listed lectures across a gap or a day, and counts what’s left over', () => {
    n = 0
    const tt = [lec('2026-11-11T11:00:00Z', '2026-11-11T13:00:00Z')]
    const m = matchLectureList(
      [
        listed('Morning', null, '11:00', '12:00', 3),
        listed('Afternoon', null, '14:00', '15:00', 3),
        listed('Extra', null, '10:00', '11:00', 4)
      ],
      tt
    )
    expect(m.proposals).toEqual([])
    expect(m.unmatched).toBe(2)
  })
})
