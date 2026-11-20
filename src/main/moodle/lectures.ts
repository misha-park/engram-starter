import { createHash } from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import { validCuts } from '../../core/lecture-list'
import { teachingWeek } from '../../core/moodle'
import { minutesBetween, TZ } from '../../core/time'
import type { OrganiseStatus } from '../../shared/types'
import { readAttachmentText } from '../attachments'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { splitEventsOf } from '../timetable'

// Organise lectures (per module): Claude looks at the three sources together (the UCL
// timetable's lectures, the module's lecture list, and its Moodle sections and files) and
// proposes a name for each lecture, which file is which lecture's slides, and which timetable
// slots hold two lectures. Plain code checks every proposal. Names and slide tags are applied
// (they're easy to change); splits wait for the user. Whatever the user set by hand (a name,
// a file's lecture) is locked and never changed. Claude only sorts and names; it never
// summarises a lecture or its files.

export type CompleteJson = (
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<unknown>

const LIST_NAME = /timetable|schedule|booklet|lecture list|teaching plan|course outline/i
const NOT_LIST = /marking|exam|answer|question|group|criteria|template|form/i
const LIST_CHARS = 30_000
const settingKey = (moduleId: string) => `organise:${moduleId}`

export function getOrganiseStatus(db: Db, moduleId: string): OrganiseStatus | null {
  const row = db
    .select()
    .from(t.settings)
    .where(eq(t.settings.key, settingKey(moduleId)))
    .get()
  return (row?.value as OrganiseStatus | undefined) ?? null
}

function setOrganiseStatus(db: Db, moduleId: string, value: OrganiseStatus): void {
  db.insert(t.settings)
    .values({ key: settingKey(moduleId), value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

export function dismissSplitSuggestions(db: Db, moduleId: string): void {
  const s = getOrganiseStatus(db, moduleId)
  if (s) setOrganiseStatus(db, moduleId, { ...s, splitsDismissed: true })
}

/** The module's Moodle course ids. */
const courseIds = (db: Db, moduleId: string) =>
  db
    .select({ id: t.moodleCourses.id })
    .from(t.moodleCourses)
    .where(eq(t.moodleCourses.moduleId, moduleId))
    .all()
    .map((c) => c.id)

/** The module's lecture list: a Moodle file named like one, else one of its own files. */
function findListFile(db: Db, moduleId: string) {
  const looksLikeList = (title: string, name: string) =>
    (LIST_NAME.test(title) || LIST_NAME.test(name)) &&
    !NOT_LIST.test(`${title} ${name}`) &&
    /\.(xlsx|docx?|pdf|rtf|txt|md)$/i.test(name)
  const courses = courseIds(db, moduleId)
  const fromMoodle = courses.length
    ? db
        .select({ item: t.moodleItems, attachment: t.attachments })
        .from(t.moodleItems)
        .innerJoin(t.attachments, eq(t.moodleItems.attachmentId, t.attachments.id))
        .where(and(inArray(t.moodleItems.courseId, courses), eq(t.moodleItems.kind, 'file')))
        .all()
        .filter((r) => looksLikeList(r.item.title, r.attachment.name))
        // Prefer one outside the weekly sections (module overview, welcome).
        .sort((a, b) => (a.item.week === null ? 0 : 1) - (b.item.week === null ? 0 : 1))
    : []
  if (fromMoodle.length)
    return {
      id: fromMoodle[0].attachment.id,
      name: fromMoodle[0].attachment.name,
      version: `${fromMoodle[0].item.key}@${fromMoodle[0].item.modified}`
    }
  const own = db
    .select()
    .from(t.attachments)
    .where(and(eq(t.attachments.targetType, 'module'), eq(t.attachments.targetId, moduleId)))
    .all()
    .find((a) => looksLikeList(a.name, a.name))
  return own ? { id: own.id, name: own.name, version: own.id } : null
}

export const ORGANISE_SYSTEM = `You organise one university module's lectures for a student's study planner, from three sources: the lectures in the UCL timetable (the truth for dates and times; a 2-hour slot is one timetable event even when it holds two different lectures), the module's lecture list (its booklet, schedule or spreadsheet; it may be last year's, with the same order), and the module's Moodle page (sections, often "Week N: topic", and file names). Use all three together.

For each timetabled lecture, give:
- title: the lecture's title, short, as the sources name it (without lecturer names), or null if you can't tell
- continues: the number of an EARLIER timetabled lecture when this session is clearly the rest of that same lecture on another day (e.g. the list says "cont.", or Moodle has "… I+II" then "… III" as one lecture), else null
- parts: only when one timetable slot clearly holds two or more different lectures (e.g. the list gives two topics, or Moodle has "Lecture 3" and "Lecture 4" in that slot): each part's title and its start and end (HH:MM, London time, inside the slot). Otherwise null. A 2-hour lecture with a "first hour" and "second hour" file is ONE lecture.
Leave lectures marked "named by the student" as they are (give their title unchanged).

For each Moodle file, give the number of the lecture it is the slides or lecture notes for, or null when it isn't one lecture's slides or notes (handouts, workshop or practical material, readings and papers, data, schedules) or you can't tell. Moodle's own lecture numbers may differ from the timetable's: go by topic, week, day and order. Two files can belong to one lecture.

Only sort and name: never summarise or describe the lectures' content. Don't guess: null is fine.`

const ORGANISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lectures', 'files'],
  properties: {
    lectures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title', 'continues', 'parts'],
        properties: {
          number: { type: 'integer' },
          continues: { type: ['integer', 'null'] },
          title: { type: ['string', 'null'] },
          parts: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'start', 'end'],
              properties: {
                title: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' }
              }
            }
          }
        }
      }
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'lecture'],
        properties: { id: { type: 'string' }, lecture: { type: ['integer', 'null'] } }
      }
    }
  }
} as const

