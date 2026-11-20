import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { nextDueDate } from '../core/todos'
import { minutesBetween, toIso } from '../core/time'
import { AppContext } from './app-context'
import * as as from './assignments'
import * as bl from './backlog'
import * as cal from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import * as repo from './repo'
import * as ses from './sessions'
import * as todos from './todos'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00

const contexts: AppContext[] = []
function open(): { db: Db; records: string } {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-bl-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const kinds = (db: Db) => bl.listBacklog(db, NOW).map((i) => i.kind)
const overlapsAnything = (db: Db, blockId: string) => {
  const b = cal.getBlock(db, blockId)!
  return db
    .select()
    .from(t.blocks)
    .all()
    .some((o) => o.id !== b.id && o.start < b.end && o.end > b.start)
}

describe('the backlog', () => {
  it('collects partial and skipped blocks and overdue todos from the demo', () => {
    const { db } = open()
    const k = kinds(db)
    expect(k).toContain('partial')
    expect(k).toContain('skipped')
    expect(k).toContain('overdue-todo')
    // The seeded timed-out timer is a check-in, not a backlog item.
    const checkin = ses.listCheckins(db)[0]
    expect(bl.listBacklog(db, NOW).some((i) => i.blockId === checkin.blockId)).toBe(false)
  })

  it('lists past blocks nobody marked, and scheduling moves the block itself', () => {
    const { db } = open()
    const wu = db
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.type === 'write-up' && b.outcome === 'none' && b.start > toIso(NOW))!
    cal.moveBlock(db, wu.id, '2026-11-16T19:00:00Z', '2026-11-16T20:30:00Z') // into the past, unmarked
    const item = bl.listBacklog(db, NOW).find((i) => i.blockId === wu.id)!
    expect(item.kind).toBe('unmarked')
    const id = bl.scheduleBacklogItem(db, item.key, {}, NOW)
    expect(id).toBe(wu.id)
    const moved = cal.getBlock(db, wu.id)!
    expect(moved.start >= toIso(NOW)).toBe(true)
    expect(minutesBetween(moved.start, moved.end)).toBe(90)
    expect(overlapsAnything(db, wu.id)).toBe(false)
    expect(bl.listBacklog(db, NOW).some((i) => i.blockId === wu.id)).toBe(false)
  })

  it('a partial block gets a follow-up (half the length) and leaves the backlog', () => {
    const { db } = open()
    const item = bl.listBacklog(db, NOW).find((i) => i.kind === 'partial')!
    const original = cal.getBlock(db, item.blockId!)!
    const followUpId = bl.scheduleBacklogItem(db, item.key, {}, NOW)
    const followUp = cal.getBlock(db, followUpId)!
    expect(followUp.title).toBe(`${original.title} (continued)`)
    expect(followUp).toMatchObject({
      kind: 'flexible',
      linkedType: original.linkedType,
      linkedId: original.linkedId,
      categoryId: original.categoryId
    })
    expect(minutesBetween(followUp.start, followUp.end)).toBe(
      Math.ceil(minutesBetween(original.start, original.end) / 2 / 15) * 15
    )
    expect(followUp.start >= toIso(NOW)).toBe(true)
    expect(overlapsAnything(db, followUpId)).toBe(false)
    expect(bl.listBacklog(db, NOW).some((i) => i.key === item.key)).toBe(false)
  })

  it('schedules where an item is dropped on the calendar', () => {
    const { db } = open()
    const item = bl.listBacklog(db, NOW).find((i) => i.kind === 'skipped')!
    const id = bl.scheduleBacklogItem(db, item.key, { start: '2026-11-21T10:00:00Z' }, NOW)
    expect(cal.getBlock(db, id)).toMatchObject({ start: '2026-11-21T10:00:00Z' })
  })

  it('letting go removes a partial/skipped item without scheduling anything', () => {
    const { db } = open()
    const item = bl.listBacklog(db, NOW).find((i) => i.kind === 'skipped')!
    const before = db.select().from(t.blocks).all().length
    bl.dismissBacklogItem(db, item.key, NOW)
    expect(bl.listBacklog(db, NOW).some((i) => i.key === item.key)).toBe(false)
    expect(db.select().from(t.blocks).all().length).toBe(before)
    expect(() => bl.dismissBacklogItem(db, 'overdue-todo:x', NOW)).toThrow()
  })

  it('lists a lecture with no write-up slot, and scheduling creates and links one', () => {
    const { db } = open()
    // A lecture that has already happened, with its write-up block removed.
    const lecture = db
      .select({ l: t.lectures, end: t.blocks.end })
      .from(t.lectures)
      .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
      .all()
      .find((r) => r.end < toIso(NOW) && r.l.writeUpBlockId)!.l
    db.delete(t.blocks).where(eq(t.blocks.id, lecture.writeUpBlockId!)).run()
    const item = bl.listBacklog(db, NOW).find((i) => i.lectureId === lecture.id)!
    expect(item.kind).toBe('unscheduled-write-up')
    const id = bl.scheduleBacklogItem(db, item.key, {}, NOW)
    expect(
      db.select().from(t.lectures).where(eq(t.lectures.id, lecture.id)).get()!.writeUpBlockId
    ).toBe(id)
    expect(cal.getBlock(db, id)).toMatchObject({
      type: 'write-up',
      linkedType: 'lecture',
      linkedId: lecture.id
    })
  })

  it('lists assignments past due and not submitted, but not blocks of submitted ones', () => {
    const { db } = open()
    const report = as.listAssignments(db).find((a) => a.title === 'Practical report 1')!
    expect(bl.listBacklog(db, NOW).some((i) => i.assignmentId === report.id)).toBe(false)
    as.setSubmitted(db, report.id, false, NOW)
    expect(bl.listBacklog(db, NOW).find((i) => i.assignmentId === report.id)?.kind).toBe(
      'overdue-assignment'
    )
  })
})

