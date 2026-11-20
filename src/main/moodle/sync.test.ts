import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from '../app-context'
import { attachmentPath, listAttachments, removeAttachment } from '../attachments'
import { listNotifications } from '../backlog'
import * as t from '../db/schema'
import { mergeWithPrevious, renameLecture } from '../timetable'
import { getOrganiseStatus, organiseModule } from './lectures'
import { FixtureMoodle, type MoodleSource } from './source'
import {
  listCourses,
  moduleMoodleFiles,
  MoodleSync,
  setCourseModule,
  setFileLecture,
  syncCourse
} from './sync'

const migrations = resolve(__dirname, '../../../drizzle')
const fixtures = resolve(__dirname, '../../../resources/fixtures')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

function demo() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-moodle-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  const sync = new MoodleSync({
    db: () => ctx.db,
    now: () => NOW,
    filesDir: () => ctx.profile.filesDir,
    source: () => new FixtureMoodle(fixtures, () => NOW),
    demo: () => true,
    changed: () => {}
  })
  return { ctx, db: ctx.db, sync }
}

const names = (files: { name: string }[]) => files.map((f) => f.name).sort()

describe('Moodle downloads (demo stand-in)', () => {
  it('a merged lecture’s slides belong to its first session, whichever session is picked', async () => {
    const { db, sync } = demo()
    expect((await sync.syncNow()).lastError).toBeNull()
    const neur = db
      .select({ l: t.lectures, start: t.blocks.start })
      .from(t.lectures)
      .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
      .where(eq(t.lectures.moduleId, 'neur'))
      .all()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((r) => r.l)
    const [first, second] = neur
    mergeWithPrevious(db, second.id, NOW)
    const slides = moduleMoodleFiles(db, 'neur')
      .flatMap((g) => g.files)
      .find((f) => /slides/i.test(f.name))!
    const lectureOf = () =>
      moduleMoodleFiles(db, 'neur')
        .flatMap((g) => g.files)
        .find((f) => f.id === slides.id)!.lectureId
    // Picking the later session stores the first.
    setFileLecture(db, slides.id, second.id)
    expect(lectureOf()).toBe(first.id)
    // A tag already on the later session (e.g. from before) reads as the first's.
    db.update(t.moodleItems)
      .set({ lectureId: second.id })
      .where(eq(t.moodleItems.attachmentId, slides.id))
      .run()
    expect(lectureOf()).toBe(first.id)
  })

  it('matches this year’s courses to modules and fetches their files and briefs', async () => {
    const { ctx, db, sync } = demo()
    expect((await sync.syncNow()).lastError).toBeNull()
    // Last year's course is left out; the ones that look like modules are matched.
    expect(listCourses(db).map((c) => [c.id, c.moduleId])).toEqual([
      [9001, 'neur'],
      [9002, 'phar'],
      [9003, null]
    ])

    const groups = moduleMoodleFiles(db, 'neur')
    expect(groups.map((g) => [g.section, g.week, names(g.files)])).toEqual([
      ['Module overview', null, ['NEUR module handbook.pdf']],
      ['Week 11: Ion channels', 11, ['Ion channels slides.pdf']],
      [
        'Week 12: Synaptic transmission',
        12,
        ['Synapse workshop handout.pdf', 'Synaptic transmission slides.pdf']
      ]
    ])
    // The copy is the file Moodle sent.
    const slides = groups[1].files[0]
    expect(
      readFileSync(attachmentPath(db, ctx.profile.filesDir, slides.id))
        .subarray(0, 5)
        .toString()
    ).toBe('%PDF-')

    // The NEUR brief matched the Ion channels essay: description and marking criteria.
    const essay = db
      .select()
      .from(t.assignments)
      .where(eq(t.assignments.title, 'Ion channels essay'))
      .get()!
    expect(names(listAttachments(db, { type: 'assignment', id: essay.id }))).toEqual(
      expect.arrayContaining([
        'Ion channels essay (Level 6 Students) (brief).txt',
        'NEUR essay marking criteria.pdf'
      ])
    )
    // The PHAR brief matches no assignment: it waits in the module, with a notification.
    const notes = listNotifications(db, NOW).filter((n) => n.kind === 'moodle-brief')
    expect(notes.map((n) => n.title)).toEqual(['Receptor binding problem sheet'])
    expect(names(listAttachments(db, { type: 'module', id: 'phar' }))).toContain(
      'Receptor binding problem sheet (brief).txt'
    )
  })

  it('fetches each file once, and never brings back one the user deleted', async () => {
    const { ctx, db, sync } = demo()
    await sync.syncNow()
    const count = () => db.select().from(t.attachments).all().length
    const before = count()
    await sync.syncNow()
    expect(count()).toBe(before)
    const handbook = moduleMoodleFiles(db, 'neur')[0].files[0]
    removeAttachment(db, ctx.profile.filesDir, handbook.id)
    await sync.syncNow()
    expect(count()).toBe(before - 1)
    expect(moduleMoodleFiles(db, 'neur')[0].section).not.toBe('Module overview')
  })

  it('syncs only courses matched to a module', async () => {
    const { db, sync } = demo()
    await sync.refreshCourses()
    setCourseModule(db, 9002, null)
    await sync.syncNow()
    expect(moduleMoodleFiles(db, 'phar')).toEqual([])
    expect(listCourses(db).find((c) => c.id === 9002)?.moduleId).toBeNull()
  })
})

