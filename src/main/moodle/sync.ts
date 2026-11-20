import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import {
  courseTitle,
  htmlToText,
  isCurrentCourse,
  sectionWeek,
  similarity,
  suggestModule,
  unescapeHtml,
  wantedFile
} from '../../core/moodle'
import { TZ } from '../../core/time'
import type {
  Attachment,
  AttachmentRef,
  MoodleCourseRow,
  MoodleFileGroup,
  MoodleStatus
} from '../../shared/types'
import { classifyPending, syncForums } from './forums'
import { organiseModule, type CompleteJson } from './lectures'
import { addFiles, attachmentPath, getAttachments } from '../attachments'
import { queueWhiten } from '../pdf-background'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { summariseAssignment } from '../assistant/brief'
import { listModules } from '../repo'
import { rootLectureId, rootLectureIds } from '../timetable'
import type { MoodleFile, MoodleSource } from './source'

// Moodle downloads. For each of this year's courses the user matched to a module, Engram
// fetches its documents (slides, handouts, readings) into the module's files, and each
// assignment's brief (its description, plus attached files) into the matching assignment, or
// the module with a notification. Each item is fetched once (moodle_items), replaced when
// Moodle's copy changes, and never again once the user deletes it. Nothing else changes:
// no deadlines, no assignments are created. Forum notifications are in forums.ts.

const STATUS_KEY = 'moodleSync'
const SYNC_HOURS = 6

