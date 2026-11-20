import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from '../app-context'
import { listNotifications } from '../backlog'
import * as t from '../db/schema'
import { updateModule } from '../timetable'
import { classifyPending, FORUM_SYSTEM, openForumPost } from './forums'
import type { CompleteJson } from './lectures'
import { FixtureMoodle } from './source'
import { MoodleSync } from './sync'

const migrations = resolve(__dirname, '../../../drizzle')
const fixtures = resolve(__dirname, '../../../resources/fixtures')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

function demo(claude?: CompleteJson) {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-forums-')), migrations, {
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
    changed: () => {},
    completeJson: claude ? () => claude : undefined
  })
  return { db: ctx.db, sync }
}

const forumNotes = (db: AppContext['db']) =>
  listNotifications(db, NOW).filter((n) => n.kind === 'moodle-forum')

/** Stands in for Claude: important when the post mentions an extension. */
function fakeClaude(prompts: string[]): CompleteJson {
  return async (system, prompt) => {
    if (system !== FORUM_SYSTEM) return { lectures: [], files: [], splits: [] }
    prompts.push(prompt)
    const posts = JSON.parse(prompt.slice(prompt.indexOf('['))) as { id: number; text: string }[]
    return {
      posts: posts.map((p) => ({
        id: p.id,
        important: /extended/.test(p.text),
        title: /extended/.test(p.text) ? 'Problem sheet deadline extended by a week' : null
      }))
    }
  }
}

describe('Moodle forum notifications (demo)', () => {
  it('notifies only the cancellation and the extension, without Claude', async () => {
    const { db, sync } = demo()
    expect((await sync.syncNow()).lastError).toBeNull()
    const notes = forumNotes(db)
    expect(notes.map((n) => n.title).sort()).toEqual([
      "NEUR: Thursday's lecture is cancelled",
      'PHAR: Problem sheet deadline extended'
    ])
    expect(notes.find((n) => n.title.startsWith('NEUR'))?.detail).toBe('Announcement · Dr Ada Demo')
    // A second sync adds nothing.
    await sync.syncNow()
    expect(forumNotes(db)).toHaveLength(2)
  })

  it('keeps nothing of students’ posts but their ids', async () => {
    const { db, sync } = demo()
    await sync.syncNow()
    const students = db
      .select()
      .from(t.moodleForumPosts)
      .where(eq(t.moodleForumPosts.kind, 'other'))
      .all()
    expect(students.length).toBeGreaterThan(0)
    for (const p of students) {
      expect([p.subject, p.author, p.text, p.title, p.url]).toEqual([null, null, null, null, null])
      expect(p.status).toBe('not-important')
    }
    // The tutor who isn't a contact was found by role; students were looked up once.
    const people = db.select().from(t.moodlePeople).all()
    expect(people.find((p) => p.userId === 7003)?.staff).toBe(true)
    expect(people.find((p) => p.userId === 7103)?.staff).toBe(false)
  })

  it('asks Claude only about staff posts that need a look, and uses its title', async () => {
    const prompts: string[] = []
    const { db, sync } = demo(fakeClaude(prompts))
    await sync.syncNow()
    // The extension starts a discussion; the staff answers have no hint of a change.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Problem sheet deadline extended')
    expect(prompts[0]).not.toContain('Nernst')
    expect(prompts[0]).not.toContain('Sam Student')
    expect(forumNotes(db).map((n) => n.title)).toContain(
      'PHAR: Problem sheet deadline extended by a week'
    )
    expect(
      db
        .select()
        .from(t.moodleForumPosts)
        .all()
        .every((p) => p.text === null)
    ).toBe(true)
  })

  it('leaves posts pending when Claude fails, and decides them later', async () => {
    const { db, sync } = demo(async () => {
      throw new Error('offline')
    })
    expect((await sync.syncNow()).lastError).toMatch(/didn’t work/)
    expect(forumNotes(db)).toHaveLength(1) // the announcement
    expect(await classifyPending(db, null)).toBe(1)
    expect(forumNotes(db)).toHaveLength(2)
  })

  it('never notifies about posts from before a forum’s first sync', async () => {
    const { db, sync } = demo()
    db.delete(t.moodleForums).run() // as if never synced
    await sync.syncNow()
    expect(forumNotes(db)).toEqual([])
    expect(db.select().from(t.moodleForums).all()).toHaveLength(4)
  })

  it('a module’s switch hides its notifications, and turning it on starts afresh', async () => {
    const { db, sync } = demo()
    await sync.syncNow()
    updateModule(db, 'neur', { forumNotifications: false }, NOW)
    expect(forumNotes(db).map((n) => n.title)).toEqual(['PHAR: Problem sheet deadline extended'])
    updateModule(db, 'neur', { forumNotifications: true }, NOW)
    expect(
      db
        .select()
        .from(t.moodleForums)
        .all()
        .map((f) => f.courseId)
        .sort()
    ).toEqual([9002, 9002])
  })

  it('dismisses a post when it’s opened (demo posts have no link)', async () => {
    const { db, sync } = demo()
    await sync.syncNow()
    const [first] = forumNotes(db)
    expect(openForumPost(db, first.postId!)).toBeNull()
    expect(forumNotes(db)).toHaveLength(1)
  })
})
