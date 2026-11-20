import { and, eq, inArray } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import {
  changedDiscussions,
  fallbackImportant,
  forumHints,
  forumTitle,
  isNewPost,
  isStaffRole,
  postKind,
  triage
} from '../../core/forum'
import { courseTitle, htmlToText, unescapeHtml } from '../../core/moodle'
import type { Db, DbOrTx } from '../db/client'
import * as t from '../db/schema'
import { MOODLE_SITE } from './auth'
import type { CompleteJson } from './lectures'
import type { MoodleDiscussion, MoodlePost, MoodleSource } from './source'

// Forum notifications. For each synced course whose module has them on, Engram reads the
// forums' new posts (each post once, never the ones from before a forum's first sync) and
// tells the student about the important ones: everything in the Announcements forum, and
// staff posts elsewhere that change something (a lecture cancelled or moved, a room change,
// an assignment released, a deadline changed, an extension). Students' posts are never kept
// or sent anywhere. Claude only classifies staff posts and writes a one-line title; it never
// answers or summarises them. Notifications stay in Engram: nothing is sent or posted.

/** Pages of discussions read per forum and sync (25 each), at most. */
const MAX_PAGES = 4
/** Characters of a staff post kept for Claude. */
const TEXT_CHARS = 2000
/** Posts per classification call. */
const BATCH = 15

const seconds = (now: Temporal.Instant) => Math.floor(now.epochMilliseconds / 1000)

/** A post's link, only when it's on Moodle itself. */
function moodleUrl(post: MoodlePost): string | null {
  const url = post.urls?.view
  if (!url) return null
  try {
    return new URL(url).origin === new URL(MOODLE_SITE).origin ? url : null
  } catch {
    return null
  }
}

function staffOf(db: Db, courseId: number): Map<number, boolean> {
  return new Map(
    db
      .select()
      .from(t.moodlePeople)
      .where(eq(t.moodlePeople.courseId, courseId))
      .all()
      .map((p) => [p.userId, p.staff])
  )
}

function rememberPerson(db: Db, courseId: number, userId: number, staff: boolean): void {
  db.insert(t.moodlePeople)
    .values({ courseId, userId, staff })
    .onConflictDoUpdate({
      target: [t.moodlePeople.courseId, t.moodlePeople.userId],
      set: { staff }
    })
    .run()
}

/** The synced courses whose modules want forum notifications. */
function forumCourses(db: Db) {
  return db
    .select({ id: t.moodleCourses.id })
    .from(t.moodleCourses)
    .innerJoin(t.modules, eq(t.moodleCourses.moduleId, t.modules.id))
    .where(eq(t.modules.forumNotifications, true))
    .all()
    .map((c) => c.id)
}

/**
 * Read new forum posts of the synced courses and keep them, sorting out what's important
 * with plain rules (announcements yes, students no, staff answers no). Staff posts that need
 * a closer look are left `pending` for `classifyPending`. Returns how many are important.
 */
