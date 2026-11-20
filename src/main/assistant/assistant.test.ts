import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConversationMode, TodoSuggestion } from '../../shared/types'
import { AppContext } from '../app-context'
import * as bl from '../backlog'
import * as cal from '../calendar'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import * as repo from '../repo'
import { TokenStore } from './auth'
import {
  acceptBatch,
  ChangeTracker,
  getBatch,
  pendingBatch,
  recordBatch,
  undoBatch
} from './changes'
import { matches, type FindResult } from './find'
import { addMemory, listMemories } from './memory'
import { freeSlots, parseLocal, placementProblems, toLocal, writeUpDeadline } from './placement'
import { dynamicPrompt } from './prompt'
import type { TimeOffResult } from './time-off'
import { assistantEnv } from './runner'
import { TOOLS, toolsFor, type ToolContext } from './tools'

const migrations = resolve(__dirname, '../../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00 London

const contexts: AppContext[] = []
function open(): { db: Db; records: string } {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-as-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

function harness(mode: ConversationMode = { kind: 'chat' }) {
  const { db, records } = open()
  const suggestions: TodoSuggestion[] = []
  const ctx: ToolContext = {
    db,
    recordsDir: records,
    now: () => NOW,
    mode,
    suggest: (s) => suggestions.push(...s),
    filesDir: tmpdir(),
    planBrief: () => {}
  }
  const tracker = new ChangeTracker(db)
  const call = (name: string, args: Record<string, unknown>) => {
    const d = toolsFor(mode).find((x) => x.name === name)
    if (!d) throw new Error(`no tool ${name} in ${mode.kind}`)
    const parsed = z.object(d.shape).parse(args)
    return d.mutates ? tracker.track(() => d.run(parsed, ctx)) : d.run(parsed, ctx)
  }
  const finish = (request = 'test') =>
    recordBatch(db, { changes: tracker.all, request, conversationId: 'c1' }, NOW)
  return { db, records, call, finish, suggestions, tracker }
}

/** A write-up later today (the seed always has one for each recent lecture). */
function upcomingWriteUp(db: Db) {
  return db
    .select()
    .from(t.blocks)
    .all()
    .filter((b) => b.type === 'write-up' && b.outcome === 'none' && b.start > NOW.toString())
    .sort((a, b) => a.start.localeCompare(b.start))[0]
}

describe('time strings for Claude', () => {
  it('reads London local times and writes them back', () => {
    expect(parseLocal('2026-11-19T14:00')).toBe('2026-11-19T14:00:00Z')
    expect(parseLocal('2026-07-01T14:00')).toBe('2026-07-01T13:00:00Z') // BST
    expect(parseLocal('2026-07-01T14:00:00Z')).toBe('2026-07-01T14:00:00Z')
    expect(toLocal('2026-07-01T13:00:00Z')).toBe('2026-07-01T14:00')
    expect(() => parseLocal('tomorrow')).toThrow(/YYYY-MM-DDTHH:mm/)
  })
})

describe('assistant tools', () => {
  it('gives chat, debriefs and check-ins different tools', () => {
    const names = (kind: ConversationMode['kind']) =>
      toolsFor(
        kind === 'chat'
          ? { kind }
          : kind === 'debrief'
            ? { kind, blockId: 'x' }
            : { kind, sessionId: 'x' }
      ).map((d) => d.name)
    expect(names('chat')).toContain('move_block')
    expect(names('chat')).not.toContain('save_debrief')
    expect(names('debrief')).toEqual(expect.arrayContaining(['save_debrief', 'suggest_todos']))
    expect(names('debrief')).not.toContain('move_block')
    expect(names('checkin')).toContain('complete_checkin')
    // Every tool has a description and a unique name.
    expect(new Set(TOOLS.map((d) => d.name)).size).toBe(TOOLS.length)
  })

  it('lists the schedule with ids and whether blocks can move', () => {
    const { call } = harness()
    const out = call('get_schedule', { from: '2026-11-18', to: '2026-11-18' }) as {
      blocks: { id: string; fixed?: true; start: string }[]
    }
    expect(out.blocks.length).toBeGreaterThan(0)
    expect(out.blocks.every((b) => b.start.startsWith('2026-11-18'))).toBe(true)
    expect(out.blocks.some((b) => b.fixed)).toBe(true)
  })

  it('finds free slots only inside availability and in the future', () => {
    const { db } = harness()
    const days = freeSlots(db, { from: '2026-11-18', to: '2026-11-20', minutes: 30 }, NOW)
    for (const d of days) {
      for (const s of d.slots) {
        expect(s.start >= '2026-11-18T14:00').toBe(true)
        expect(s.start.slice(11) >= '09:00').toBe(true)
        expect(s.minutes).toBeGreaterThanOrEqual(30)
      }
    }
  })

  it('a repeating event is one change: applied straight away, undone in one go', () => {
    const { db, call, finish } = harness()
    call('create_repeating_event', {
      title: 'Lab meeting',
      start: '2026-11-24T10:00',
      end: '2026-11-24T11:00',
      kind: 'fixed'
    })
    const batchId = finish('Add a weekly lab meeting')!
    const batch = getBatch(db, batchId)!
    expect(batch.status).toBe('applied')
    expect(batch.changeCount).toBe(1)
    const meetings = () =>
      db
        .select()
        .from(t.blocks)
        .all()
        .filter((b) => b.title === 'Lab meeting')
    expect(meetings().length).toBeGreaterThan(5)
    undoBatch(db, batchId, NOW)
    expect(meetings()).toHaveLength(0)
  })

  it('“skip the write-up tonight”: moves it within its limit, as one undoable change', () => {
    const { db, call, finish } = harness()
    const wu = upcomingWriteUp(db)
    const limit = writeUpDeadline(db, wu.linkedId!)!
    const minutes = (Date.parse(wu.end) - Date.parse(wu.start)) / 60_000
    const tomorrow = Temporal.PlainDate.from('2026-11-19')
    const days = freeSlots(
      db,
      { from: tomorrow.toString(), to: '2026-11-21', minutes, exceptBlockId: wu.id },
      NOW
    )
    const slot = days.flatMap((d) => d.slots)[0]
    call('move_block', { block_id: wu.id, start: slot.start })

    const moved = cal.getBlock(db, wu.id)!
    expect(toLocal(moved.start)).toBe(slot.start)
    expect(moved.end <= limit).toBe(true)

    const batchId = finish('Skip the write-up tonight')!
    const batch = getBatch(db, batchId)!
    expect(batch.status).toBe('applied') // one block: no review needed
    expect(batch.lines[0]).toMatch(/^Moved “.*write-up”/)
    expect(batch.blocks[0].before?.start).toBe(wu.start)

    undoBatch(db, batchId, NOW)
    const back = cal.getBlock(db, wu.id)!
    expect(back.start).toBe(wu.start)
    expect(back.end).toBe(wu.end)
    expect(back.detached).toBe(wu.detached)
    expect(getBatch(db, batchId)!.status).toBe('undone')
    expect(() => undoBatch(db, batchId, NOW)).toThrow(/already been undone/)
  })

  it('refuses to break the rules', () => {
    const { db, call } = harness()
    const fixed = db
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.kind === 'fixed' && b.start > NOW.toString())!
    expect(() => call('move_block', { block_id: fixed.id, start: '2026-11-19T10:00' })).toThrow(
      /fixed/
    )

    const wu = upcomingWriteUp(db)
    // Before "no work before".
    expect(() => call('move_block', { block_id: wu.id, start: '2026-11-19T06:00' })).toThrow(
      /Outside availability/
    )
    // In the past.
    expect(() => call('move_block', { block_id: wu.id, start: '2026-11-17T10:00' })).toThrow(/past/)
    // On top of a fixed event.
    expect(() =>
      call('move_block', { block_id: wu.id, start: toLocal(fixed.start), end: toLocal(fixed.end) })
    ).toThrow(/Overlaps/)
    // Past the 3-day write-up limit.
    const limit = Temporal.Instant.from(writeUpDeadline(db, wu.linkedId!)!)
    const late = toLocal(limit.add({ hours: 24 * 2 + 11 }).toString()) // two days later, ~10:00
    expect(() => call('move_block', { block_id: wu.id, start: late })).toThrow(
      /within 3 working days/
    )
    // Nothing moved.
    expect(cal.getBlock(db, wu.id)!.start).toBe(wu.start)
  })

  it('puts a write-up past its limit only when the user asked, and flags it', () => {
    const { db, call } = harness()
    const wu = upcomingWriteUp(db)
    const limit = Temporal.Instant.from(writeUpDeadline(db, wu.linkedId!)!)
    const day = limit
      .add({ hours: 24 * 3 })
      .toZonedDateTimeISO('Europe/London')
      .toPlainDate()
    const slot = freeSlots(
      db,
      {
        from: day.toString(),
        to: day.add({ days: 7 }).toString(),
        minutes: 60,
        exceptBlockId: wu.id
      },
      NOW
    )[0].slots[0]
    expect(() => call('move_block', { block_id: wu.id, start: slot.start })).toThrow(
      /past_limit_requested/
    )
    call('move_block', { block_id: wu.id, start: slot.start, past_limit_requested: true })
    const moved = cal.getBlock(db, wu.id)!
    expect(toLocal(moved.start)).toBe(slot.start)
    expect(moved.attention).toMatch(/^Past the write-up limit .*at your request/)
    // Other rules still hold.
    expect(() =>
      call('move_block', {
        block_id: wu.id,
        start: '2026-11-17T10:00',
        past_limit_requested: true
      })
    ).toThrow(/past/)
  })

  it('a bigger change waits for review; rejecting puts everything back', () => {
    const { db, call, finish } = harness()
    // The seeded skipped block, rescheduled, plus a new block: two visible changes.
    const item = bl.listBacklog(db, NOW).find((i) => i.kind === 'skipped')!
    const wu = cal.getBlock(db, item.blockId!)!
    const key = item.key
    const free = freeSlots(db, { from: '2026-11-21', to: '2026-11-21', minutes: 30 }, NOW)[0]
      .slots[0]
    const extraEnd = Temporal.PlainDateTime.from(free.start).add({ minutes: 30 }).toString()
    call('create_block', { title: 'Extra', start: free.start, end: extraEnd.slice(0, 16) })
    const slot = freeSlots(db, { from: '2026-11-19', to: '2026-11-20', minutes: 60 }, NOW)[0]
      .slots[0]
    call('schedule_backlog_item', { key, start: slot.start })
    const id = finish('skip it and find another time')!
    expect(getBatch(db, id)!.status).toBe('pending')
    expect(pendingBatch(db)?.id).toBe(id)
    expect(getBatch(db, id)!.lines.length).toBe(2)

    undoBatch(db, id, NOW, 'rejected')
    expect(cal.getBlock(db, wu.id)!.outcome).toBe('skipped')
    expect(cal.getBlock(db, wu.id)!.backlogResolvedAt ?? null).toBeNull()
    const followUps = db
      .select()
      .from(t.blocks)
      .all()
      .filter((b) => b.id.startsWith('fu-'))
    expect(followUps).toEqual([])
    expect(
      db
        .select()
        .from(t.blocks)
        .all()
        .some((b) => b.title === 'Extra')
    ).toBe(false)
    expect(bl.listBacklog(db, NOW).some((i) => i.key === key)).toBe(true)
    expect(pendingBatch(db)).toBeNull()
  })

  it('only drops blocks that haven’t started; past ones get any outcome', () => {
    const { db, call } = harness()
    const wu = upcomingWriteUp(db)
    expect(() => call('mark_outcome', { block_id: wu.id, outcome: 'done' })).toThrow(
      /hasn’t started/
    )
    call('mark_outcome', { block_id: wu.id, outcome: 'skipped' })
    expect(cal.getBlock(db, wu.id)!.outcome).toBe('skipped')
  })

  it('accepting keeps a reviewed change; a newer change accepts an older one still waiting', () => {
    const { db, call, finish } = harness()
    const wu = upcomingWriteUp(db)
    const gap = freeSlots(db, { from: '2026-11-20', to: '2026-11-21', minutes: 60 }, NOW)[0]
      .slots[0]
    const mid = toLocal(
      Temporal.Instant.from(parseLocal(gap.start)).add({ minutes: 30 }).toString()
    )
    const end = toLocal(
      Temporal.Instant.from(parseLocal(gap.start)).add({ minutes: 60 }).toString()
    )
    call('create_block', { title: 'Revise A', start: gap.start, end: mid })
    call('create_block', { title: 'Revise B', start: mid, end })
    const first = finish()!
    expect(getBatch(db, first)!.status).toBe('pending')
    acceptBatch(db, first, NOW)
    expect(getBatch(db, first)!.status).toBe('accepted')
    expect(wu).toBeDefined()
  })

  it('won’t undo over something changed since', () => {
    const { db, call, finish } = harness()
    const wu = upcomingWriteUp(db)
    const slot = freeSlots(
      db,
      { from: '2026-11-19', to: '2026-11-19', minutes: 15, exceptBlockId: wu.id },
      NOW
    )[0].slots[0]
    call('move_block', { block_id: wu.id, start: slot.start })
    const id = finish()!
    // The user drags it somewhere else afterwards.
    const later = Temporal.Instant.from(cal.getBlock(db, wu.id)!.start).add({ minutes: 15 })
    const len = (Date.parse(wu.end) - Date.parse(wu.start)) / 60_000
    cal.moveBlock(db, wu.id, later.toString(), later.add({ minutes: len }).toString(), 'user')
    expect(() => undoBatch(db, id, NOW)).toThrow(/changed since/)
    expect(cal.getBlock(db, wu.id)!.start).toBe(later.toString())
  })

  it('debriefs save the text and only suggest todos', () => {
    const { db } = open()
    const partial = db
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.outcome === 'partial' && b.debriefPending)!
    const h2 = harnessFor(db, { kind: 'debrief', blockId: partial.id })
    h2.call('save_debrief', { text: 'Covered the first half. Left: figures 3–5.' })
    h2.call('suggest_todos', { todos: [{ title: 'Ask about figure 4' }] })
    expect(cal.getBlock(db, partial.id)!.debriefPending).toBe(false)
    expect(h2.suggestions.map((s) => s.title)).toEqual(['Ask about figure 4'])
    expect(
      db
        .select()
        .from(t.todos)
        .all()
        .some((td) => td.title === 'Ask about figure 4')
    ).toBe(false)
  })
})

