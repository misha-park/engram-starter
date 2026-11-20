import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppContext } from './app-context'
import * as assignments from './assignments'
import {
  applyBriefPlan,
  cleanBriefDraft,
  extractBriefPlan,
  SUMMARY_SYSTEM,
  summariseAssignment
} from './assistant/brief'
import { ChangeTracker, getBatch, recordBatch, undoBatch } from './assistant/changes'
import { toolsFor, type ToolContext } from './assistant/tools'
import * as files from './attachments'
import * as t from './db/schema'
import * as repo from './repo'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-files-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  const outside = mkdtempSync(join(tmpdir(), 'engram-originals-'))
  const make = (name: string, text: string) => {
    const path = join(outside, name)
    writeFileSync(path, text)
    return path
  }
  return { db: ctx.db, filesDir: ctx.profile.filesDir, records: ctx.profile.recordsDir, make }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const BRIEF = `PHAR0003 Coursework 2: pharmacokinetics lab report. Weighting 40%. Maximum 2,000 words.
Write up the practical as a full lab report (introduction, methods, results with the clearance
calculations, discussion). Submit on Moodle by 12:00 on Thursday 10 December 2026.`

describe('attachments', () => {
  it('saves a copy to a folder under its own name, never overwriting', () => {
    const { db, filesDir, make } = open()
    const [f] = files.addFiles(db, filesDir, [make('Week 3 slides.pdf', 'pdf')], null)
    files.renameAttachment(db, f.id, 'Week 3: slides')
    const out = mkdtempSync(join(tmpdir(), 'engram-downloads-'))
    const first = files.saveCopyTo(db, filesDir, f.id, out)
    const second = files.saveCopyTo(db, filesDir, f.id, out)
    expect(first).toBe(join(out, 'Week 3- slides.pdf'))
    expect(second).toBe(join(out, 'Week 3- slides (2).pdf'))
    expect(readFileSync(second, 'utf8')).toBe('pdf')
  })

  it('seeds the demo essay brief', () => {
    const { db } = open()
    const essay = assignments.listAssignments(db).find((x) => x.title === 'Ion channels essay')!
    expect(
      files.listAttachments(db, { type: 'assignment', id: essay.id }).map((f) => f.name)
    ).toEqual(['NEUR0017 essay brief.txt'])
  })

  it('copies a file into the profile, leaving the original, and lists it on its item', () => {
    const { db, filesDir, make } = open()
    const original = make('Brief.txt', BRIEF)
    const a = assignments.listAssignments(db)[0]
    const [added] = files.addFiles(db, filesDir, [original], { type: 'assignment', id: a.id })
    expect(existsSync(original)).toBe(true)
    expect(readdirSync(filesDir)).toContain(`${added.id}.txt`)
    expect(added).toMatchObject({
      name: 'Brief.txt',
      mime: 'text/plain',
      readable: true,
      targetLabel: a.title
    })
    expect(files.listAttachments(db, { type: 'assignment', id: a.id }).map((f) => f.id)).toEqual([
      added.id
    ])
  })

  it('renames keeping the extension, removes only its own copy, and unfiles orphans', () => {
    const { db, filesDir, make } = open()
    const original = make('notes.pdf', '%PDF-1.4 fake')
    const module = repo.listModules(db)[0]
    const [f] = files.addFiles(db, filesDir, [original], { type: 'module', id: module.id })
    files.renameAttachment(db, f.id, 'Week 3 slides')
    expect(files.getAttachment(db, f.id)!.name).toBe('Week 3 slides.pdf')
    files.removeAttachment(db, filesDir, f.id)
    expect(readdirSync(filesDir)).not.toContain(`${f.id}.pdf`)
    expect(existsSync(original)).toBe(true)

    // An item that's deleted leaves its files unfiled.
    const a = assignments.listAssignments(db)[0]
    const [g] = files.addFiles(db, filesDir, [make('x.txt', 'x')], { type: 'assignment', id: a.id })
    assignments.deleteAssignment(db, a.id, NOW)
    expect(files.getAttachment(db, g.id)!.target).toBeNull()
  })

  it('refuses unknown items, folders and missing files', () => {
    const { db, filesDir, make } = open()
    const path = make('a.txt', 'a')
    expect(() => files.addFiles(db, filesDir, [path], { type: 'assignment', id: 'nope' })).toThrow(
      /no longer exists/
    )
    expect(() => files.addFiles(db, filesDir, [tmpdir()], null)).toThrow(/folder/)
    expect(() => files.addFiles(db, filesDir, ['/no/such/file.txt'], null)).toThrow(
      /can’t be found/
    )
  })

  it('reads text from documents, and says when it can’t', async () => {
    const { db, filesDir, make } = open()
    const [txt, img] = files.addFiles(
      db,
      filesDir,
      [make('b.md', BRIEF), make('p.png', 'png')],
      null
    )
    expect(await files.readAttachmentText(db, filesDir, txt.id)).toContain('PHAR0003')
    expect(img.readable).toBe(false)
    await expect(files.readAttachmentText(db, filesDir, img.id)).rejects.toThrow(/can’t be read/)
  })

  it('keeps a typed or pasted brief as a text file', async () => {
    const { db, filesDir } = open()
    const a = assignments.listAssignments(db)[0]
    const typed = files.addText(db, filesDir, 'Lab report: brief', `  ${BRIEF}  `, {
      type: 'assignment',
      id: a.id
    })
    expect(typed).toMatchObject({
      name: 'Lab report brief.txt',
      mime: 'text/plain',
      readable: true
    })
    expect(await files.readAttachmentText(db, filesDir, typed.id)).toContain('Weighting 40%')
    expect(files.addText(db, filesDir, '', 'x', null).name).toBe('Brief.txt')
    expect(() => files.addText(db, filesDir, 'x', '   ', null)).toThrow(/Type or paste/)
  })
})

