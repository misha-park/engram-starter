import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { elapsed } from '../core/timer'
import { AppContext } from './app-context'
import type { Db } from './db/client'
import { FocusController, getFocusSettings, setFocusSettings } from './focus'
import { startableBlock } from './sessions'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open(): Db {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-fo-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

describe('Focus while a timer runs', () => {
  it('runs nothing until switched on, then the on/off shortcuts', async () => {
    const db = open()
    const ran: string[] = []
    const focus = new FocusController(
      () => db,
      async (name) => void ran.push(name)
    )
    await focus.timer(true)
    expect(ran).toEqual([])
    setFocusSettings(db, { ...getFocusSettings(db), enabled: true, onShortcut: '  ' })
    await focus.timer(true)
    await focus.timer(false)
    // A blank name falls back to the default.
    expect(ran).toEqual(['Engram Focus On', 'Engram Focus Off'])
  })

  it('keeps a failure for Settings instead of breaking the timer', async () => {
    const db = open()
    setFocusSettings(db, { ...getFocusSettings(db), enabled: true })
    const focus = new FocusController(
      () => db,
      async () => {
        throw new Error('The shortcut couldn’t be found.')
      }
    )
    await expect(focus.timer(true)).resolves.toBeUndefined()
    expect(focus.lastError).toMatch(/Engram Focus On.*couldn’t be found/)
    await expect(focus.test('off')).rejects.toThrow(/Engram Focus Off/)
  })
})

describe('menu-bar timer', () => {
  it('offers the block happening now or the next one today', () => {
    const db = open()
    const next = startableBlock(db, NOW)
    expect(next).not.toBeNull()
    expect(next!.block.kind).toBe('flexible')
    expect(next!.block.end > NOW.toString()).toBe(true)
    expect(next!.block.start < '2026-11-19T00:00:00Z').toBe(true)
  })

  it('formats elapsed time', () => {
    expect(elapsed('2026-11-18T13:34:47Z', NOW)).toBe('25:13')
    expect(elapsed('2026-11-18T12:54:51Z', NOW)).toBe('1:05:09')
  })
})