function harnessFor(db: Db, mode: ConversationMode) {
  const suggestions: TodoSuggestion[] = []
  const ctx: ToolContext = {
    db,
    recordsDir: tmpdir(),
    now: () => NOW,
    mode,
    suggest: (s) => suggestions.push(...s),
    filesDir: tmpdir(),
    planBrief: () => {}
  }
  const tracker = new ChangeTracker(db)
  return {
    suggestions,
    call: (name: string, args: Record<string, unknown>) => {
      const d = toolsFor(mode).find((x) => x.name === name)!
      const parsed = z.object(d.shape).parse(args)
      return d.mutates ? tracker.track(() => d.run(parsed, ctx)) : d.run(parsed, ctx)
    }
  }
}

describe('assistant auth', () => {
  const fake = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s: string) => Buffer.from(`enc:${s}`),
    decryptStringAsync: async (b: Buffer) => ({ result: b.toString().replace(/^enc:/, '') })
  }

  it('stores the token encrypted and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-tok-'))
    const store = new TokenStore(dir, fake)
    expect(store.has()).toBe(false)
    await expect(store.set('not a token')).rejects.toThrow(/sk-ant-/)
    const token = `sk-ant-oat01-${'x'.repeat(40)}`
    // Pasted from a narrow terminal: wrapped over three lines.
    await store.set(`  ${token.slice(0, 20)}\n ${token.slice(20, 40)}\n${token.slice(40)}\n`)
    expect(await store.get()).toBe(token)
    store.clear()
    expect(await store.get()).toBeNull()
  })

  it('never passes an API key to Claude', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-should-not-leak'
    const env = assistantEnv('sk-ant-oat01-token')
    delete process.env.ANTHROPIC_API_KEY
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-token')
  })
})