const local = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const minutesOf = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

/**
 * Organise a module's lectures with Claude. Runs only when something changed since last time
 * (new lectures, files or lecture list), unless `force`. Returns the status, or null when
 * there's nothing to organise (no lectures yet, or the user switched it off).
 */
export async function organiseModule(
  db: Db,
  filesDir: string,
  moduleId: string,
  completeJson: CompleteJson,
  now: Temporal.Instant,
  opts: { force?: boolean; signal?: AbortSignal } = {}
): Promise<OrganiseStatus | null> {
  const mod = db.select().from(t.modules).where(eq(t.modules.id, moduleId)).get()
  if (!mod || (!mod.autoOrganise && !opts.force)) return null
  const lectures = db
    .select({
      id: t.lectures.id,
      number: t.lectures.number,
      title: t.lectures.title,
      titleLocked: t.lectures.titleLocked,
      continuesId: t.lectures.continuesId,
      blockId: t.lectures.blockId,
      start: t.blocks.start,
      end: t.blocks.end
    })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .where(eq(t.lectures.moduleId, moduleId))
    .all()
    .sort((a, b) => a.start.localeCompare(b.start))
  if (!lectures.length) return null

  const splitSlots = splitEventsOf(db).filter((s) => s.moduleId === moduleId)
  const isPart = (l: { start: string; end: string }) =>
    splitSlots.some((s) => s.start <= l.start && s.end >= l.end)

  const courses = courseIds(db, moduleId)
  const files = courses.length
    ? db
        .select({ item: t.moodleItems, name: t.attachments.name })
        .from(t.moodleItems)
        .innerJoin(t.attachments, eq(t.moodleItems.attachmentId, t.attachments.id))
        .where(and(inArray(t.moodleItems.courseId, courses), eq(t.moodleItems.kind, 'file')))
        .all()
        .filter((f) => !f.item.lectureLocked)
    : []
  const list = findListFile(db, moduleId)

  // Run only when something changed.
  const hash = createHash('sha1')
    .update(
      JSON.stringify([
        lectures.map((l) => [l.id, l.start, l.end, l.titleLocked ? l.title : null]),
        files.map((f) => [f.item.key, f.item.modified]),
        list?.version ?? null
      ])
    )
    .digest('hex')
  const before = getOrganiseStatus(db, moduleId)
  if (before?.hash === hash && !opts.force) return before

  let listText = ''
  if (list) {
    try {
      listText = (await readAttachmentText(db, filesDir, list.id)).slice(0, LIST_CHARS)
    } catch {
      listText = ''
    }
  }
  const ids = files.map((f, i) => ({ id: `f${i + 1}`, f }))
  const sections = new Map<string, typeof ids>()
  for (const x of ids)
    sections.set(x.f.item.section, [...(sections.get(x.f.item.section) ?? []), x])
  const prompt = [
    `Module: ${db.select({ name: t.categories.name }).from(t.categories).where(eq(t.categories.id, mod.categoryId)).get()?.name ?? moduleId}`,
    '',
    'Timetabled lectures:',
    ...lectures.map(
      (l) =>
        `${l.number}. ${local(l.start)}–${hhmm(l.end)} (${minutesBetween(l.start, l.end)} min, teaching week ${teachingWeek(l.start)})` +
        (l.titleLocked && l.title
          ? ` · named by the student: “${l.title}”`
          : l.title
            ? ` · now “${l.title}”`
            : '') +
        (isPart(l) ? ' · already split from a longer slot' : '') +
        (l.continuesId ? ' · already combined with an earlier lecture' : '')
    ),
    '',
    list ? `Lecture list (“${list.name}”):\n"""\n${listText}\n"""` : 'No lecture list.',
    '',
    files.length ? 'Moodle files, by section:' : 'No Moodle files.',
    ...[...sections].flatMap(([section, xs]) => [
      `Section “${section}”:`,
      ...xs.map(({ id, f }) => `- ${id}: “${f.item.title}” (${f.name})`)
    ])
  ].join('\n')

  const raw = (await completeJson(
    ORGANISE_SYSTEM,
    prompt,
    ORGANISE_SCHEMA as unknown as Record<string, unknown>,
    opts.signal
  )) as {
    lectures?: { number?: unknown; title?: unknown; continues?: unknown; parts?: unknown }[]
    files?: { id?: unknown; lecture?: unknown }[]
  } | null

  // Stopped while Claude was answering: change nothing.
  if (opts.signal?.aborted) throw new Error('Stopped.')
  // A lecture across several sessions shares one number: names and slides go on its first.
  const byNumber = new Map(lectures.filter((l) => !l.continuesId).map((l) => [l.number, l]))
  let named = 0
  let tagged = 0
  const splits: OrganiseStatus['splits'] = []
  const continuations: NonNullable<OrganiseStatus['continuations']> = []
  db.transaction((tx) => {
    for (const x of raw?.lectures ?? []) {
      const l = typeof x.number === 'number' ? byNumber.get(x.number) : undefined
      if (!l) continue
      // The rest of an earlier lecture on another day: suggested, never applied here.
      const earlier = typeof x.continues === 'number' ? byNumber.get(x.continues) : undefined
      if (earlier && earlier.start < l.start && !l.continuesId && earlier.id !== l.id) {
        continuations.push({
          lectureId: l.id,
          number: l.number,
          firstId: earlier.id,
          firstNumber: earlier.number
        })
        continue
      }
      // A slot holding several lectures: suggested, never applied here.
      const parts = Array.isArray(x.parts)
        ? (x.parts as { title?: unknown; start?: unknown; end?: unknown }[])
        : []
      if (parts.length >= 2 && !isPart(l)) {
        const slotStart = minutesOf(hhmm(l.start))
        const cuts = parts.slice(1).map((p) => minutesOf(String(p.start)) - slotStart)
        if (validCuts(cuts, minutesBetween(l.start, l.end))) {
          // Meanwhile it goes by both names; each part gets its own when the split is applied.
          if (!l.titleLocked) {
            const both = parts
              .map((p) => String(p.title ?? '').trim())
              .filter(Boolean)
              .join(' / ')
            if (both && both !== l.title) {
              tx.update(t.lectures)
                .set({ title: both.slice(0, 200) })
                .where(eq(t.lectures.id, l.id))
                .run()
              named++
            }
          }
          splits.push({
            lectureId: l.id,
            number: l.number,
            cuts,
            parts: parts.map((p) => ({
              title: String(p.title ?? '')
                .trim()
                .slice(0, 200),
              start: String(p.start),
              end: String(p.end)
            }))
          })
          continue
        }
      }
      if (l.titleLocked) continue
      const title = typeof x.title === 'string' ? x.title.trim().slice(0, 200) : ''
      if (title && title !== l.title) {
        tx.update(t.lectures).set({ title }).where(eq(t.lectures.id, l.id)).run()
        named++
      }
    }
    const answer = new Map(
      (raw?.files ?? []).map((x) => [
        String(x.id),
        typeof x.lecture === 'number' ? x.lecture : null
      ])
    )
    for (const { id, f } of ids) {
      if (!answer.has(id)) continue
      const lectureId = byNumber.get(answer.get(id)!)?.id ?? null
      if (lectureId !== f.item.lectureId) tagged += lectureId ? 1 : 0
      tx.update(t.moodleItems)
        .set({ lectureId, lectureMatched: true })
        .where(eq(t.moodleItems.key, f.item.key))
        .run()
    }
  })

  const status: OrganiseStatus = {
    hash,
    at: now.toString(),
    listName: list?.name ?? null,
    named,
    tagged,
    splits,
    continuations,
    // Suggestions already dismissed stay dismissed unless they changed.
    splitsDismissed:
      !!before?.splitsDismissed &&
      JSON.stringify([
        before.splits.map((s) => [s.lectureId, s.cuts]),
        (before.continuations ?? []).map((c) => [c.lectureId, c.firstId])
      ]) ===
        JSON.stringify([
          splits.map((s) => [s.lectureId, s.cuts]),
          continuations.map((c) => [c.lectureId, c.firstId])
        ])
  }
  setOrganiseStatus(db, moduleId, status)
  return status
}
