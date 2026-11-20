import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as bl from './backlog'
import * as cal from './calendar'
import * as sd from './shutdown'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-sd-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

describe('evening shutdown', () => {
  it('sums up today and previews tomorrow', () => {
    const { db } = open()
    const s = sd.shutdownSummary(db, NOW)
    expect(s.left.length).toBeGreaterThan(0)
    expect(s.left.every((b) => b.end > NOW.toString() && b.outcome === 'none')).toBe(true)
    expect(s.tomorrowFirst?.start.startsWith('2026-11-19')).toBe(true)
  })

  it('reschedules what’s left from tomorrow, in one go', () => {
    const { db } = open()
    const ids = sd.shutdownSummary(db, NOW).left.map((b) => b.id)
    const result = sd.rescheduleUnfinished(db, ids, NOW)
    expect(result.moved + result.notPlaced.length).toBe(ids.length)
    for (const id of ids) {
      const b = cal.getBlock(db, id)!
      if (result.notPlaced.includes(b.title)) continue
      expect(b.start >= '2026-11-19T00:00:00Z').toBe(true)
    }
    expect(sd.shutdownSummary(db, NOW).left).toHaveLength(result.notPlaced.length)
  })

  it('sends what’s left to the Backlog straight away', () => {
    const { db, records } = open()
    const ids = sd.shutdownSummary(db, NOW).left.map((b) => b.id)
    expect(sd.sendToBacklog(db, records, ids, NOW)).toBe(ids.length)
    const keys = bl.listBacklog(db, NOW).map((i) => i.key)
    for (const id of ids) {
      const b = cal.getBlock(db, id)!
      if (b.type === 'review') continue // reviews are followed up on the Revision tab
      if (b.linkedType === 'assignment-stage') continue // re-planned with the assignment
      expect(keys).toContain(`skipped:${id}`)
    }
  })
})