describe('todos', () => {
  it('create, edit, tick and archive', () => {
    const { db } = open()
    const id = todos.createTodo(db, { title: 'Buy notebook', dueDate: '2026-11-20' })
    todos.updateTodo(db, id, { title: 'Buy two notebooks' })
    expect(todos.getTodo(db, id)).toMatchObject({
      title: 'Buy two notebooks',
      dueDate: '2026-11-20',
      source: 'app'
    })
    todos.setTodoDone(db, id, true, NOW)
    expect(todos.getTodo(db, id)!.done).toBe(true)
    todos.archiveTodo(db, id)
    expect(repo.listTodos(db, NOW).some((x) => x.id === id)).toBe(false)
    todos.unarchiveTodo(db, id)
    expect(repo.listTodos(db, NOW).some((x) => x.id === id)).toBe(true)
    expect(() => todos.createTodo(db, { title: '  ' })).toThrow(/title/)
  })

  it('ticking a recurring todo creates the next one (only once)', () => {
    const { db } = open()
    const id = todos.createTodo(db, {
      title: 'Weekly review',
      dueDate: '2026-11-16',
      recurrence: { freq: 'weekly', byWeekday: [1] }
    })
    const next = todos.setTodoDone(db, id, true, NOW)!
    expect(todos.getTodo(db, next)).toMatchObject({
      title: 'Weekly review',
      done: false,
      dueDate: '2026-11-23'
    })
    todos.setTodoDone(db, id, false, NOW)
    expect(todos.setTodoDone(db, id, true, NOW)).toBeNull() // the next one already exists
    // Even renamed, the next one is recognised; another repeating todo with the same name
    // still gets its own next instance.
    todos.updateTodo(db, next, { title: 'Weekly review (Sunday)' })
    todos.setTodoDone(db, id, false, NOW)
    expect(todos.setTodoDone(db, id, true, NOW)).toBeNull()
    const twin = todos.createTodo(db, {
      title: 'Weekly review',
      dueDate: '2026-11-17',
      recurrence: { freq: 'weekly', byWeekday: [2] }
    })
    expect(todos.setTodoDone(db, twin, true, NOW)).not.toBeNull()
  })

  it('open todos with a due date join the calendar’s deadlines, in a module’s colour', () => {
    const { db } = open()
    const mod = db.select().from(t.modules).get()!
    const id = todos.createTodo(db, {
      title: 'Return lab coat',
      dueDate: '2026-11-25',
      link: { type: 'module', id: mod.id }
    })
    todos.createTodo(db, { title: 'Undated' })
    const inWeek = () =>
      repo
        .listDeadlines(db, '2026-11-23T00:00:00Z', '2026-11-30T00:00:00Z')
        .filter((d) => d.kind === 'todo' && d.title === 'Return lab coat')
    expect(inWeek()).toEqual([
      {
        id: `todo-${id}`,
        title: 'Return lab coat',
        at: '2026-11-25T23:59:00Z',
        categoryId: mod.categoryId,
        kind: 'todo'
      }
    ])
    todos.setTodoDone(db, id, true, NOW)
    expect(inWeek()).toEqual([])
  })

  it('a todo with an estimate becomes a block; finishing the block ticks the todo', () => {
    const { db, records } = open()
    const id = todos.createTodo(db, {
      title: 'Tidy lab notebook',
      link: { type: 'module', id: 'phar' }
    })
    const blockId = bl.scheduleTodo(db, id, { minutes: 45 }, NOW)
    const block = cal.getBlock(db, blockId)!
    expect(block).toMatchObject({ linkedType: 'todo', linkedId: id, categoryId: 'phar' })
    expect(minutesBetween(block.start, block.end)).toBe(45)
    ses.startTimer(db, blockId, Temporal.Instant.from(block.start))
    ses.completeSession(
      db,
      records,
      ses.stopTimer(db, Temporal.Instant.from(block.end)),
      { outcome: 'done' },
      { now: Temporal.Instant.from(block.end) }
    )
    expect(todos.getTodo(db, id)!.done).toBe(true)
  })

  it('overdue todos are in the backlog and the notifications', () => {
    const { db } = open()
    const overdue = repo
      .listTodos(db, NOW)
      .filter((x) => !x.done && x.dueDate && x.dueDate < '2026-11-18')
    expect(overdue.length).toBeGreaterThan(0)
    const notes = bl.listNotifications(db, NOW)
    for (const todo of overdue) expect(notes.some((n) => n.todoId === todo.id)).toBe(true)
    expect(notes.some((n) => n.kind === 'debrief')).toBe(true)
    expect(notes.some((n) => n.kind === 'checkin')).toBe(true)
  })
})

