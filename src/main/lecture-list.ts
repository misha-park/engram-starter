import { and, eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { minutesBetween } from '../core/time'
import { matchLectureList, validCuts, type ListedLecture } from '../core/lecture-list'
import type { LectureListAnalysis } from '../shared/types'
import type { Db } from './db/client'
import * as t from './db/schema'
import { listModules } from './repo'
import { sessionInfo, splitLecture } from './timetable'

// Lecture lists (Phase 10): a module's booklet or spreadsheet, read by Claude into a list of
// lectures (organisation only: titles, days and times), then matched against the timetable by
// plain code (core/lecture-list.ts) to suggest which timetable events hold more than one
// lecture. Nothing changes until the user accepts the suggestions.

const MAX_CHARS = 60_000

export const LIST_SYSTEM = `You read a university module's lecture list (from its booklet, timetable document or spreadsheet) for a study planner. List the module's lectures in order, one entry per lecture:
- title: the lecture's title as written (without the lecturer's name or initials)
- date: YYYY-MM-DD if the list gives one (use the year the document is for), else null
- weekday: 1 = Monday … 7 = Sunday if known, else null
- start and end: 24-hour HH:MM, London time
One lecture can span consecutive time slots: when the same title is repeated in back-to-back slots on the same day, or one table cell covers two slots, or a session is written as e.g. "11am – 1pm", give ONE entry from the first start to the last end. Different titles in consecutive slots (e.g. "… I" and "… II", or two topics in one 2-hour session) are separate entries, each with its own times; if a session lists two topics without times, split its time equally between them. "cont." on another day is a separate entry. Leave out reading weeks, holidays and anything that isn't a taught session. Don't add anything the document doesn't say.`

export const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lectures'],
  properties: {
    lectures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'weekday', 'start', 'end'],
        properties: {
          title: { type: 'string' },
          date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          weekday: { type: ['integer', 'null'] },
          start: { type: 'string', description: 'HH:MM' },
          end: { type: 'string', description: 'HH:MM' }
        }
      }
    }
  }
} as const

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Tidy what Claude returned. Entries without usable times are dropped. */
export function cleanListedLectures(raw: unknown): ListedLecture[] {
  const items = (raw as { lectures?: unknown[] } | null)?.lectures
  if (!Array.isArray(items)) return []
  return items.flatMap((x) => {
    const r = x as Record<string, unknown>
    const pad = (v: unknown) =>
      typeof v === 'string'
        ? v
            .trim()
            .replace(/^(\d):/, '0$1:')
            .replace('.', ':')
        : ''
    const start = pad(r.start)
    const end = pad(r.end)
    if (!TIME.test(start) || !TIME.test(end) || typeof r.title !== 'string') return []
    let date: string | null = null
    if (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      try {
        date = Temporal.PlainDate.from(r.date).toString()
      } catch {
        date = null
      }
    }
    const weekday =
      Number.isInteger(r.weekday) && (r.weekday as number) >= 1 && (r.weekday as number) <= 7
        ? (r.weekday as number)
        : null
    return [{ title: r.title.trim().slice(0, 200), date, weekday, start, end }]
  })
}

/** The module's lectures in the timetable now (with each one's kind), for matching. */
function timetabled(db: Db, moduleId: string) {
  const info = sessionInfo(db)
  return db
    .select({
      id: t.lectures.id,
      number: t.lectures.number,
      start: t.blocks.start,
      end: t.blocks.end
    })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .where(eq(t.lectures.moduleId, moduleId))
    .all()
    .map((l) => ({ ...l, kind: info.get(l.id)?.kind ?? 'lecture' }))
}

export async function analyseLectureList(
  db: Db,
  moduleId: string,
  text: string,
  completeJson: (
    system: string,
    prompt: string,
    schema: Record<string, unknown>
  ) => Promise<unknown>
): Promise<LectureListAnalysis> {
  const mod = listModules(db).find((m) => m.id === moduleId)
  if (!mod) throw new Error('Module not found.')
  const lectures = timetabled(db, moduleId)
  if (!lectures.length) throw new Error('This module has no lectures in the timetable yet.')
  const doc = text.trim().slice(0, MAX_CHARS)
  if (doc.length < 40)
    throw new Error('There’s too little text in that file to read a lecture list from.')
  const raw = await completeJson(
    LIST_SYSTEM,
    `The module: ${mod.name} (timetable names: ${mod.feedNames.join('; ') || mod.name}).\n\nThe document:\n"""\n${doc}\n"""`,
    LIST_SCHEMA as unknown as Record<string, unknown>
  )
  const listed = cleanListedLectures(raw)
  if (!listed.length) throw new Error('No lectures with times could be found in that file.')
  const match = matchLectureList(listed, lectures)
  return { ...match, listed: listed.length, timetabled: lectures.length }
}

/** Give lectures their titles from a lecture list. */
export function setLectureTitles(db: Db, titles: { lectureId: string; title: string }[]): number {
  let n = 0
  for (const x of titles) {
    if (typeof x?.lectureId !== 'string' || typeof x.title !== 'string' || !x.title.trim()) continue
    // Names the user gave stay.
    n += db
      .update(t.lectures)
      .set({ title: x.title.trim().slice(0, 200) })
      .where(and(eq(t.lectures.id, x.lectureId), eq(t.lectures.titleLocked, false)))
      .run().changes
  }
  return n
}

/**
 * Split the lectures of the accepted suggestions, and give every part (and the lectures the
 * list names one-to-one) its title. Returns how many were split.
 */
export function applyLectureSplits(
  db: Db,
  splits: { lectureId: string; cuts: number[]; titles?: string[] }[],
  now: Temporal.Instant,
  titles: { lectureId: string; title: string }[] = []
): number {
  setLectureTitles(db, titles)
  let split = 0
  for (const s of splits) {
    if (typeof s?.lectureId !== 'string' || !Array.isArray(s.cuts)) continue
    const l = db.select().from(t.lectures).where(eq(t.lectures.id, s.lectureId)).get()
    const block = l && db.select().from(t.blocks).where(eq(t.blocks.id, l.blockId)).get()
    if (!l || !block || !validCuts(s.cuts, minutesBetween(block.start, block.end))) continue
    try {
      splitLecture(db, s.lectureId, now, s.cuts, 'list')
      split++
    } catch {
      // Already split (e.g. applied twice): leave it.
    }
    // The parts are the module's lectures inside the original slot, in order.
    if (s.titles?.length) {
      const parts = db
        .select({ id: t.lectures.id, start: t.blocks.start, end: t.blocks.end })
        .from(t.lectures)
        .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
        .where(eq(t.lectures.moduleId, l.moduleId))
        .all()
        .filter((p) => p.start >= block.start && p.end <= block.end)
        .sort((a, b) => a.start.localeCompare(b.start))
      setLectureTitles(
        db,
        parts.flatMap((p, i) => (s.titles![i] ? [{ lectureId: p.id, title: s.titles![i] }] : []))
      )
    }
  }
  return split
}