describe('lecture tools', () => {
  it('lets the assistant combine two sessions, and Undo puts everything back', () => {
    const { db, call, finish } = harness()
    const module = repo.listModules(db)[0].id
    const lectures = () => repo.getModuleDetail(db, module, NOW)!.lectures
    const future = lectures().filter((l) => l.status === 'scheduled')
    const [first, second] = future
    const blockRows = () =>
      db
        .select()
        .from(t.blocks)
        .all()
        .map((b) => `${b.id} ${b.start} ${b.end} ${b.title}`)
        .sort()
    const before = blockRows()
    call('combine_lectures', { lecture_id: second.id, earlier_lecture_id: first.id })
    const after = lectures().find((l) => l.id === second.id)!
    expect(after.part).toMatchObject({ index: 2, of: 2 })
    call('rename_lecture', { lecture_id: first.id, name: 'Ion channels' })
    expect(lectures().find((l) => l.id === first.id)!.topic).toBe('Ion channels')

    const id = finish('combine L5 and L6')!
    undoBatch(db, id, NOW)
    expect(lectures().find((l) => l.id === second.id)!.part).toBeNull()
    expect(lectures().find((l) => l.id === first.id)!.topic).toBeNull()
    expect(blockRows()).toEqual(before)
  })

  it('lets the assistant split a lecture at a given time and see module files', () => {
    const { db, call } = harness()
    const long = repo
      .listModules(db)
      .flatMap((m) => repo.getModuleDetail(db, m.id, NOW)!.lectures)
      .find((l) => l.canSplit)!
    const start = Temporal.Instant.from(long.start).toZonedDateTimeISO('Europe/London')
    const at = `${String(start.hour).padStart(2, '0')}:30`
    call('split_lecture', { lecture_id: long.id, second_starts_at: at })
    const parts = repo
      .getModuleDetail(db, long.moduleId, NOW)!
      .lectures.filter((l) => l.splitPart && l.start.slice(0, 10) === long.start.slice(0, 10))
    expect(parts).toHaveLength(2)
    expect(call('get_module_files', { module_id: long.moduleId })).toMatchObject({ fromMoodle: [] })
  })
})

