import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { templateStages } from '../core/assignments'
import { MAX_ASSIGNMENT_MINUTES_PER_DAY } from '../core/scheduler'
import { minutesBetween, toIso, zoned } from '../core/time'
import { AppContext } from './app-context'
import * as as from './assignments'
import * as cal from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { recordPath, targetForBlock } from './records'
import * as repo from './repo'
import * as ses from './sessions'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00

const contexts: AppContext[] = []
function open(): { db: Db; records: string } {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-as-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const byTitle = (db: Db, title: string) => as.listAssignments(db).find((a) => a.title === title)!
const futureBlocks = (db: Db, id: string) =>
  as
    .getAssignment(db, id)!
    .stages.flatMap((s) => s.blocks.map((b) => ({ ...b, stageId: s.id })))
    .filter((b) => b.start > toIso(NOW))
const total = (blocks: { start: string; end: string }[]) =>
  blocks.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0)
const twoDaysBefore = (due: string) => toIso(Temporal.Instant.from(due).subtract({ hours: 48 }))

it('templateStages splits the estimate exactly, in quarter hours', () => {
  for (const type of ['essay', 'lab-report', 'problem-set', 'presentation', 'other'] as const) {
    const stages = templateStages(type, 15 * 60 + 7)
    expect(stages.reduce((s, x) => s + x.minutes, 0)).toBe(15 * 60)
    expect(stages.every((x) => x.minutes % 15 === 0)).toBe(true)
  }
})