describe('Claude and files', () => {
  function harness() {
    const o = open()
    const opened: [string, string | null][] = []
    const ctx: ToolContext = {
      db: o.db,
      recordsDir: o.records,
      now: () => NOW,
      mode: { kind: 'chat' },
      suggest: () => {},
      filesDir: o.filesDir,
      planBrief: (a, b) => opened.push([a, b])
    }
    const tracker = new ChangeTracker(o.db)
    const call = (name: string, args: Record<string, unknown>) => {
      const d = toolsFor({ kind: 'chat' }).find((x) => x.name === name)!
      const parsed = z.object(d.shape).parse(args)
      return d.mutates ? tracker.track(() => d.run(parsed, ctx)) : d.run(parsed, ctx)
    }
    return { ...o, call, tracker, opened }
  }

  it('reads a dropped file, attaches it (shown and undoable) and opens Plan from brief', async () => {
    const { db, filesDir, make, call, tracker, opened } = harness()
    const [f] = files.addFiles(db, filesDir, [make('PHAR CW2 brief.txt', BRIEF)], null)
    const unfiled = (await call('list_files', { unfiled_only: true })) as { id: string }[]
    expect(unfiled.map((x) => x.id)).toEqual([f.id])
    expect(await call('read_file', { file_id: f.id })).toContain('Maximum 2,000 words')

    const a =
      assignments.listAssignments(db).find((x) => x.moduleLabel === 'PHAR') ??
      assignments.listAssignments(db)[0]
    call('attach_file', { file_id: f.id, target_type: 'assignment', target_id: a.id })
    const id = recordBatch(
      db,
      { changes: tracker.all, request: 'file this', conversationId: 'c' },
      NOW
    )!
    const batch = getBatch(db, id)!
    expect(batch.status).toBe('applied')
    expect(batch.lines).toEqual([`Attached “PHAR CW2 brief.txt” to ${a.title}`])
    undoBatch(db, id, NOW, 'undone')
    expect(files.getAttachment(db, f.id)!.target).toBeNull()

    call('plan_assignment_from_brief', { file_id: f.id })
    expect(opened).toEqual([[f.id, null]])
  })
})

