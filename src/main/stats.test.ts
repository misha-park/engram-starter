import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import { statsOverview } from './stats'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

describe('stats on the demo data', () => {
  it('has hours per module and type, 12 weeks, planned vs actual and estimates', () => {
    const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-st-')), migrations, {
      clock: () => NOW
    })
    contexts.push(ctx)
    ctx.open()
    const all = statsOverview(ctx.db, 'all', NOW)
    const month = statsOverview(ctx.db, '4w', NOW)
    expect(all.totalMinutes).toBeGreaterThan(0)
    expect(all.byModule.reduce((sum, m) => sum + m.minutes, 0)).toBe(all.totalMinutes)
    expect(all.byType.reduce((sum, m) => sum + m.minutes, 0)).toBe(all.totalMinutes)
    expect(all.byModule.every((m) => m.label)).toBe(true)
    expect(all.weeks).toHaveLength(12)
    expect(all.weeks.at(-1)!.weekStart).toBe('2026-11-16')
    expect(month.totalMinutes).toBeLessThanOrEqual(all.totalMinutes)
    expect(all.planned.blocks).toBe(
      all.planned.done + all.planned.partial + all.planned.skipped + all.planned.unmarked
    )
    expect(all.planned.done).toBeGreaterThan(0)
    expect(all.weekTargetMinutes).toBe(20 * 60)
  })
})