describe('a changed file on Moodle', () => {
  it('replaces the copy in place', async () => {
    const { ctx, db } = demo()
    let version = 1
    const source: MoodleSource = {
      courses: async () => [],
      contents: async () => [
        {
          name: 'Week 12: Topic',
          modules: [
            {
              id: 1,
              instance: 1,
              modname: 'resource',
              name: 'Slides',
              contents: [
                {
                  type: 'file',
                  filename: 'slides.pdf',
                  filepath: '/',
                  fileurl: 'x',
                  filesize: 10,
                  timemodified: version
                }
              ]
            }
          ]
        }
      ],
      briefFiles: async () => [],
      download: async () => Buffer.from(`version ${version}`),
      forums: async () => [],
      discussions: async () => [],
      posts: async () => [],
      contacts: async () => new Map(),
      roles: async () => new Map()
    }
    expect(
      await syncCourse(db, ctx.profile.filesDir, source, { id: 1, moduleId: 'neur' })
    ).toMatchObject({ added: 1 })
    const id = db.select().from(t.moodleItems).get()!.attachmentId!
    version = 2
    expect(
      await syncCourse(db, ctx.profile.filesDir, source, { id: 1, moduleId: 'neur' })
    ).toMatchObject({ added: 0, updated: 1 })
    expect(readFileSync(attachmentPath(db, ctx.profile.filesDir, id), 'utf8')).toBe('version 2')
    expect(
      db
        .select()
        .from(t.attachments)
        .all()
        .filter((a) => a.name === 'slides.pdf')
    ).toHaveLength(1)
  })
})