describe('the demo assignments', () => {
  it('are at three different stages', () => {
    const { db } = open()
    expect(as.listAssignments(db).map((a) => [a.title, a.status])).toEqual([
      ['Data analysis assignment', 'not-started'],
      ['Ion channels essay', 'in-progress'],
      ['Practical report 1', 'submitted']
    ])
  })

  it('plan the remaining stages, finishing 2 days before the deadline, in order, without clashes', () => {
    const { db } = open()
    const all = db.select().from(t.blocks).all()
    for (const title of ['Ion channels essay', 'Data analysis assignment']) {
      const a = as.getAssignment(db, byTitle(db, title).id)!
      expect(a.unplacedMinutes).toBe(0)
      const remaining = a.stages
        .filter((s) => !s.done)
        .reduce((s, x) => s + x.estimateMinutes - x.loggedMinutes, 0)
      const future = futureBlocks(db, a.id)
      expect(total(future)).toBe(remaining)
      expect(future.every((b) => b.end <= twoDaysBefore(a.due))).toBe(true)
      // Stage order.
      const open = a.stages.filter((s) => !s.done)
      for (let i = 1; i < open.length; i++) {
        const prevEnd = open[i - 1].blocks.filter((b) => b.start > toIso(NOW)).at(-1)?.end
        const nextStart = open[i].blocks.filter((b) => b.start > toIso(NOW))[0]?.start
        if (prevEnd && nextStart) expect(prevEnd <= nextStart).toBe(true)
      }
      // No clashes with anything else.
      for (const b of future) {
        const clash = all.find((o) => o.id !== b.id && o.start < b.end && o.end > b.start)
        expect(clash, `${b.id} clashes with ${clash?.title}`).toBeUndefined()
      }
    }
  })

  it('never put more than 3 hours of one assignment on a day', () => {
    const { db } = open()
    const perDay = new Map<string, number>()
    for (const b of futureBlocks(db, byTitle(db, 'Ion channels essay').id)) {
      const d = zoned(b.start).toPlainDate().toString()
      perDay.set(d, (perDay.get(d) ?? 0) + minutesBetween(b.start, b.end))
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(MAX_ASSIGNMENT_MINUTES_PER_DAY)
  })

  it('the submitted one has no future blocks', () => {
    const { db } = open()
    expect(futureBlocks(db, byTitle(db, 'Practical report 1').id)).toEqual([])
  })

  it('due dates are deadlines', () => {
    const { db } = open()
    const titles = repo
      .listDeadlines(db, '2026-11-01T00:00:00Z', '2027-01-01T00:00:00Z')
      .filter((d) => d.kind === 'assignment')
      .map((d) => d.title)
    expect(titles).toEqual(['Practical report 1', 'Data analysis assignment', 'Ion channels essay'])
  })
})

describe('rescheduling', () => {
  it('moves the plan when the due date changes', () => {
    const { db } = open()
    const a = byTitle(db, 'Ion channels essay')
    const before = total(futureBlocks(db, a.id))
    const newDue = toIso(Temporal.Instant.from(a.due).subtract({ hours: 24 * 4 }))
    as.updateAssignment(db, a.id, { due: newDue }, NOW)
    const after = futureBlocks(db, a.id)
    expect(total(after)).toBe(before)
    expect(after.every((b) => b.end <= twoDaysBefore(newDue))).toBe(true)
  })

  it('keeps a block moved by hand, and plans around it', () => {
    const { db } = open()
    const a = byTitle(db, 'Ion channels essay')
    const before = total(futureBlocks(db, a.id))
    const block = futureBlocks(db, a.id)[0]
    const moved = cal.moveBlock(
      db,
      block.id,
      '2026-11-21T09:00:00Z',
      toIso(
        Temporal.Instant.from('2026-11-21T09:00:00Z').add({
          minutes: minutesBetween(block.start, block.end)
        })
      )
    )
    as.updateAssignment(
      db,
      a.id,
      { due: toIso(Temporal.Instant.from(a.due).add({ hours: 24 })) },
      NOW
    )
    const after = futureBlocks(db, a.id)
    expect(after.find((b) => b.id === block.id)?.start).toBe(moved.start)
    expect(total(after)).toBe(before)
  })

  it('a finished stage drops its future blocks; un-finishing plans them again', () => {
    const { db } = open()
    const a = as.getAssignment(db, byTitle(db, 'Ion channels essay').id)!
    const stage = a.stages.find((s) => !s.done)!
    as.updateStage(db, stage.id, { done: true }, NOW)
    expect(futureBlocks(db, a.id).some((b) => b.stageId === stage.id)).toBe(false)
    as.updateStage(db, stage.id, { done: false }, NOW)
    expect(total(futureBlocks(db, a.id).filter((b) => b.stageId === stage.id))).toBe(
      stage.estimateMinutes
    )
  })

  it('follows estimate changes and new stages, in order', () => {
    const { db } = open()
    const id = byTitle(db, 'Data analysis assignment').id
    const [first] = as.getAssignment(db, id)!.stages
    as.updateStage(db, first.id, { estimateMinutes: 4 * 60 }, NOW)
    const stageId = as.addStage(db, id, { name: 'Proofread', estimateMinutes: 30 }, NOW)
    const a = as.getAssignment(db, id)!
    expect(a.stages.at(-1)!.name).toBe('Proofread')
    expect(total(futureBlocks(db, id))).toBe(a.estimateMinutes)
    const proof = a.stages.at(-1)!.blocks
    expect(proof[0].start >= a.stages[0].blocks.at(-1)!.end).toBe(true)
    as.removeStage(db, stageId, NOW)
    expect(as.getAssignment(db, id)!.stages.length).toBe(2)
  })

  it('logged time reduces what is left to plan', () => {
    const { db, records } = open()
    const id = byTitle(db, 'Data analysis assignment').id
    const before = total(futureBlocks(db, id))
    const block = futureBlocks(db, id)[0]
    ses.markOutcome(db, records, block.id, {
      outcome: 'partial',
      minutes: 60,
      debrief: 'Did Q1–3.'
    })
    as.rescheduleAssignment(db, id, NOW)
    // The marked block is kept (it has an outcome); 60 minutes were logged.
    expect(total(futureBlocks(db, id).filter((b) => b.outcome === 'none'))).toBe(
      before -
        minutesBetween(block.start, block.end) -
        (60 - minutesBetween(block.start, block.end))
    )
    // Stage work lands in the assignment's record.
    const path = recordPath(db, records, targetForBlock(db, cal.getBlock(db, block.id)!))!
    expect(existsSync(path) && readFileSync(path, 'utf8')).toContain('Did Q1–3.')
    expect(path).toContain('assignments')
  })

  it('submitting clears the plan; un-submitting restores it', () => {
    const { db } = open()
    const id = byTitle(db, 'Ion channels essay').id
    const before = total(futureBlocks(db, id))
    as.setSubmitted(db, id, true, NOW)
    expect(futureBlocks(db, id)).toEqual([])
    expect(byTitle(db, 'Ion channels essay').status).toBe('submitted')
    as.setSubmitted(db, id, false, NOW)
    expect(total(futureBlocks(db, id))).toBe(before)
  })

  it('reports work that cannot fit before a very close deadline', () => {
    const { db } = open()
    const id = as.createAssignment(
      db,
      {
        moduleId: 'phys',
        title: 'Huge task',
        type: 'other',
        due: toIso(NOW.add({ hours: 20 })),
        estimateMinutes: 40 * 60
      },
      NOW
    )
    const a = as.getAssignment(db, id)!
    expect(a.unplacedMinutes).toBeGreaterThan(0)
    expect(total(futureBlocks(db, id)) + a.unplacedMinutes).toBe(40 * 60)
  })

  it('deleting removes untouched future blocks but keeps finished work', () => {
    const { db } = open()
    const a = as.getAssignment(db, byTitle(db, 'Ion channels essay').id)!
    const done = a.stages[0].blocks.filter((b) => b.outcome === 'done')
    const future = futureBlocks(db, a.id)
    as.deleteAssignment(db, a.id, NOW)
    expect(future.every((b) => !cal.getBlock(db, b.id))).toBe(true)
    expect(done.every((b) => cal.getBlock(db, b.id)?.outcome === 'done')).toBe(true)
  })

  it('validates input', () => {
    const { db } = open()
    const base = {
      moduleId: 'phys',
      title: 'x',
      type: 'essay' as const,
      due: toIso(NOW.add({ hours: 240 })),
      estimateMinutes: 600
    }
    expect(() => as.createAssignment(db, { ...base, title: ' ' }, NOW)).toThrow(/title/)
    expect(() => as.createAssignment(db, { ...base, weighting: 120 }, NOW)).toThrow(/Weighting/)
    expect(() => as.createAssignment(db, { ...base, moduleId: 'nope' }, NOW)).toThrow(/Module/)
  })
})

describe('total time and planning', () => {
  it('rescales the stages not done yet when the total changes', () => {
    const { db } = open()
    const a = as.listAssignments(db).find((x) => x.status === 'in-progress')!
    const before = as.getAssignment(db, a.id)!
    const done = before.stages.filter((s) => s.done)
    const doneMinutes = done.reduce((sum, s) => sum + s.estimateMinutes, 0)
    as.setTotalEstimate(db, a.id, before.estimateMinutes * 2, NOW)
    const after = as.getAssignment(db, a.id)!
    expect(after.estimateMinutes).toBe(Math.round((before.estimateMinutes * 2) / 15) * 15)
    // Finished stages keep their time; every stage is a multiple of 15 minutes.
    expect(after.stages.filter((s) => s.done).reduce((sum, s) => sum + s.estimateMinutes, 0)).toBe(
      doneMinutes
    )
    expect(after.stages.every((s) => s.estimateMinutes % 15 === 0)).toBe(true)
    expect(() => as.setTotalEstimate(db, a.id, 5, NOW)).toThrow()
  })

  it('takes an assignment’s work off the calendar and puts it back', () => {
    const { db } = open()
    const a = as.listAssignments(db).find((x) => x.status === 'in-progress')!
    const future = () =>
      db
        .select()
        .from(t.blocks)
        .all()
        .filter(
          (b) =>
            b.linkedType === 'assignment-stage' &&
            as.getAssignment(db, a.id)!.stages.some((s) => s.id === b.linkedId) &&
            b.start > NOW.toString() &&
            b.outcome === 'none'
        )
    expect(future().length).toBeGreaterThan(0)
    as.setPlanned(db, a.id, false, NOW)
    expect(future()).toHaveLength(0)
    expect(as.getAssignment(db, a.id)!.planned).toBe(false)
    // Changes while unplanned place nothing.
    as.rescheduleAssignment(db, a.id, NOW)
    expect(future()).toHaveLength(0)
    as.setPlanned(db, a.id, true, NOW)
    expect(future().length).toBeGreaterThan(0)
  })

  it('adds one block of a stage at a time, even when not planned', () => {
    const { db } = open()
    const a = as.listAssignments(db).find((x) => x.status === 'in-progress')!
    as.setPlanned(db, a.id, false, NOW)
    expect(futureBlocks(db, a.id)).toHaveLength(0)
    const stage = as.getAssignment(db, a.id)!.stages.find((s) => !s.done)!
    const block = as.addStageBlock(db, stage.id, 180, NOW)
    expect(block.start > toIso(NOW)).toBe(true)
    const placed = futureBlocks(db, a.id)
    expect(placed.map((b) => [b.stageId, minutesBetween(b.start, b.end)])).toEqual([
      [stage.id, 180]
    ])
    // Replanning keeps it, and it stays the only block while the assignment isn't planned.
    as.rescheduleAssignment(db, a.id, NOW)
    expect(futureBlocks(db, a.id).map((b) => b.id)).toEqual([block.id])
    expect(() => as.addStageBlock(db, stage.id, 5, NOW)).toThrow()
  })

  it('renames, and its calendar blocks follow', () => {
    const { db } = open()
    const a = as.listAssignments(db).find((x) => x.status === 'in-progress')!
    expect(futureBlocks(db, a.id).length).toBeGreaterThan(0)
    as.updateAssignment(db, a.id, { title: 'Renamed essay' }, NOW)
    expect(as.getAssignment(db, a.id)!.title).toBe('Renamed essay')
    const titles = db
      .select()
      .from(t.blocks)
      .all()
      .filter((b) => futureBlocks(db, a.id).some((f) => f.id === b.id))
      .map((b) => b.title)
    expect(titles.every((x) => x.endsWith(' · Renamed essay'))).toBe(true)
    expect(() => as.updateAssignment(db, a.id, { title: '  ' }, NOW)).toThrow()
  })

  it('can be created without planning it yet', () => {
    const { db } = open()
    const mod = db.select().from(t.modules).all()[0]
    const id = as.createAssignment(
      db,
      {
        moduleId: mod.id,
        title: 'Later',
        due: '2026-12-15T12:00:00Z',
        type: 'essay',
        estimateMinutes: 600,
        planned: false
      },
      NOW
    )
    expect(
      db
        .select()
        .from(t.blocks)
        .all()
        .filter((b) => as.getAssignment(db, id)!.stages.some((s) => s.id === b.linkedId))
    ).toHaveLength(0)
  })
})