describe('nextDueDate', () => {
  const today = Temporal.PlainDate.from('2026-11-18') // Wednesday
  it('weekly goes to the next chosen weekday', () => {
    expect(nextDueDate({ freq: 'weekly', byWeekday: [1, 4] }, '2026-11-16', today)).toBe(
      '2026-11-19'
    )
  })
  it('daily goes to the day after (counting from today when catching up)', () => {
    expect(nextDueDate({ freq: 'daily' }, '2026-11-10', today)).toBe('2026-11-19')
    expect(nextDueDate({ freq: 'daily' }, '2026-11-25', today)).toBe('2026-11-26')
  })
})

describe('block colours and todo blocks', () => {
  it('colours a non-module block, and a whole series at once', () => {
    const { db } = open()
    const pub = db
      .select()
      .from(t.blocks)
      .all()
      .filter((b) => b.recurrenceId === 'rec-pub-shift')
    expect(pub.length).toBeGreaterThan(1)
    cal.setBlockColour(db, pub[0].id, '#3ec867')
    const after = db
      .select()
      .from(t.blocks)
      .all()
      .filter((b) => b.recurrenceId === 'rec-pub-shift')
    expect(after.every((b) => b.colour === '#3ec867')).toBe(true)
    expect(cal.getRecurrence(db, 'rec-pub-shift')!.colour).toBe('#3ec867')
    cal.setBlockColour(db, pub[0].id, null)
    expect(cal.getBlock(db, pub[0].id)!.colour).toBeNull()

    const lecture = db
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.source === 'timetable')!
    expect(() => cal.setBlockColour(db, lecture.id, '#3ec867')).toThrow(/module/)
    expect(() => cal.setBlockColour(db, pub[0].id, 'red')).toThrow(/Invalid/)
  })

  it('ticking a todo ticks its calendar block, and unticking puts it back', () => {
    const { db } = open()
    const todo = repo.listTodos(db, NOW).find((x) => !x.done && !x.recurrence)!
    const blockId = bl.scheduleTodo(db, todo.id, { minutes: 30 }, NOW)
    todos.setTodoDone(db, todo.id, true, NOW)
    expect(cal.getBlock(db, blockId)!.outcome).toBe('done')
    todos.setTodoDone(db, todo.id, false, NOW)
    expect(cal.getBlock(db, blockId)!.outcome).toBe('none')
  })
})