export async function syncForums(
  db: Db,
  source: MoodleSource,
  now: Temporal.Instant
): Promise<{ important: number; pending: number }> {
  const result = { important: 0, pending: 0 }
  const courseIds = forumCourses(db)
  if (!courseIds.length) return result
  const forums = await source.forums(courseIds)
  // The courses' contacts are their staff.
  for (const [courseId, ids] of await source.contacts(courseIds))
    for (const id of ids) rememberPerson(db, courseId, id, true)

  for (const forum of forums) {
    if (!courseIds.includes(forum.course)) continue
    const name = unescapeHtml(forum.name)
    const row = db.select().from(t.moodleForums).where(eq(t.moodleForums.id, forum.id)).get()
    if (!row) {
      // First sync of this forum: only note where it's up to, so old posts never notify.
      const latest = Math.max(
        seconds(now),
        ...(await source.discussions(forum.id, 0)).map((d) => d.timemodified)
      )
      db.insert(t.moodleForums)
        .values({
          id: forum.id,
          courseId: forum.course,
          type: forum.type,
          name,
          baseline: latest,
          seenUntil: latest
        })
        .run()
      continue
    }
    db.update(t.moodleForums)
      .set({ type: forum.type, name })
      .where(eq(t.moodleForums.id, forum.id))
      .run()

    const changed: MoodleDiscussion[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = changedDiscussions(await source.discussions(forum.id, page), row.seenUntil)
      changed.push(...r.changed)
      if (!r.more) break
    }
    if (!changed.length) continue

    // New posts of the changed discussions.
    const fresh: (MoodlePost & { discussionId: number })[] = []
    for (const d of changed) {
      const kept = new Set(
        db
          .select({ id: t.moodleForumPosts.id })
          .from(t.moodleForumPosts)
          .where(eq(t.moodleForumPosts.discussionId, d.discussion))
          .all()
          .map((p) => p.id)
      )
      for (const p of await source.posts(d.discussion)) {
        if (p.isdeleted || !isNewPost({ id: p.id, created: p.timecreated }, row.baseline, kept))
          continue
        fresh.push({ ...p, discussionId: d.discussion })
      }
    }

    // Outside Announcements, an author who isn't a contact is looked up once (role only).
    const people = staffOf(db, forum.course)
    if (forum.type !== 'news') {
      const unknown = [...new Set(fresh.map((p) => p.author.id))].filter((id) => !people.has(id))
      if (unknown.length) {
        const roles = await source.roles(forum.course, unknown)
        for (const id of unknown) {
          const staff = isStaffRole(roles.get(id) ?? [])
          rememberPerson(db, forum.course, id, staff)
          people.set(id, staff)
        }
      }
    }
    const staff = new Set([...people].filter(([, s]) => s).map(([id]) => id))

    for (const p of fresh) {
      const kind = postKind(forum.type, p.author.id, staff)
      const subject = unescapeHtml(p.subject ?? '')
      const text = htmlToText(p.message ?? '')
      const isReply = !!p.parentid
      const status = triage({ kind, isReply, hints: forumHints(`${subject}\n${text}`) })
      const keep = kind !== 'other' // students' posts: only the id is kept
      db.insert(t.moodleForumPosts)
        .values({
          id: p.id,
          courseId: forum.course,
          forumId: forum.id,
          discussionId: p.discussionId,
          authorId: p.author.id,
          kind,
          status: status === 'classify' ? 'pending' : status,
          isReply,
          subject: keep ? subject : null,
          author: keep ? p.author.fullname : null,
          text: status === 'classify' ? text.slice(0, TEXT_CHARS) : null,
          title: status === 'important' ? forumTitle(null, subject) : null,
          url: keep ? moodleUrl(p) : null,
          created: p.timecreated
        })
        .onConflictDoNothing()
        .run()
      if (status === 'important') result.important++
      if (status === 'classify') result.pending++
    }
    const until = Math.max(row.seenUntil, ...changed.map((d) => d.timemodified))
    db.update(t.moodleForums).set({ seenUntil: until }).where(eq(t.moodleForums.id, forum.id)).run()
  }
  return result
}

export const FORUM_SYSTEM = `You sort posts from a university module's Moodle forums for a student's study planner. Every post given was written by the module's staff. Mark a post important only when it tells students about a change or something they must act on:
- a lecture, class, workshop or session cancelled, moved, rescheduled or switched online
- a room, venue or time change
- coursework, an assignment or its brief released
- a deadline set or changed, or an extension
- a change to exam or assessment arrangements
Not important: answers to a student's question about the lecture content, help with a problem, thanks, slides or recordings uploaded or fixed, reminders of things that haven't changed, and general chat.
For each post give a title: one line of at most 80 characters saying what changed, addressed to the student (e.g. "Thursday's lecture cancelled", "Problem sheet deadline extended by a week"), without the module code; null when it isn't important.
Only classify: never reply to, answer or summarise the subject matter of a post.`

export const FORUM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'important', 'title'],
        properties: {
          id: { type: 'integer' },
          important: { type: 'boolean' },
          title: { type: ['string', 'null'] }
        }
      }
    }
  }
} as const

/**
 * Decide the staff posts left pending: Claude classifies them (in batches); without Claude,
 * a staff post counts when it starts a discussion and hints at a change. A post Claude left
 * out stays pending for the next sync. Returns how many turned out important.
 */
