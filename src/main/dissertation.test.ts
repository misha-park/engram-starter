import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppContext } from './app-context'
import { cleanDraft, extractPlan, readProposal } from './assistant/plan'
import { ChangeTracker, getBatch, recordBatch } from './assistant/changes'
import { toolsFor } from './assistant/tools'
import * as cal from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import * as diss from './dissertation'
import { recordPath, targetForBlock } from './records'
import * as repo from './repo'
import * as ses from './sessions'
import {
  collectionPaths,
  creatorSummary,
  FixtureZotero,
  LocalZotero,
  withSubcollections
} from './zotero'

const migrations = resolve(__dirname, '../../drizzle')
const fixture = resolve(__dirname, '../../resources/fixtures/zotero-demo.json')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open(): { db: Db; records: string } {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-di-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return { db: ctx.db, records: ctx.profile.recordsDir }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

describe('the demo dissertation', () => {
  it('has a plan, timeline, reading list, meeting and sessions', () => {
    const { db } = open()
    const o = diss.getOverview(db, NOW)
    expect(o.sections).toHaveLength(7)
    expect(o.wordCount).toBe(1220)
    expect(o.milestones.filter((m) => m.doneAt)).toHaveLength(2)
    expect(o.reading).toHaveLength(12) // the note in the fixture is left out
    expect(o.reading.filter((r) => r.status === 'notes-done')).toHaveLength(4)
    expect(o.meetings[0].actions.map((a) => a.done)).toEqual([true, false, false])
    expect(o.sections[1].loggedMinutes).toBe(85)
    expect(o.sections[0].upcoming).toHaveLength(1)
    expect(o.colour).toBe('#f75482')
    // Submission, the viva and milestones show as deadlines.
    const all = repo.listDeadlines(db, '2026-11-01T00:00:00Z', '2027-12-31T00:00:00Z')
    const titles = all.filter((d) => d.kind === 'dissertation').map((d) => d.title)
    expect(titles).toEqual(
      expect.arrayContaining(['Dissertation due', 'Your viva', 'Full first draft'])
    )
    expect(titles).not.toContain('Proposal approved') // done
  })
})

describe('reading list', () => {
  it('reads Zotero collections with their paths, and names authors', async () => {
    const zotero = new FixtureZotero(fixture)
    const cols = await zotero.collections()
    expect(cols.map((c) => c.path)).toEqual([
      'Literature project',
      'Literature project / Microglia and pruning',
      'Other reading'
    ])
    const items = await zotero.items('DEMOLITR')
    expect(items.some((i) => i.data.itemType === 'note')).toBe(false)
    expect(creatorSummary(items[0])).toBe('Hartley & Okafor')
    expect(creatorSummary(items[1])).toBe('Lindqvist et al.')
    expect(collectionPaths([])).toEqual([])
  })

  it('keeps statuses and links on a re-sync, and marks items that left the collection', async () => {
    const { db } = open()
    const items = await new FixtureZotero(fixture).items('DEMOLITR')
    const before = diss.getOverview(db, NOW).reading.find((r) => r.id === 'DEMO0001')!
    const result = diss.syncReading(db, items.slice(1), NOW)
    expect(result).toEqual({ added: 0, updated: 11, missing: 1 })
    const after = diss.getOverview(db, NOW).reading.find((r) => r.id === 'DEMO0001')!
    expect(after.missing).toBe(true)
    expect(after.status).toBe(before.status)
    expect(
      diss.getOverview(db, NOW).reading.find((r) => r.id === 'DEMO0002')!.sectionIds.length
    ).toBeGreaterThan(0)
  })

  it('unlinks a removed section', () => {
    const { db } = open()
    const section = diss.getOverview(db, NOW).sections[4]
    diss.removeSection(db, section.id)
    expect(diss.getOverview(db, NOW).reading.some((r) => r.sectionIds.includes(section.id))).toBe(
      false
    )
  })
})

describe('meetings', () => {
  it('turns action items into todos, and archives ones taken off the list', () => {
    const { db } = open()
    const id = diss.saveMeeting(db, {
      at: '2026-11-18T13:00:00Z',
      notes: 'Talked about the discussion.',
      actions: ['Find two reviews on astrocytes', ' ', 'Draft the discussion outline']
    })
    const actions = () => diss.getOverview(db, NOW).meetings.find((m) => m.id === id)!.actions
    expect(actions().map((a) => a.text)).toEqual([
      'Find two reviews on astrocytes',
      'Draft the discussion outline'
    ])
    const todo = db.select().from(t.todos).where(eq(t.todos.id, actions()[0].todoId!)).get()!
    expect(todo.dueDate).toBe('2026-11-25')
    expect(todo.source).toBe('meeting')
    const dropped = actions()[1].todoId!
    diss.saveMeeting(db, {
      id,
      at: '2026-11-18T13:00:00Z',
      notes: 'x',
      actions: ['Find two reviews on astrocytes']
    })
    expect(actions()).toHaveLength(1)
    expect(db.select().from(t.todos).where(eq(t.todos.id, dropped)).get()!.archived).toBe(true)
  })
})

describe('sessions', () => {
  it('are ordinary blocks with their own record and logged time', () => {
    const { db, records } = open()
    const section = diss.getOverview(db, NOW).sections[2]
    const id = diss.scheduleSession(db, section.id, { minutes: 60 }, NOW)
    const block = cal.getBlock(db, id)!
    expect(block.type).toBe('dissertation')
    expect(block.categoryId).toBe('proj')
    ses.markOutcome(db, records, id, { outcome: 'done', minutes: 50 }, NOW)
    const path = recordPath(db, records, targetForBlock(db, block))!
    expect(path).toMatch(
      /dissertation\/Microglia origins and functions\.md$|dissertation\/Microglia.*\.md$/
    )
    expect(existsSync(path)).toBe(true)
    expect(diss.getOverview(db, NOW).sections[2].loggedMinutes).toBe(50)
  })
})

describe('plan import', () => {
  it('cleans what Claude returns and only adds new sections', () => {
    const draft = cleanDraft({
      title: '  A review ',
      sections: [
        { title: 'Introduction', wordTarget: 900 },
        { title: ' New chapter ', wordTarget: -3 },
        { title: '' }
      ],
      milestones: [
        { title: 'Draft', due: '2027-02-30' },
        { title: 'Search done', due: '2026-12-01' },
        { title: 'Submission', due: '2027-04-01' },
        { title: 'Viva', due: '2027-04-20' }
      ],
      submissionDue: '2027-04-01',
      wordTarget: 8000
    })
    expect(draft.sections).toEqual([
      { title: 'Introduction', wordTarget: 900 },
      { title: 'New chapter', wordTarget: null }
    ])
    expect(draft.milestones).toEqual([{ title: 'Search done', due: '2026-12-01' }])
    const { db } = open()
    expect(diss.applyPlan(db, draft)).toEqual({ sections: 1, milestones: 1 })
    expect(diss.getSettings(db).title).toBe('A review')
    expect(diss.getSettings(db).submissionDue).toBe('2027-04-01T11:00:00Z')
  })

  it('asks Claude with the proposal and today, and refuses a near-empty one', async () => {
    let prompt = ''
    const draft = await extractPlan(
      'A literature review of microglia in synaptic pruning, 8000 words.',
      Temporal.PlainDate.from('2026-11-18'),
      async (_s, p) => {
        prompt = p
        return {
          title: null,
          sections: [{ title: 'Intro', wordTarget: null }],
          milestones: [],
          submissionDue: null,
          wordTarget: 8000
        }
      }
    )
    expect(prompt).toMatch(/Today is 2026-11-18/)
    expect(draft.wordTarget).toBe(8000)
    await expect(
      extractPlan('too short', Temporal.PlainDate.from('2026-11-18'), async () => ({}))
    ).rejects.toThrow(/more/)
  })

  it('reads text and Word files (macOS textutil)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-prop-'))
    const txt = join(dir, 'proposal.txt')
    writeFileSync(txt, 'Project proposal: a literature review on microglia.')
    expect(await readProposal(txt)).toMatch(/microglia/)
    execFileSync('/usr/bin/textutil', [
      '-convert',
      'docx',
      txt,
      '-output',
      join(dir, 'proposal.docx')
    ])
    expect(await readProposal(join(dir, 'proposal.docx'))).toMatch(/literature review on microglia/)
    await expect(readProposal(join(dir, 'x.xyz'))).rejects.toThrow()
  })
})

