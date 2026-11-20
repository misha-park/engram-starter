import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { initialPlannedEnd, timerPhase } from './timer'
import { unbrokenMinutes, workedTodayMinutes } from './totals'
import { safeName, sessionEntry } from './records'
import { debriefPrompt } from './prompts'

const at = (iso: string) => Temporal.Instant.from(iso)

describe('timerPhase', () => {
  const planned = '2026-11-18T12:30:00Z'
  it('runs until the planned end', () =>
    expect(timerPhase(planned, at('2026-11-18T12:29:00Z'))).toBe('running'))
  it('prompts from the planned end', () =>
    expect(timerPhase(planned, at('2026-11-18T12:30:00Z'))).toBe('prompt'))
  it('times out after 10 minutes without an answer', () => {
    expect(timerPhase(planned, at('2026-11-18T12:39:59Z'))).toBe('prompt')
    expect(timerPhase(planned, at('2026-11-18T12:40:00Z'))).toBe('timed-out')
  })
})

describe('initialPlannedEnd', () => {
  const block = { start: '2026-11-18T11:00:00Z', end: '2026-11-18T12:30:00Z' }
  it('uses the block end when starting on time or a bit late', () => {
    expect(initialPlannedEnd(block, at('2026-11-18T11:20:00Z'))).toBe(block.end)
  })
  it('gives the full planned length when starting after the block (nearly) ended', () => {
    expect(initialPlannedEnd(block, at('2026-11-18T14:00:00Z'))).toBe('2026-11-18T15:30:00Z')
  })
})

describe('workedTodayMinutes / unbrokenMinutes', () => {
  const now = at('2026-11-18T15:00:00Z')
  const sessions = [
    { start: '2026-11-17T22:00:00Z', end: '2026-11-18T00:30:00Z' }, // 30 min today
    { start: '2026-11-18T10:00:00Z', end: '2026-11-18T11:00:00Z' }, // 60, then a long break
    { start: '2026-11-18T13:00:00Z', end: '2026-11-18T14:00:00Z' }, // 60, 5-min pause
    { start: '2026-11-18T14:05:00Z', end: null } // running: 55
  ]
  it('sums today across midnight and the running timer', () => {
    expect(workedTodayMinutes(sessions, now)).toBe(30 + 60 + 60 + 55)
  })
  it('counts continuous work through short pauses only', () => {
    expect(unbrokenMinutes(sessions, now)).toBe(120)
  })
  it('is zero when no timer is running', () => {
    expect(unbrokenMinutes(sessions.slice(0, 3), now)).toBe(0)
  })
})

describe('record formatting', () => {
  it('writes a done session with its note', () => {
    const md = sessionEntry({
      start: '2026-11-18T11:00:00Z',
      end: '2026-11-18T12:25:00Z',
      minutes: 85,
      outcome: 'done',
      blockTitle: 'NEUR L7 write-up',
      planned: { start: '2026-11-18T11:00:00Z', end: '2026-11-18T12:30:00Z' },
      note: 'Figures redrawn'
    })
    expect(md).toContain('## Wed, 18 Nov 2026 · 11:00–12:25 · 1h 25m · Done')
    expect(md).toContain('Block: NEUR L7 write-up (planned 11:00–12:30)')
    expect(md).toContain('Note: Figures redrawn')
  })
  it('writes a partial debrief and a skipped block', () => {
    const partial = sessionEntry({
      start: '2026-11-18T11:00:00Z',
      end: '2026-11-18T11:45:00Z',
      minutes: 45,
      outcome: 'partial',
      debrief: 'Covered slides 1–20. Left: 21–40.'
    })
    expect(partial).toContain('**Debrief**\n\nCovered slides 1–20. Left: 21–40.')
    expect(
      sessionEntry({ start: '2026-11-18T11:00:00Z', end: null, minutes: 0, outcome: 'skipped' })
    ).toContain('· Skipped')
  })
  it('safeName', () => {
    expect(safeName('a/b: c?')).toBe('a-b- c-')
  })
  it('debriefPrompt gives the revision chat the session context', () => {
    const prompt = debriefPrompt({
      title: 'NEUR L7 write-up',
      categoryName: 'Cellular Neurophysiology',
      start: '2026-11-18T11:00:00Z',
      end: '2026-11-18T12:30:00Z',
      minutes: 45
    })
    expect(prompt).toContain('NEUR L7 write-up (Cellular Neurophysiology), Wed 18 Nov 11:00–12:30')
    expect(prompt).toContain('about 45m of work')
    expect(prompt).toContain("what's left to do next time")
  })
})