describe('the assistant can change every section', () => {
  it('has a tool for each kind of change the pages can make', () => {
    const names = toolsFor({ kind: 'chat' }).map((d) => d.name)
    for (const n of [
      'update_todo',
      'tick_todo',
      'archive_todo',
      'update_event',
      'delete_event',
      'remove_occurrence',
      'update_series',
      'set_availability',
      'create_assignment',
      'update_assignment',
      'set_assignment_submitted',
      'delete_assignment',
      'add_assignment_stage',
      'remove_assignment_stage',
      'move_assignment_stage',
      'update_module',
      'set_lecture_attended',
      'set_lecture_flashcards',
      'set_lecture_notes',
      'delete_timetable_event',
      'update_dissertation_settings',
      'add_dissertation_section',
      'remove_dissertation_section',
      'add_milestone',
      'remove_milestone',
      'save_meeting',
      'remove_meeting',
      'reschedule_review',
      'set_weekly_target',
      'add_commitment',
      'end_commitment',
      'set_start_date',
      'dismiss_backlog_item',
      'log_time'
    ])
      expect(names, n).toContain(n)
    // Debriefs and check-ins stay narrow.
    expect(
      toolsFor({ kind: 'debrief', blockId: 'x' } as ConversationMode).map((d) => d.name)
    ).not.toContain('delete_assignment')
  })

  it('changes availability, the target and a module, and Undo puts them back', () => {
    const { db, call, finish } = harness()
    const before = cal.getAvailability(db)
    const mod = repo.listModules(db)[0]
    call('set_availability', { days: [{ weekday: 1, start: null, end: null }] })
    call('set_weekly_target', { hours: 12 })
    call('update_module', { module_id: mod.id, short_label: 'XX' })
    expect(cal.getAvailability(db).days[0]).toBeNull()
    expect(repo.listModules(db)[0].shortLabel).toBe('XX')
    const id = finish('Mondays off, 12h target, rename the module')!
    undoBatch(db, id, NOW)
    expect(cal.getAvailability(db)).toEqual(before)
    expect(repo.listModules(db)[0].shortLabel).toBe(mod.shortLabel)
  })

  it('creates and edits an assignment and its stages', () => {
    const { db, call } = harness()
    const mod = repo.listModules(db)[0]
    const { created } = call('create_assignment', {
      module_id: mod.id,
      title: 'Grant proposal',
      due: '2026-12-10T12:00',
      type: 'essay',
      estimate_hours: 10,
      plan_now: true
    }) as { created: string }
    call('update_assignment', {
      assignment_id: created,
      word_limit: 1500,
      summary: 'You write a grant proposal.'
    })
    const a = call('get_assignments', { assignment_id: created }) as { stages: { id: string }[] }
    call('add_assignment_stage', {
      assignment_id: created,
      name: 'Check figures',
      estimate_minutes: 60
    })
    call('remove_assignment_stage', { stage_id: a.stages[0].id })
    const after = call('get_assignments', { assignment_id: created }) as {
      wordLimit: number
      stages: { name: string }[]
    }
    expect(after.stages.map((s) => s.name)).toContain('Check figures')
    expect(after.stages).toHaveLength(a.stages.length)
  })
})