const safeName = (s: string) => s.replace(/[/\\:*?"<>|]+/g, '-').slice(0, 120)

function getStatus(db: Db): Omit<MoodleStatus, 'connected' | 'demo'> {
  const row = db.select().from(t.settings).where(eq(t.settings.key, STATUS_KEY)).get()
  const v = (row?.value ?? {}) as Partial<MoodleStatus>
  return { lastSyncedAt: v.lastSyncedAt ?? null, lastError: v.lastError ?? null }
}

function setStatus(db: Db, value: Omit<MoodleStatus, 'connected' | 'demo'>): void {
  db.insert(t.settings)
    .values({ key: STATUS_KEY, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

/** Record this year's courses; suggest a module for new ones. Returns them for Settings. */
export function rememberCourses(
  db: Db,
  courses: { id: number; shortname: string; fullname: string }[],
  now: Temporal.Instant
): void {
  const today = now.toZonedDateTimeISO(TZ).toPlainDate()
  const modules = listModules(db)
  for (const c of courses.filter((c) => isCurrentCourse(c, today))) {
    const row = db.select().from(t.moodleCourses).where(eq(t.moodleCourses.id, c.id)).get()
    if (row) {
      db.update(t.moodleCourses)
        .set({ shortname: c.shortname, fullname: c.fullname })
        .where(eq(t.moodleCourses.id, c.id))
        .run()
      // A suggestion is made again once modules exist (e.g. after setup maps the timetable).
      if (row.matchedBy === 'auto' && !row.moduleId) {
        const moduleId = suggestModule(c, modules)
        if (moduleId)
          db.update(t.moodleCourses).set({ moduleId }).where(eq(t.moodleCourses.id, c.id)).run()
      }
      continue
    }
    db.insert(t.moodleCourses)
      .values({ ...c, moduleId: suggestModule(c, modules), matchedBy: 'auto' })
      .run()
  }
}

export function listCourses(db: Db): MoodleCourseRow[] {
  return db
    .select()
    .from(t.moodleCourses)
    .all()
    .map((c) => ({
      id: c.id,
      code: /^[A-Z]{3,4}\d{4}/.exec(c.shortname)?.[0] ?? null,
      title: courseTitle(c.fullname),
      moduleId: c.moduleId,
      files: db
        .select({ key: t.moodleItems.key })
        .from(t.moodleItems)
        .where(and(eq(t.moodleItems.courseId, c.id), isNotNull(t.moodleItems.attachmentId)))
        .all().length
    }))
    .sort((a, b) => (a.code ?? 'ZZZ').localeCompare(b.code ?? 'ZZZ'))
}

export function setCourseModule(db: Db, courseId: number, moduleId: string | null): void {
  if (moduleId && !db.select().from(t.modules).where(eq(t.modules.id, moduleId)).get())
    throw new Error('Module not found.')
  db.update(t.moodleCourses)
    .set({ moduleId, matchedBy: 'user' })
    .where(eq(t.moodleCourses.id, courseId))
    .run()
}

/** Write a download to a temporary file named as on Moodle, and attach it. */
function attachBuffer(
  db: Db,
  filesDir: string,
  name: string,
  data: Buffer,
  target: AttachmentRef
): Attachment {
  const dir = mkdtempSync(join(tmpdir(), 'engram-moodle-'))
  try {
    const path = join(dir, safeName(name))
    writeFileSync(path, data)
    return addFiles(db, filesDir, [path], target, 'user')[0]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The assignment in this module whose title best matches a Moodle assignment, if any. */
function matchAssignment(db: Db, moduleId: string, name: string): string | null {
  let best: { id: string; score: number } | null = null
  for (const a of db
    .select()
    .from(t.assignments)
    .where(eq(t.assignments.moduleId, moduleId))
    .all()) {
    const score = similarity(name, a.title)
    if (score >= 0.5 && (!best || score > best.score)) best = { id: a.id, score }
  }
  return best?.id ?? null
}

/** Sync one course into its module. Returns how many files were added or replaced. */
export async function syncCourse(
  db: Db,
  filesDir: string,
  source: MoodleSource,
  course: { id: number; moduleId: string }
): Promise<{ added: number; updated: number; failed: string[] }> {
  const result = { added: 0, updated: 0, failed: [] as string[] }
  const moduleRef: AttachmentRef = { type: 'module', id: course.moduleId }
  const item = (key: string) =>
    db.select().from(t.moodleItems).where(eq(t.moodleItems.key, key)).get()

  const fetchFile = async (
    key: string,
    f: MoodleFile,
    meta: { section: string; week: number | null; title: string; kind: 'file' | 'brief' },
    target: AttachmentRef
  ) => {
    const seen = item(key)
    if (seen && !seen.attachmentId) return // deleted by the user: never again
    if (seen && f.timemodified <= seen.modified) return
    try {
      const data = await source.download(f)
      if (seen?.attachmentId) {
        // Moodle has a newer copy: replace the file in place (same attachment).
        const path = attachmentPath(db, filesDir, seen.attachmentId)
        writeFileSync(path, data)
        void queueWhiten(path)
        db.update(t.attachments)
          .set({ size: statSync(path).size })
          .where(eq(t.attachments.id, seen.attachmentId))
          .run()
        db.update(t.moodleItems)
          .set({ modified: f.timemodified, title: meta.title })
          .where(eq(t.moodleItems.key, key))
          .run()
        result.updated++
        return
      }
      const a = attachBuffer(db, filesDir, f.filename, data, target)
      db.insert(t.moodleItems)
        .values({
          key,
          courseId: course.id,
          ...meta,
          modified: f.timemodified,
          attachmentId: a.id
        })
        .run()
      result.added++
    } catch (e) {
      result.failed.push(`${f.filename}: ${e instanceof Error ? e.message : 'failed'}`)
      if (e instanceof Error && /Connect Moodle again/.test(e.message)) throw e
    }
  }

  for (const s of await source.contents(course.id)) {
    const section = unescapeHtml(s.name)
    const week = sectionWeek(section)
    for (const m of s.modules ?? []) {
      const title = unescapeHtml(m.name)
      if (m.modname === 'resource' || m.modname === 'folder') {
        for (const f of m.contents ?? []) {
          if (f.type !== 'file' || !wantedFile(f.filename, f.filesize)) continue
          await fetchFile(
            `file:${m.id}:${f.filepath}${f.filename}`,
            f,
            { section, week, title, kind: 'file' },
            moduleRef
          )
        }
      } else if (m.modname === 'assign') {
        const key = `brief:${m.id}`
        if (item(key)) continue // a brief is fetched once
        const assignmentId = matchAssignment(db, course.moduleId, title)
        const target: AttachmentRef = assignmentId
          ? { type: 'assignment', id: assignmentId }
          : moduleRef
        const text = htmlToText(m.description ?? '')
        let attachmentId: string | null = null
        if (text.length >= 20) {
          const a = attachBuffer(
            db,
            filesDir,
            `${title} (brief).txt`,
            Buffer.from(`${title}\n\n${text}\n`),
            target
          )
          attachmentId = a.id
          result.added++
        }
        let files: MoodleFile[] = []
        try {
          files = await source.briefFiles(m.instance)
        } catch {
          // Some assignments aren't visible yet; their description is enough.
        }
        for (const f of files) {
          if (!wantedFile(f.filename, f.filesize)) continue
          await fetchFile(
            `file:${m.id}:brief/${f.filename}`,
            f,
            { section, week, title, kind: 'file' },
            target
          )
          attachmentId ??= item(`file:${m.id}:brief/${f.filename}`)?.attachmentId ?? null
        }
        db.insert(t.moodleItems)
          .values({
            key,
            courseId: course.id,
            kind: 'brief',
            section,
            week,
            title,
            modified: 0,
            attachmentId,
            // Matched to an assignment already: nothing to tell the user.
            dismissed: !!assignmentId || !attachmentId
          })
          .run()
      }
    }
  }
  return result
}

/** A module's Moodle files, grouped by Moodle section (weeks in order, others first). */
export function moduleMoodleFiles(db: Db, moduleId: string) {
  const courses = db
    .select({ id: t.moodleCourses.id })
    .from(t.moodleCourses)
    .where(eq(t.moodleCourses.moduleId, moduleId))
    .all()
    .map((c) => c.id)
  const rows = db
    .select()
    .from(t.moodleItems)
    .where(and(eq(t.moodleItems.kind, 'file'), isNotNull(t.moodleItems.attachmentId)))
    .all()
    .filter((r) => courses.includes(r.courseId))
  const files = new Map(
    getAttachments(
      db,
      rows.map((r) => r.attachmentId!)
    ).map((a) => [a.id, a])
  )
  // Slides tagged to a later session of a merged lecture belong to its first session.
  const roots = rootLectureIds(
    db
      .select({
        id: t.lectures.id,
        continuesId: t.lectures.continuesId,
        moduleId: t.lectures.moduleId
      })
      .from(t.lectures)
      .where(eq(t.lectures.moduleId, moduleId))
      .all()
  )
  const groups = new Map<string, MoodleFileGroup>()
  for (const r of rows) {
    const a = files.get(r.attachmentId!)
    if (!a || a.target?.type !== 'module' || a.target.id !== moduleId) continue // moved elsewhere
    const g = groups.get(r.section) ?? { section: r.section, week: r.week, files: [] }
    const lectureId = r.lectureId ? (roots.get(r.lectureId) ?? r.lectureId) : null
    g.files.push({ ...a, lectureId })
    groups.set(r.section, g)
  }
  return [...groups.values()].sort(
    (a, b) => (a.week ?? -1) - (b.week ?? -1) || a.section.localeCompare(b.section)
  )
}

/**
 * Briefs that came in without a matching assignment, for Notifications, until they're
 * dismissed or the brief is moved to an assignment (e.g. by Plan from brief).
 */
export function pendingBriefs(db: Db) {
  return db
    .select({ item: t.moodleItems, targetType: t.attachments.targetType })
    .from(t.moodleItems)
    .innerJoin(t.attachments, eq(t.moodleItems.attachmentId, t.attachments.id))
    .where(and(eq(t.moodleItems.kind, 'brief'), eq(t.moodleItems.dismissed, false)))
    .all()
    .filter((r) => r.targetType === 'module')
    .map((r) => r.item)
}

export function dismissBrief(db: Db, key: string): void {
  db.update(t.moodleItems).set({ dismissed: true }).where(eq(t.moodleItems.key, key)).run()
}

export class MoodleSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<MoodleStatus> | null = null

  constructor(
    private readonly opts: {
      db: () => Db
      now: () => Temporal.Instant
      filesDir: () => string
      /** Null when there's nothing to sync from (real profile not connected). */
      source: () => MoodleSource | null
      demo: () => boolean
      changed: () => void
      /** Claude, for reading lecture lists and matching slides (null without a token). */
      completeJson?: () => CompleteJson | null
    }
  ) {}

  status(): MoodleStatus {
    return {
      connected: !!this.opts.source(),
      demo: this.opts.demo(),
      ...getStatus(this.opts.db())
    }
  }

  /** Fetch the course list (for matching courses to modules in Settings). */
  async refreshCourses(): Promise<MoodleCourseRow[]> {
    const source = this.opts.source()
    if (!source) throw new Error('Moodle isn’t connected.')
    rememberCourses(this.opts.db(), await source.courses(), this.opts.now())
    return listCourses(this.opts.db())
  }

  syncNow(): Promise<MoodleStatus> {
    this.running ??= this.run().finally(() => (this.running = null))
    return this.running
  }

  private async run(): Promise<MoodleStatus> {
    const source = this.opts.source()
    if (!source) return this.status()
    const db = this.opts.db()
    const failed: string[] = []
    try {
      rememberCourses(db, await source.courses(), this.opts.now())
      for (const c of db.select().from(t.moodleCourses).all()) {
        if (!c.moduleId) continue
        const r = await syncCourse(db, this.opts.filesDir(), source, {
          id: c.id,
          moduleId: c.moduleId
        })
        failed.push(...r.failed)
        if (r.added || r.updated) this.opts.changed()
        const claude = this.opts.completeJson?.() ?? null
        if (claude) {
          try {
            if (
              await summariseMoodleBriefs(db, this.opts.filesDir(), c.id, claude, this.opts.now())
            )
              this.opts.changed()
          } catch (e) {
            failed.push(`brief summary: ${e instanceof Error ? e.message : 'not written'}`)
          }
        }
      }
      // Forum notifications: new posts, the important ones sorted out (Claude classifies
      // staff posts when there's a token).
      const claude = this.opts.completeJson?.() ?? null
      try {
        const forums = await syncForums(db, source, this.opts.now())
        const classified = await classifyPending(db, claude)
        if (forums.important || classified) this.opts.changed()
      } catch (e) {
        failed.push(`forums: ${e instanceof Error ? e.message : 'not read'}`)
      }
      // Then organise each module's lectures with what came in (when anything changed).
      const moduleIds = new Set(
        db
          .select()
          .from(t.moodleCourses)
          .all()
          .flatMap((c) => (c.moduleId ? [c.moduleId] : []))
      )
      if (claude) {
        for (const moduleId of moduleIds) {
          try {
            await organiseModule(db, this.opts.filesDir(), moduleId, claude, this.opts.now())
            this.opts.changed()
          } catch (e) {
            failed.push(`organising lectures: ${e instanceof Error ? e.message : 'failed'}`)
          }
        }
      }
      setStatus(db, {
        lastSyncedAt: this.opts.now().toString(),
        lastError: failed.length
          ? `${failed.length} thing${failed.length === 1 ? '' : 's'} didn’t work (${failed[0]}).`
          : null
      })
    } catch (e) {
      setStatus(db, {
        ...getStatus(db),
        lastError: e instanceof Error ? e.message : 'Moodle couldn’t be synced.'
      })
    }
    this.opts.changed()
    return this.status()
  }

  start(): void {
    const tick = () => void this.syncNow()
    setTimeout(tick, 60_000)
    this.timer = setInterval(tick, SYNC_HOURS * 3600_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}

/** Summarise briefs from Moodle that landed on an assignment without a summary yet. */
export async function summariseMoodleBriefs(
  db: Db,
  filesDir: string,
  courseId: number,
  claude: CompleteJson,
  now: Temporal.Instant
): Promise<number> {
  const rows = db
    .select({
      key: t.moodleItems.key,
      tried: t.moodleItems.summaryTried,
      assignmentId: t.attachments.targetId,
      summary: t.assignments.summary
    })
    .from(t.moodleItems)
    .innerJoin(t.attachments, eq(t.moodleItems.attachmentId, t.attachments.id))
    .innerJoin(t.assignments, eq(t.attachments.targetId, t.assignments.id))
    .where(
      and(
        eq(t.moodleItems.courseId, courseId),
        eq(t.moodleItems.kind, 'brief'),
        eq(t.attachments.targetType, 'assignment')
      )
    )
    .all()
  let done = 0
  for (const r of rows) {
    if (r.summary || r.tried || !r.assignmentId) continue
    db.update(t.moodleItems).set({ summaryTried: true }).where(eq(t.moodleItems.key, r.key)).run()
    if (await summariseAssignment(db, filesDir, r.assignmentId, claude, now)) done++
  }
  return done
}

/**
 * Choose by hand which lecture a Moodle file is the slides for (null = just the week). The
 * choice is locked: organising never changes it.
 */
export function setFileLecture(db: Db, attachmentId: string, lectureId: string | null): void {
  if (lectureId && !db.select().from(t.lectures).where(eq(t.lectures.id, lectureId)).get())
    throw new Error('Lecture not found.')
  // A merged lecture's slides go on its first session (the one the lecture list shows).
  if (lectureId) lectureId = rootLectureId(db, lectureId)
  const changed = db
    .update(t.moodleItems)
    .set({ lectureId, lectureLocked: true, lectureMatched: true })
    .where(eq(t.moodleItems.attachmentId, attachmentId))
    .run().changes
  if (!changed) throw new Error('That file isn’t from Moodle.')
}
