import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as dl from './deadlines'
import * as repo from './repo'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-deadlines-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

describe('general deadlines', () => {
  it('are created, listed soonest first, ticked off and deleted', () => {
    const db = open()
    const mod = repo.listModules(db)[0]
    const late = dl.createDeadline(db, { title: 'Pay hall fees', due: '2026-12-01T17:00:00Z' })
    const soon = dl.createDeadline(db, {
      title: ' Summer school form ',
      due: '2026-11-25T12:00:00Z',
      moduleId: mod.id
    })
    expect(soon.title).toBe('Summer school form')
    expect(soon.moduleName).toBe(mod.name)
    expect(dl.listGeneralDeadlines(db).map((d) => d.title)).toEqual([
      'Summer school form',
      'Pay hall fees'
    ])

    dl.setDeadlineDone(db, soon.id, true, NOW)
    expect(dl.getGeneralDeadline(db, soon.id)!.doneAt).toBe(NOW.toString())
    dl.updateDeadline(db, late.id, { title: 'Pay hall fees (term 2)' })
    dl.deleteDeadline(db, late.id)
    expect(dl.listGeneralDeadlines(db).map((d) => d.id)).toEqual([soon.id])
  })

  it('open ones show among the calendar deadlines; done ones don’t', () => {
    const db = open()
    const d = dl.createDeadline(db, { title: 'Erasmus application', due: '2026-11-27T12:00:00Z' })
    const inRange = () =>
      repo
        .listDeadlines(db, '2026-11-23T00:00:00Z', '2026-11-30T00:00:00Z')
        .filter((x) => x.kind === 'deadline')
    expect(inRange()).toEqual([
      expect.objectContaining({ title: 'Erasmus application', kind: 'deadline' })
    ])
    dl.setDeadlineDone(db, d.id, true, NOW)
    expect(inRange()).toEqual([])
  })

  it('refuses a missing name or a bad date', () => {
    const db = open()
    expect(() => dl.createDeadline(db, { title: ' ', due: '2026-11-27T12:00:00Z' })).toThrow(/name/)
    expect(() => dl.createDeadline(db, { title: 'X', due: 'soon' })).toThrow(/date/)
  })
})