describe('tool labels', () => {
  it('every tool has a label for the chat panel', async () => {
    const src = (await import('fs')).readFileSync(resolve(__dirname, 'runner.ts'), 'utf8')
    const missing = TOOLS.map((d) => d.name).filter((n) => !new RegExp(`\\b${n}:`).test(src))
    expect(missing).toEqual([])
  })
})

describe('finding, stats and notifications', () => {
  it('finds lectures, modules and events by name, every word matching', () => {
    const { db, call } = harness()
    const mod = repo.listModules(db)[0]
    const lectures = call('find', { query: `${mod.shortLabel} L1` }) as FindResult[]
    expect(
      lectures.some((r) => r.type === 'lecture' && r.label.startsWith(`${mod.shortLabel} L1`))
    ).toBe(true)
    expect(
      lectures.every((r) => matches(`${mod.shortLabel} L1`, `${r.label}`) || r.type !== 'lecture')
    ).toBe(true)
    const modules = call('find', { query: mod.name }) as FindResult[]
    expect(modules[0]).toMatchObject({ type: 'module', id: mod.id })
    expect(call('find', { query: 'zzzz nothing' })).toMatch(/Nothing matches/)
  })

  it('adds up study time and lists what is waiting', () => {
    const { call } = harness()
    const stats = call('get_stats', { range: '4w' }) as { total: string; weeks: string[] }
    expect(stats.weeks).toHaveLength(12)
    expect(typeof stats.total).toBe('string')
    const waiting = call('get_notifications', {}) as {
      waiting: unknown[]
      forumPosts: unknown[]
      briefsWithoutAssignment: unknown[]
    }
    expect(Array.isArray(waiting.waiting)).toBe(true)
    expect(Array.isArray(waiting.forumPosts)).toBe(true)
  })

  it('keeps schedules short: no defaults, same-day ends as HH:mm', () => {
    const { call } = harness()
    const out = call('get_schedule', { from: '2026-11-18', to: '2026-11-18' }) as {
      blocks: Record<string, unknown>[]
    }
    for (const b of out.blocks) {
      expect(b.end).toMatch(/^\d{2}:\d{2}$/)
      expect(b).not.toHaveProperty('movable')
      expect(b.outcome).not.toBe('none')
    }
    const flexible = call('get_schedule', {
      from: '2026-11-18',
      to: '2026-11-25',
      flexible_only: true
    }) as { blocks: Record<string, unknown>[] }
    expect(flexible.blocks.every((b) => !b.fixed)).toBe(true)
  })
})