describe('organising lectures with Claude', () => {
  /** A stand-in for Claude: names every lecture "Topic N", suggests splitting the first two-hour
   * PHAR slot, and puts "slides" files on the first lecture of their week. */
  const fakeClaude = (calls: string[]) => async (system: string, prompt: string) => {
    calls.push(system.slice(0, 20))
    if (!system.startsWith('You organise')) return { summary: null }
    const lectures = [...prompt.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({
      number: Number(m[1]),
      line: m[2],
      week: Number(/teaching week (\d+)/.exec(m[2])?.[1])
    }))
    const twoHour = lectures.find((l) => /\(120 min/.test(l.line))
    const files: { id: string; lecture: number | null }[] = []
    let week: number | null = null
    for (const line of prompt.split('\n')) {
      const sec = /^Section “(?:Week (\d+))?/.exec(line)
      if (sec) week = sec[1] ? Number(sec[1]) : null
      const f = /^- (f\d+): “([^”]*)”/.exec(line)
      if (f)
        files.push({
          id: f[1],
          lecture: /slides/i.test(f[2])
            ? (lectures.find((l) => l.week === week)?.number ?? null)
            : null
        })
    }
    return {
      lectures: lectures.map((l) =>
        l === twoHour
          ? {
              number: l.number,
              title: null,
              parts: [
                { title: 'Part one', start: '10:00', end: '11:00' },
                { title: 'Part two', start: '11:00', end: '12:00' }
              ]
            }
          : { number: l.number, title: `Topic ${l.number}`, parts: null }
      ),
      files
    }
  }

  it('names lectures, tags slides and suggests splits, and leaves what you set alone', async () => {
    const { ctx, db } = demo()
    const calls: string[] = []
    const sync = new MoodleSync({
      db: () => ctx.db,
      now: () => NOW,
      filesDir: () => ctx.profile.filesDir,
      source: () => new FixtureMoodle(fixtures, () => NOW),
      demo: () => true,
      changed: () => {},
      completeJson: () => fakeClaude(calls)
    })
    // You name one NEUR lecture first.
    const mine = db.select().from(t.lectures).where(eq(t.lectures.moduleId, 'neur')).all()[0]
    renameLecture(db, mine.id, 'My own name')

    expect((await sync.syncNow()).lastError).toBeNull()
    const phar = db.select().from(t.lectures).where(eq(t.lectures.moduleId, 'phar')).all()
    expect(phar.filter((l) => l.title?.startsWith('Topic')).length).toBe(phar.length - 1)
    const status = getOrganiseStatus(db, 'phar')!
    expect(status.listName).toBe('PHAR0099 Teaching schedule.txt')
    expect(status.splits).toHaveLength(1)
    expect(status.splits[0].cuts).toEqual([60])
    expect(status.splits[0].parts.map((p) => p.title)).toEqual(['Part one', 'Part two'])
    // Your name stays.
    expect(db.select().from(t.lectures).where(eq(t.lectures.id, mine.id)).get()!.title).toBe(
      'My own name'
    )

    // Slides got a lecture of their week; the handout stayed with the week.
    const neurFiles = moduleMoodleFiles(db, 'neur').flatMap((g) => g.files)
    expect(neurFiles.find((f) => f.name === 'Synapse workshop handout.pdf')!.lectureId).toBeNull()
    const slides = moduleMoodleFiles(db, 'phar')
      .flatMap((g) => g.files)
      .find((f) => f.name === 'GPCR signalling slides.pdf')!
    expect(slides.lectureId).not.toBeNull()

    // A file you place by hand stays where you put it.
    setFileLecture(db, slides.id, null)
    const before = calls.filter((c) => c.startsWith('You organise')).length
    await sync.syncNow()
    // Nothing new on Moodle, but your change counts as a change: organised again, file kept.
    expect(
      moduleMoodleFiles(db, 'phar')
        .flatMap((g) => g.files)
        .find((f) => f.name === 'GPCR signalling slides.pdf')!.lectureId
    ).toBeNull()
    // And a further sync with nothing new asks Claude nothing.
    const after = calls.filter((c) => c.startsWith('You organise')).length
    await sync.syncNow()
    expect(calls.filter((c) => c.startsWith('You organise')).length).toBe(after)
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('does nothing for a module with Claude switched off, unless asked', async () => {
    const { ctx, db } = demo()
    db.update(t.modules).set({ autoOrganise: false }).where(eq(t.modules.id, 'phar')).run()
    const calls: string[] = []
    expect(
      await organiseModule(db, ctx.profile.filesDir, 'phar', fakeClaude(calls), NOW)
    ).toBeNull()
    expect(calls).toHaveLength(0)
    expect(
      await organiseModule(db, ctx.profile.filesDir, 'phar', fakeClaude(calls), NOW, {
        force: true
      })
    ).not.toBeNull()
  })
})