describe('planning an assignment from its brief', () => {
  it('asks Claude with the brief, today and the modules, and tidies the answer', async () => {
    let prompt = ''
    const draft = await extractBriefPlan(
      BRIEF,
      Temporal.PlainDate.from('2026-11-18'),
      [{ id: 'phar', label: 'PHAR0003 · Pharmacology' }],
      async (_system, p) => {
        prompt = p
        return {
          title: 'PK lab report',
          moduleId: 'phar',
          type: 'lab-report',
          dueDate: '2026-12-10',
          dueTime: '12:00',
          weighting: 40,
          wordLimit: 2000,
          stages: [
            { name: 'Read the brief', minutes: 20 },
            { name: 'Analyse the data', minutes: 200 },
            { name: '', minutes: 60 }
          ]
        }
      }
    )
    expect(prompt).toContain('Today is 2026-11-18')
    expect(prompt).toContain('- phar: PHAR0003 · Pharmacology')
    expect(draft.stages).toEqual([
      { name: 'Read the brief', minutes: 15 },
      { name: 'Analyse the data', minutes: 195 }
    ])
    expect(
      cleanBriefDraft(
        { moduleId: 'other', type: 'poem', dueDate: '2026-02-30', dueTime: '25:00' },
        ['phar']
      )
    ).toMatchObject({
      moduleId: null,
      type: 'other',
      dueDate: null,
      dueTime: null,
      stages: []
    })
  })

  it('creates a new assignment with the planned stages and attaches the brief', () => {
    const { db, filesDir, make } = open()
    const [f] = files.addFiles(db, filesDir, [make('brief.txt', BRIEF)], null)
    const module = repo.listModules(db)[0]
    const id = applyBriefPlan(
      db,
      {
        title: 'PK lab report',
        moduleId: module.id,
        type: 'lab-report',
        dueDate: '2026-12-10',
        dueTime: '12:00',
        weighting: 40,
        wordLimit: 2000,
        summary: 'You write a lab report on the pharmacokinetics practical.',
        stages: [
          { name: 'Read the brief', minutes: 30 },
          { name: 'Analyse the data', minutes: 180 },
          { name: 'Write up', minutes: 240 }
        ]
      },
      { attachmentId: f.id },
      NOW
    )
    const a = assignments.getAssignment(db, id)!
    expect(a.due).toBe('2026-12-10T12:00:00Z')
    expect(a.summary).toBe('You write a lab report on the pharmacokinetics practical.')
    expect(a.stages.map((s) => [s.name, s.estimateMinutes])).toEqual([
      ['Read the brief', 30],
      ['Analyse the data', 180],
      ['Write up', 240]
    ])
    expect(files.getAttachment(db, f.id)!.target).toEqual({ type: 'assignment', id })
    // Stage blocks were planned.
    const blocks = db
      .select()
      .from(t.blocks)
      .where(eq(t.blocks.linkedType, 'assignment-stage'))
      .all()
    expect(blocks.some((b) => a.stages.some((s) => s.id === b.linkedId))).toBe(true)
  })

  it('re-plans an existing assignment, keeping stages already started', () => {
    const { db } = open()
    const a = assignments.listAssignments(db).find((x) => x.status === 'in-progress')!
    const before = assignments.getAssignment(db, a.id)!
    const started = before.stages.filter((s) => s.done || (s.loggedMinutes ?? 0) > 0)
    expect(started.length).toBeGreaterThan(0)
    applyBriefPlan(
      db,
      {
        title: null,
        moduleId: null,
        type: before.type,
        dueDate: null,
        dueTime: null,
        weighting: 25,
        wordLimit: null,
        summary: null,
        stages: [
          { name: started[0].name, minutes: 60 },
          { name: 'Check against the marking criteria', minutes: 45 }
        ]
      },
      { assignmentId: a.id },
      NOW
    )
    const after = assignments.getAssignment(db, a.id)!
    expect(after.title).toBe(before.title)
    expect(after.weighting).toBe(25)
    expect(after.stages.map((s) => s.name)).toEqual([
      ...started.map((s) => s.name),
      'Check against the marking criteria'
    ])
  })
})

describe('summarising an assignment from its brief', () => {
  it('reads the attached brief and keeps the summary on the assignment', async () => {
    const { db, filesDir, make } = open()
    const a = assignments.listAssignments(db)[0]
    files.addFiles(
      db,
      filesDir,
      [make('marking criteria.txt', 'Marks for argument and evidence. '.repeat(3))],
      { type: 'assignment', id: a.id }
    )
    files.addFiles(db, filesDir, [make('coursework brief.txt', BRIEF)], {
      type: 'assignment',
      id: a.id
    })
    let asked = ''
    const summary = await summariseAssignment(
      db,
      filesDir,
      a.id,
      async (system, prompt) => {
        expect(system).toBe(SUMMARY_SYSTEM)
        asked = prompt
        return { summary: 'You write a 2,000-word lab report on the pharmacokinetics practical.' }
      },
      NOW
    )
    expect(asked).toContain('pharmacokinetics lab report') // it read the brief, not the criteria
    expect(summary).toMatch(/lab report/)
    expect(assignments.getAssignment(db, a.id)!.summary).toBe(summary)
  })

  it('needs a readable brief', async () => {
    const { db, filesDir } = open()
    const a = assignments
      .listAssignments(db)
      .find((x) => !files.listAttachments(db, { type: 'assignment', id: x.id }).length)!
    expect(
      await summariseAssignment(db, filesDir, a.id, async () => ({ summary: 'x' }), NOW)
    ).toBeNull()
  })
})
