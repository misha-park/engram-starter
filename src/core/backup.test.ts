import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { backupName, backupTime, backupsToDelete } from './backup'

const NOW = Temporal.Instant.from('2026-11-18T14:30:00Z')

describe('backup names', () => {
  it('names a backup by London time and reads it back', () => {
    expect(backupName(NOW)).toBe('2026-11-18 1430')
    expect(backupName(Temporal.Instant.from('2026-07-01T08:05:00Z'))).toBe('2026-07-01 0905')
    expect(backupTime('2026-11-18 1430')?.toInstant().toString()).toBe('2026-11-18T14:30:00Z')
    expect(backupTime('notes')).toBeNull()
    expect(backupTime('2026-02-30 1200')).toBeNull()
  })
})

describe('retention', () => {
  it('keeps the newest per day for 14 days, then the newest per week for 8 weeks', () => {
    const names: string[] = []
    // Two backups a day for 120 days.
    for (let d = 0; d < 120; d++) {
      const day = Temporal.PlainDate.from('2026-11-18').subtract({ days: d }).toString()
      names.push(`${day} 0900`, `${day} 2100`)
    }
    const doomed = new Set(backupsToDelete(names, NOW))
    const kept = names.filter((n) => !doomed.has(n))
    // 14 days (today's 21:00 counts as the newest, even though it's "in the future"
    // relative to 14:30; the newest is always kept) + 8 weeks.
    // Everything from the last 24 hours, then the newest of each day.
    expect(kept).toContain('2026-11-18 0900')
    expect(kept).toContain('2026-11-17 2100')
    const days = kept.filter((n) => n >= '2026-11-05' && n < '2026-11-17 2100')
    expect(days).toHaveLength(12)
    expect(days.every((n) => n.endsWith('2100'))).toBe(true)
    const weeks = kept.filter((n) => n < '2026-11-05')
    // 8 full weeks before the daily ones, plus the part-week where the daily ones stop.
    expect(weeks).toHaveLength(9)
    expect(kept.every((n) => n >= '2026-09-07')).toBe(true)
  })

  it('always keeps the newest, and ignores folders that aren’t backups', () => {
    expect(backupsToDelete(['2025-01-01 1200', 'other'], NOW)).toEqual([])
    expect(backupsToDelete([], NOW)).toEqual([])
    expect(
      backupsToDelete(['2026-11-18 1400', '2025-01-01 1200'], NOW, undefined, ['2025-01-01 1200'])
    ).toEqual([])
  })
})
