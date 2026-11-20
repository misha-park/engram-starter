import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssistantEvent, BatchSummary } from '../../../shared/types'
import { AppContext } from '../../app-context'
import * as backlog from '../../backlog'
import * as cal from '../../calendar'
import type { Db } from '../../db/client'
import * as t from '../../db/schema'
import { addMemory, listMemories } from '../memory'
import {
  dayLabel,
  freeSlots,
  parseLocal,
  placementProblems,
  toLocal,
  writeUpDeadline
} from '../placement'
import { Assistant, assistantEnv } from '../runner'

// Typical requests sent to the real assistant (Claude, through the Agent SDK) against a fresh
// demo database each, checking what ends up in the database rather than the wording of the
// reply. Run by hand after changing the prompt or the tools, with the token from
// `claude setup-token`:
//
//   CLAUDE_CODE_OAUTH_TOKEN=… npm run eval:assistant
//
// or, signed in to Claude Code on this Mac, `ENGRAM_EVAL_LOGIN=1 npm run eval:assistant`.
// Each request uses the user's Claude plan. Without either, everything is skipped.

const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''
/** ENGRAM_EVAL_LOGIN=1: use this Mac's Claude Code login instead of a token. */
const OWN_LOGIN = process.env.ENGRAM_EVAL_LOGIN === '1'
const migrations = resolve(__dirname, '../../../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00 London

const contexts: AppContext[] = []
afterAll(() => contexts.splice(0).forEach((c) => c.close()))

interface Turn {
  db: Db
  reply: string
  tools: string[]
  error: string | null
  batch: BatchSummary | null
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-eval-'))
  const app = new AppContext(dir, migrations, { clock: () => NOW })
  contexts.push(app)
  app.open()
  return app
}

/** Send one message in a new chat and collect what happened. */
async function ask(message: string, app: AppContext = fresh()): Promise<Turn> {
  let reply = ''
  const tools: string[] = []
  let error: string | null = null
  const assistant = new Assistant({
    db: () => app.db,
    recordsDir: () => app.profile.recordsDir,
    filesDir: () => app.profile.filesDir,
    now: () => NOW,
    token: async () => TOKEN || 'claude-code-login',
    // With no token, the Claude Code process signs in as it does in a terminal.
    env: (token) => {
      const env = assistantEnv(token)
      if (!TOKEN) delete env.CLAUDE_CODE_OAUTH_TOKEN
      return env
    },
    workDir: mkdtempSync(join(tmpdir(), 'engram-eval-sdk-')),
    emit: (e: AssistantEvent) => {
      if (e.type === 'text') reply += e.text
      if (e.type === 'tool') tools.push(e.name)
      if (e.type === 'error') error = e.message
    },
    dataChanged: () => {}
  })
  const batch = await assistant.send({
    conversationId: `eval-${Math.random().toString(36).slice(2)}`,
    message,
    mode: { kind: 'chat' }
  })
  console.log(
    `\n» ${message}\n  tools: ${tools.join(', ') || '(none)'}\n  ${reply.trim().replace(/\n/g, '\n  ')}`
  )
  return { db: app.db, reply, tools, error, batch }
}

/** Every flexible block the turn placed follows the rules (or is flagged as late on purpose). */
function expectRulesKept(turn: Turn) {
  for (const change of turn.batch?.blocks ?? []) {
    const b = cal.getBlock(turn.db, change.blockId)
    if (!b || b.kind !== 'flexible' || b.outcome !== 'none') continue
    if (b.attention) continue
    expect(
      placementProblems(
        turn.db,
        {
          blockId: b.id,
          start: b.start,
          end: b.end,
          linkedType: b.linkedType,
          linkedId: b.linkedId,
          type: b.type
        },
        NOW
      ),
      `“${b.title}” at ${toLocal(b.start)}`
    ).toEqual([])
  }
}

/** The next write-up after now (the demo seed always has some). */
function nextWriteUp(db: Db) {
  return db
    .select()
    .from(t.blocks)
    .all()
    .filter((b) => b.type === 'write-up' && b.outcome === 'none' && b.start > NOW.toString())
    .sort((a, b) => a.start.localeCompare(b.start))[0]
}

const run = TOKEN || OWN_LOGIN ? describe : describe.skip

run('the assistant, for real', () => {
  it('“skip it tonight” moves a write-up within its limit', async () => {
    const app = fresh()
    const wu = nextWriteUp(app.db)
    const turn = await ask(`Skip the ${wu.title} today, I can’t do it.`, app)
    expect(turn.error).toBeNull()
    const moved = cal.getBlock(turn.db, wu.id)!
    expect(moved.start).not.toBe(wu.start)
    expect(moved.end <= writeUpDeadline(turn.db, wu.linkedId!)!).toBe(true)
    expectRulesKept(turn)
  })

  it('moves a write-up past its limit only because the user asked, and flags it', async () => {
    const app = fresh()
    const wu = nextWriteUp(app.db)
    const limit = writeUpDeadline(app.db, wu.linkedId!)!
    const after = Temporal.Instant.from(limit).toZonedDateTimeISO('Europe/London').toPlainDate()
    const slot = freeSlots(
      app.db,
      {
        from: after.add({ days: 1 }).toString(),
        to: after.add({ days: 10 }).toString(),
        minutes: 120
      },
      NOW
    )[0].slots[0]
    const at = slot.start
    const turn = await ask(
      `Move the ${wu.title} to ${dayLabel(parseLocal(at))} at ${at.slice(11)}. I know it’s late.`,
      app
    )
    const moved = cal.getBlock(turn.db, wu.id)!
    expect(toLocal(moved.start)).toBe(at)
    expect(moved.attention).toMatch(/Past the write-up limit/)
  })

  it('clears a day off and keeps every rule', async () => {
    const turn = await ask('I’m ill tomorrow, clear Thursday for me.')
    expect(turn.tools).toContain('take_time_off')
    const thursday = turn.db
      .select()
      .from(t.blocks)
      .all()
      .filter((b) => toLocal(b.start).startsWith('2026-11-19'))
    expect(
      thursday.some((b) => b.kind === 'fixed' && b.source === 'user' && b.type === 'other')
    ).toBe(true)
    expectRulesKept(turn)
  })

  it('remembers a preference', async () => {
    const turn = await ask('From now on, never put write-ups after 21:00. Please remember that.')
    const notes = listMemories(turn.db)
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toMatch(/21/)
  })

  it('forgets a preference when asked', async () => {
    const app = fresh()
    addMemory(app.db, 'Keep Fridays light', NOW)
    addMemory(app.db, 'Essays in the mornings', NOW)
    const turn = await ask('Forget what I said about Fridays.', app)
    expect(listMemories(turn.db).map((m) => m.text)).toEqual(['Essays in the mornings'])
  })

  it('adds a todo', async () => {
    const turn = await ask('Add a todo to email my personal tutor.')
    const todos = turn.db.select().from(t.todos).all()
    expect(todos.some((td) => /tutor/i.test(td.title))).toBe(true)
  })

  it('adds a general deadline', async () => {
    const turn = await ask('Add a deadline: lab report due Friday 4 December at 17:00.')
    const d = turn.db
      .select()
      .from(t.deadlines)
      .all()
      .find((x) => /lab report/i.test(x.title))
    expect(d && toLocal(d.due)).toBe('2026-12-04T17:00')
  })

  it('marks a past block done', async () => {
    const app = fresh()
    const past = app.db
      .select()
      .from(t.blocks)
      .all()
      .filter((b) => b.kind === 'flexible' && b.outcome === 'none' && b.end < NOW.toString())
      .sort((a, b) => b.end.localeCompare(a.end))[0]
    const turn = await ask(`I did the ${past.title} on ${dayLabel(past.start)}, mark it done.`, app)
    expect(cal.getBlock(turn.db, past.id)!.outcome).toBe('done')
  })

  it('fits the Backlog in without breaking rules', async () => {
    const app = fresh()
    const before = backlog.listBacklog(app.db, NOW).filter((i) => i.minutes).length
    const turn = await ask('Fit my Backlog into this week.', app)
    const after = backlog.listBacklog(turn.db, NOW).filter((i) => i.minutes).length
    if (before > 0) expect(after).toBeLessThan(before)
    expectRulesKept(turn)
  })

  it('answers questions without changing anything', async () => {
    const turn = await ask('What’s due in the next two weeks?')
    expect(turn.batch).toBeNull()
    expect(turn.reply.trim().length).toBeGreaterThan(0)
  })

  it('uses the stats for study-time questions', async () => {
    const turn = await ask('How many hours did I study over the last 4 weeks?')
    expect(turn.tools).toContain('get_stats')
    expect(turn.batch).toBeNull()
  })

  it('finds things by name', async () => {
    const turn = await ask('When is my next Pharmacology practical?')
    expect(turn.tools.some((n) => n === 'find' || n === 'get_schedule')).toBe(true)
    expect(turn.batch).toBeNull()
  })

  it('won’t write coursework, briefly', async () => {
    const turn = await ask('Write the introduction to my pharmacology essay for me.')
    expect(turn.batch).toBeNull()
    expect(turn.reply.length).toBeLessThan(600)
  })
})
