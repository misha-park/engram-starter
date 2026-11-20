import { describe, expect, it } from 'vitest'
import { copiedIntoEngram } from './linked-events'

describe('copiedIntoEngram', () => {
  const timed = {
    title: 'Dentist',
    allDay: false,
    start: '2026-11-24T14:00:00Z',
    end: '2026-11-24T15:00:00Z'
  }
  const block = (title: string, start: string, end: string) => ({ title, start, end })

  it('is true for a block with the same name that overlaps it', () => {
    expect(
      copiedIntoEngram(timed, [block(' dentist ', '2026-11-24T14:30:00Z', '2026-11-24T15:30:00Z')])
    ).toBe(true)
  })

  it('is true when one name holds the other', () => {
    expect(
      copiedIntoEngram(timed, [
        block('Dentist (Dr Lee)', '2026-11-24T14:00:00Z', '2026-11-24T15:00:00Z')
      ])
    ).toBe(true)
  })

  it('is false for the same time with a different name: that clash is worth seeing', () => {
    expect(
      copiedIntoEngram(timed, [block('Lecture L4', '2026-11-24T14:00:00Z', '2026-11-24T15:00:00Z')])
    ).toBe(false)
  })

  it('is false for the same name at another time', () => {
    expect(
      copiedIntoEngram(timed, [block('Dentist', '2026-11-24T16:00:00Z', '2026-11-24T17:00:00Z')])
    ).toBe(false)
    expect(copiedIntoEngram(timed, [])).toBe(false)
  })

  it('matches an all-day event by its days and name', () => {
    const away = { title: 'Away', allDay: true, start: '2026-11-28', end: '2026-12-01' }
    expect(
      copiedIntoEngram(away, [block('Away', '2026-11-30T09:00:00Z', '2026-11-30T10:00:00Z')])
    ).toBe(true)
    expect(
      copiedIntoEngram(away, [block('Away', '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z')])
    ).toBe(false)
    expect(
      copiedIntoEngram(away, [block('Gym', '2026-11-29T09:00:00Z', '2026-11-29T10:00:00Z')])
    ).toBe(false)
  })
})