export async function classifyPending(
  db: Db,
  claude: CompleteJson | null,
  signal?: AbortSignal
): Promise<number> {
  const rows = db
    .select({
      post: t.moodleForumPosts,
      forum: t.moodleForums.name,
      course: t.moodleCourses.fullname
    })
    .from(t.moodleForumPosts)
    .innerJoin(t.moodleForums, eq(t.moodleForumPosts.forumId, t.moodleForums.id))
    .innerJoin(t.moodleCourses, eq(t.moodleForumPosts.courseId, t.moodleCourses.id))
    .where(eq(t.moodleForumPosts.status, 'pending'))
    .all()
  let important = 0
  const decide = (id: number, isImportant: boolean, title: string | null, subject: string) => {
    db.update(t.moodleForumPosts)
      .set({
        status: isImportant ? 'important' : 'not-important',
        title: isImportant ? forumTitle(title, subject) : null,
        text: null
      })
      .where(eq(t.moodleForumPosts.id, id))
      .run()
    if (isImportant) important++
  }
  if (!claude) {
    for (const { post } of rows) {
      const hints = forumHints(`${post.subject ?? ''}\n${post.text ?? ''}`)
      decide(post.id, fallbackImportant({ isReply: post.isReply, hints }), null, post.subject ?? '')
    }
    return important
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const prompt = `Posts by staff (JSON):\n${JSON.stringify(
      batch.map(({ post, forum, course }) => ({
        id: post.id,
        module: courseTitle(course),
        forum,
        reply: post.isReply,
        subject: post.subject,
        text: post.text
      })),
      null,
      1
    )}`
    const raw = (await claude(FORUM_SYSTEM, prompt, FORUM_SCHEMA, signal)) as {
      posts?: { id?: unknown; important?: unknown; title?: unknown }[]
    }
    const verdicts = new Map((raw?.posts ?? []).map((v) => [v.id, v]))
    for (const { post } of batch) {
      const v = verdicts.get(post.id)
      if (!v || typeof v.important !== 'boolean') continue
      decide(post.id, v.important, typeof v.title === 'string' ? v.title : null, post.subject ?? '')
    }
  }
  return important
}

/** Important posts not dismissed yet, of modules with forum notifications on. */
export function pendingForumPosts(db: Db) {
  return db
    .select({
      id: t.moodleForumPosts.id,
      title: t.moodleForumPosts.title,
      subject: t.moodleForumPosts.subject,
      author: t.moodleForumPosts.author,
      kind: t.moodleForumPosts.kind,
      url: t.moodleForumPosts.url,
      created: t.moodleForumPosts.created,
      forum: t.moodleForums.name,
      moduleId: t.modules.id,
      label: t.categories.shortLabel
    })
    .from(t.moodleForumPosts)
    .innerJoin(t.moodleForums, eq(t.moodleForumPosts.forumId, t.moodleForums.id))
    .innerJoin(t.moodleCourses, eq(t.moodleForumPosts.courseId, t.moodleCourses.id))
    .innerJoin(t.modules, eq(t.moodleCourses.moduleId, t.modules.id))
    .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
    .where(
      and(
        eq(t.moodleForumPosts.status, 'important'),
        eq(t.moodleForumPosts.dismissed, false),
        eq(t.modules.forumNotifications, true)
      )
    )
    .all()
}

export function dismissForumPost(db: Db, id: number): void {
  db.update(t.moodleForumPosts).set({ dismissed: true }).where(eq(t.moodleForumPosts.id, id)).run()
}

/** The post's page on Moodle (null for demo posts), and the notification is dismissed. */
export function openForumPost(db: Db, id: number): string | null {
  const post = db.select().from(t.moodleForumPosts).where(eq(t.moodleForumPosts.id, id)).get()
  if (!post) throw new Error('That post isn’t in Engram any more.')
  dismissForumPost(db, id)
  return post.url
}

/**
 * Forget where a module's forums were up to, so turning its notifications back on starts
 * afresh (posts written while they were off don't all arrive at once).
 */
export function resetModuleForums(db: DbOrTx, moduleId: string): void {
  const courseIds = db
    .select({ id: t.moodleCourses.id })
    .from(t.moodleCourses)
    .where(eq(t.moodleCourses.moduleId, moduleId))
    .all()
    .map((c) => c.id)
  if (courseIds.length)
    db.delete(t.moodleForums).where(inArray(t.moodleForums.courseId, courseIds)).run()
}