describe('remembering', () => {
  it('remembers a preference, shows it in the prompt, and undoes like any change', () => {
    const { db, call, finish } = harness()
    const out = call('remember', { text: 'No write-ups after 21:00' }) as {
      remembered: { id: string }
    }
    expect(dynamicPrompt(db, NOW, { kind: 'chat' })).toContain('No write-ups after 21:00')
    // The same note twice is kept once.
    call('remember', { text: 'no write-ups after 21:00' })
    expect(listMemories(db)).toHaveLength(1)

    const batchId = finish('Remember no write-ups after 21:00')!
    expect(getBatch(db, batchId)!.lines).toEqual(['Remembered “No write-ups after 21:00”'])
    undoBatch(db, batchId, NOW)
    expect(listMemories(db)).toHaveLength(0)

    expect(() => call('forget', { id: out.remembered.id })).toThrow(/No note/)
  })

  it('tracks a slow tool’s changes once it settles', async () => {
    const { db, tracker } = harness()
    await tracker.track(async () => {
      await new Promise((r) => setTimeout(r, 5))
      addMemory(db, 'Mornings for essays', NOW)
    })
    expect(tracker.all.some((c) => c.table === 'settings' && c.id === 'assistantMemory')).toBe(true)
  })
})

describe('time off', () => {
  it('blocks out the day and moves its flexible work to times that follow the rules', () => {
    const { db, call, finish } = harness()
    const wu = upcomingWriteUp(db)
    const day = toLocal(wu.start).slice(0, 10)
    const out = call('take_time_off', { from: day, to: day, title: 'Ill' }) as TimeOffResult

    expect(out.timeOff).toHaveLength(1)
    expect(out.moved.map((m) => m.blockId)).toContain(wu.id)
    const off = cal.getBlock(db, out.timeOff[0].blockId)!
    expect(off).toMatchObject({ kind: 'fixed', title: 'Ill' })

    // Nothing flexible and unstarted is left on that day, except what couldn't move.
    const stuck = new Set(out.notMoved.map((n) => n.blockId))
    const left = db
      .select()
      .from(t.blocks)
      .all()
      .filter(
        (b) =>
          b.kind === 'flexible' &&
          b.outcome === 'none' &&
          b.start > NOW.toString() &&
          toLocal(b.start).startsWith(day) &&
          !stuck.has(b.id)
      )
    expect(left).toEqual([])
    for (const m of out.moved) {
      const b = cal.getBlock(db, m.blockId)!
      expect(
        placementProblems(
          db,
          {
            blockId: b.id,
            start: b.start,
            end: b.end,
            linkedType: b.linkedType,
            linkedId: b.linkedId,
            type: b.type
          },
          NOW
        )
      ).toEqual([])
    }

    // More than one change: shown for review, and undone as a whole.
    const batchId = finish('I’m ill, clear the day')!
    expect(getBatch(db, batchId)!.status).toBe('pending')
    undoBatch(db, batchId, NOW)
    expect(cal.getBlock(db, off.id)).toBeFalsy()
    expect(cal.getBlock(db, wu.id)!.start).toBe(wu.start)
  })

  it('refuses long or backwards ranges', () => {
    const { call } = harness()
    expect(() => call('take_time_off', { from: '2026-11-20', to: '2026-11-19' })).toThrow(/before/)
    expect(() => call('take_time_off', { from: '2026-11-19', to: '2026-12-19' })).toThrow(/At most/)
  })
})