describe('the dissertation assistant', () => {
  it('has its own conversation with dissertation tools, tracked for undo', () => {
    const { db, records } = open()
    const mode = { kind: 'dissertation' } as const
    const names = toolsFor(mode).map((d) => d.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'get_dissertation',
        'update_dissertation_section',
        'schedule_dissertation_session'
      ])
    )
    const tracker = new ChangeTracker(db)
    const ctx = {
      db,
      recordsDir: records,
      now: () => NOW,
      mode,
      suggest: () => {},
      filesDir: '/nonexistent',
      planBrief: () => {}
    }
    const call = (name: string, args: Record<string, unknown>) => {
      const d = toolsFor(mode).find((x) => x.name === name)!
      return tracker.track(() => d.run(z.object(d.shape).parse(args), ctx))
    }
    const section = diss.getOverview(db, NOW).sections[3]
    call('update_dissertation_section', {
      section_id: section.id,
      status: 'drafting',
      word_count: 400
    })
    const id = recordBatch(db, { changes: tracker.all, request: 'x', conversationId: null }, NOW)!
    expect(getBatch(db, id)!.lines).toEqual([
      'Section “Synaptic pruning in development” → drafting'
    ])
  })
})

describe('Zotero folders', () => {
  const col = (key: string, name: string, parent: string | false, numItems: number) => ({
    key,
    data: { name, parentCollection: parent },
    meta: { numItems }
  })
  const list = [
    col('DISSMAIN', 'Dissertation', false, 2),
    col('TOPICAAA', 'Methods', 'DISSMAIN', 30),
    col('TOPICBBB', 'Background', 'DISSMAIN', 5),
    col('DEEPERCC', 'Old papers', 'TOPICBBB', 1),
    col('OTHERDDD', 'Another module', false, 4)
  ]

  it('lists them as a tree, each parent before its children, counting subfolders', () => {
    const tree = collectionPaths(list)
    expect(tree.map((c) => [c.name, c.depth, c.numItems])).toEqual([
      ['Another module', 0, 4],
      ['Dissertation', 0, 38],
      ['Background', 1, 6],
      ['Old papers', 2, 1],
      ['Methods', 1, 30]
    ])
    expect(tree.find((c) => c.key === 'DEEPERCC')!.path).toBe(
      'Dissertation / Background / Old papers'
    )
    expect(withSubcollections(list, 'DISSMAIN')).toEqual([
      'DISSMAIN',
      'TOPICAAA',
      'TOPICBBB',
      'DEEPERCC'
    ])
  })

  it('reads the main folder with all its subfolders, every page, each item once', async () => {
    const item = (key: string) => ({ key, data: { itemType: 'journalArticle', title: key } })
    const contents: Record<string, ReturnType<typeof item>[]> = {
      DISSMAIN: [item('A'), item('B')],
      TOPICAAA: Array.from({ length: 130 }, (_, i) => item(`M${i}`)),
      TOPICBBB: [item('B'), item('C')], // B is in two folders
      DEEPERCC: [item('D')],
      OTHERDDD: [item('X')]
    }
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url)
      const start = Number(u.searchParams.get('start') ?? 0)
      const limit = Number(u.searchParams.get('limit') ?? 25)
      const m = /collections\/([A-Z]+)\/items/.exec(u.pathname)
      const all = m ? contents[m[1]] : list
      return new Response(JSON.stringify(all.slice(start, start + limit)))
    }) as typeof fetch
    try {
      const z = new LocalZotero('http://zotero.test/api/users/0')
      expect(await z.collections()).toHaveLength(5)
      const items = await z.items('DISSMAIN')
      expect(items).toHaveLength(2 + 130 + 1 + 1) // A, B, M0–M129, C, D
      expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
      expect(items.some((i) => i.key === 'X')).toBe(false)
    } finally {
      globalThis.fetch = real
    }
  })
})
