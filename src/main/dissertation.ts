import { randomUUID } from 'crypto'
import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { atLocalTime, toIso, zoned } from '../core/time'
import {
  READING_STATUSES,
  SECTION_STATUSES,
  type Deadline,
  type DissertationOverview,
  type DissertationSettings,
  type Meeting,
  type PlanDraft,
  type ReadingStatus,
  type SectionStatus
} from '../shared/types'
import { nextFreeSlot } from './backlog'
import { logChange } from './calendar'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'
import { listModules } from './repo'
import { createTodo } from './todos'
import { creatorSummary, itemYear, type ZoteroItemJson } from './zotero'

// The dissertation (a literature review, written in Word, never in the app): sections with
// status and hand-entered word counts, milestones on a timeline to submission and the viva,
// a reading list mirrored from Zotero, and supervisor meetings whose action items become todos.

const ID = 'main'
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const EMPTY_SETTINGS: DissertationSettings = {
  title: 'Dissertation',
  moduleId: null,
  submissionDue: null,
  vivaDate: null,
  vivaTime: null,
  wordTarget: null,
  startedOn: null,
  zoteroCollectionKey: null,
  zoteroCollectionName: null
}

export function getSettings(db: DbOrTx): DissertationSettings {
  const row = db.select().from(t.dissertation).where(eq(t.dissertation.id, ID)).get()
  if (!row) return { ...EMPTY_SETTINGS }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, zoteroSyncedAt, ...settings } = row
  return settings
}

export function updateSettings(db: Db, patch: Partial<DissertationSettings>): DissertationSettings {
  const next = { ...getSettings(db), ...patch }
  if (!next.title.trim()) throw new Error('Give the dissertation a title.')
  for (const d of [next.vivaDate, next.startedOn]) {
    if (d && !DATE.test(d)) throw new Error('Invalid date.')
  }
  if (next.vivaTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.vivaTime)) {
    throw new Error('Invalid viva time.')
  }
  if (next.submissionDue) next.submissionDue = toIso(Temporal.Instant.from(next.submissionDue))
  if (next.wordTarget !== null && (!Number.isInteger(next.wordTarget) || next.wordTarget <= 0)) {
    throw new Error('The word target must be a whole number.')
  }
  const values = { ...next, title: next.title.trim() }
  db.insert(t.dissertation)
    .values({ id: ID, ...values })
    .onConflictDoUpdate({ target: t.dissertation.id, set: values })
    .run()
  return getSettings(db)
}

// --- Sections ----------------------------------------------------------------------------

export function addSection(db: Db, title: string, wordTarget: number | null = null): string {
  if (!title.trim()) throw new Error('Give the section a title.')
  const last = db.select().from(t.dissSections).orderBy(asc(t.dissSections.position)).all().at(-1)
  const id = randomUUID()
  db.insert(t.dissSections)
    .values({ id, title: title.trim(), position: (last?.position ?? 0) + 1, wordTarget })
    .run()
  return id
}

export function updateSection(
  db: Db,
  id: string,
  patch: {
    title?: string
    status?: SectionStatus
    wordCount?: number | null
    wordTarget?: number | null
    notes?: string | null
  }
): void {
  const section = db.select().from(t.dissSections).where(eq(t.dissSections.id, id)).get()
  if (!section) throw new Error('Section not found.')
  if (patch.status && !SECTION_STATUSES.includes(patch.status)) throw new Error('Invalid status.')
  if (patch.title !== undefined && !patch.title.trim()) throw new Error('Give the section a title.')
  for (const n of [patch.wordCount, patch.wordTarget]) {
    if (n !== undefined && n !== null && (!Number.isInteger(n) || n < 0 || n > 100_000)) {
      throw new Error('Word counts are whole numbers.')
    }
  }
  db.update(t.dissSections)
    .set({ ...patch, title: patch.title?.trim() ?? section.title })
    .where(eq(t.dissSections.id, id))
    .run()
  if (patch.status && patch.status !== section.status) {
    logChange(db, {
      actor: 'user',
      action: 'section.status',
      entityType: 'diss_section',
      entityId: id,
      before: { status: section.status },
      after: { status: patch.status }
    })
  }
}

export function removeSection(db: Db, id: string): void {
  db.transaction((tx) => {
    tx.delete(t.dissSections).where(eq(t.dissSections.id, id)).run()
    // Unlink it from the reading list; its past sessions keep their record.
    for (const item of tx.select().from(t.readingItems).all()) {
      if (item.sectionIds.includes(id)) {
        tx.update(t.readingItems)
          .set({ sectionIds: item.sectionIds.filter((s) => s !== id) })
          .where(eq(t.readingItems.id, item.id))
          .run()
      }
    }
  })
}

export function moveSection(db: Db, id: string, direction: -1 | 1): void {
  const all = db.select().from(t.dissSections).orderBy(asc(t.dissSections.position)).all()
  const i = all.findIndex((s) => s.id === id)
  const j = i + direction
  if (i < 0 || j < 0 || j >= all.length) return
  db.transaction((tx) => {
    tx.update(t.dissSections)
      .set({ position: all[j].position })
      .where(eq(t.dissSections.id, all[i].id))
      .run()
    tx.update(t.dissSections)
      .set({ position: all[i].position })
      .where(eq(t.dissSections.id, all[j].id))
      .run()
  })
}

// --- Milestones --------------------------------------------------------------------------

export function addMilestone(db: Db, title: string, due: string): string {
  if (!title.trim()) throw new Error('Give the milestone a title.')
  if (!DATE.test(due)) throw new Error('Invalid date.')
  const id = randomUUID()
  db.insert(t.dissMilestones).values({ id, title: title.trim(), due }).run()
  return id
}

export function updateMilestone(
  db: Db,
  id: string,
  patch: { title?: string; due?: string; done?: boolean },
  now: Temporal.Instant
): void {
  const m = db.select().from(t.dissMilestones).where(eq(t.dissMilestones.id, id)).get()
  if (!m) throw new Error('Milestone not found.')
  if (patch.due !== undefined && !DATE.test(patch.due)) throw new Error('Invalid date.')
  db.update(t.dissMilestones)
    .set({
      title: patch.title?.trim() || m.title,
      due: patch.due ?? m.due,
      doneAt: patch.done === undefined ? m.doneAt : patch.done ? (m.doneAt ?? toIso(now)) : null
    })
    .where(eq(t.dissMilestones.id, id))
    .run()
}

export function removeMilestone(db: Db, id: string): void {
  db.delete(t.dissMilestones).where(eq(t.dissMilestones.id, id)).run()
}

// --- Reading list ------------------------------------------------------------------------

/**
 * Mirror a Zotero collection: new items are added as "to read", existing ones keep their
 * status and section links (titles and authors are refreshed), and items no longer in the
 * collection are kept but marked missing.
 */
export function syncReading(
  db: Db,
  items: ZoteroItemJson[],
  now: Temporal.Instant
): { added: number; updated: number; missing: number } {
  const existing = new Map(
    db
      .select()
      .from(t.readingItems)
      .all()
      .map((r) => [r.id, r])
  )
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  db.transaction((tx) => {
    for (const item of items) {
      seen.add(item.key)
      const values = {
        title: item.data.title?.trim() || '(untitled)',
        creators: creatorSummary(item),
        year: itemYear(item),
        itemType: item.data.itemType,
        publication: item.data.publicationTitle || item.data.bookTitle || null,
        doi: item.data.DOI || null,
        url: item.data.url || null,
        missing: false
      }
      if (existing.has(item.key)) {
        tx.update(t.readingItems).set(values).where(eq(t.readingItems.id, item.key)).run()
        updated++
      } else {
        tx.insert(t.readingItems)
          .values({ id: item.key, ...values })
          .run()
        added++
      }
    }
    const gone = [...existing.keys()].filter((k) => !seen.has(k))
    if (gone.length) {
      tx.update(t.readingItems).set({ missing: true }).where(inArray(t.readingItems.id, gone)).run()
    }
    tx.update(t.dissertation)
      .set({ zoteroSyncedAt: toIso(now) })
      .where(eq(t.dissertation.id, ID))
      .run()
  })
  return { added, updated, missing: [...existing.keys()].filter((k) => !seen.has(k)).length }
}

export function updateReading(
  db: Db,
  id: string,
  patch: { status?: ReadingStatus; sectionIds?: string[] }
): void {
  const item = db.select().from(t.readingItems).where(eq(t.readingItems.id, id)).get()
  if (!item) throw new Error('Reading item not found.')
  if (patch.status && !READING_STATUSES.includes(patch.status)) throw new Error('Invalid status.')
  let sectionIds = patch.sectionIds
  if (sectionIds) {
    const known = new Set(
      db
        .select({ id: t.dissSections.id })
        .from(t.dissSections)
        .all()
        .map((s) => s.id)
    )
    sectionIds = [...new Set(sectionIds)].filter((s) => known.has(s))
  }
  db.update(t.readingItems)
    .set({ status: patch.status ?? item.status, sectionIds: sectionIds ?? item.sectionIds })
    .where(eq(t.readingItems.id, id))
    .run()
}

// --- Meetings ----------------------------------------------------------------------------

/** Record a supervisor meeting. Each action item becomes a todo (due a week later). */
export function saveMeeting(
  db: Db,
  input: { id?: string; at: string; notes: string; actions: string[] }
): string {
  const at = toIso(Temporal.Instant.from(input.at))
  const id = input.id ?? randomUUID()
  const existing = input.id
    ? db.select().from(t.meetings).where(eq(t.meetings.id, input.id)).get()
    : undefined
  if (input.id && !existing) throw new Error('Meeting not found.')
  const actions = input.actions.map((a) => a.trim()).filter(Boolean)
  db.transaction((tx) => {
    if (existing) {
      tx.update(t.meetings).set({ at, notes: input.notes }).where(eq(t.meetings.id, id)).run()
    } else {
      tx.insert(t.meetings).values({ id, at, notes: input.notes }).run()
    }
    const current = tx
      .select()
      .from(t.meetingActions)
      .where(eq(t.meetingActions.meetingId, id))
      .orderBy(asc(t.meetingActions.position))
      .all()
    const due = zoned(at).toPlainDate().add({ days: 7 }).toString()
    actions.forEach((text, position) => {
      const same = current.find((c) => c.text === text)
      if (same) {
        tx.update(t.meetingActions).set({ position }).where(eq(t.meetingActions.id, same.id)).run()
        return
      }
      const todoId = createTodo(tx, { title: text, dueDate: due }, 'meeting')
      tx.insert(t.meetingActions)
        .values({ id: randomUUID(), meetingId: id, position, text, todoId })
        .run()
    })
    // Actions taken off the list: their todos are archived if not done.
    for (const c of current) {
      if (actions.includes(c.text)) continue
      tx.delete(t.meetingActions).where(eq(t.meetingActions.id, c.id)).run()
      if (c.todoId) {
        tx.update(t.todos)
          .set({ archived: true })
          .where(and(eq(t.todos.id, c.todoId), eq(t.todos.done, false)))
          .run()
      }
    }
  })
  return id
}

export function removeMeeting(db: Db, id: string): void {
  db.delete(t.meetings).where(eq(t.meetings.id, id)).run()
}

// --- Sessions ----------------------------------------------------------------------------

/**
 * Put a work session on a section on the calendar: at `start`, or in the next free slot.
 * It is an ordinary flexible block, so timers, outcomes, debriefs and records all work.
 */
export function scheduleSession(
  db: Db,
  sectionId: string,
  opts: { minutes: number; start?: string },
  now: Temporal.Instant
): string {
  const section = db.select().from(t.dissSections).where(eq(t.dissSections.id, sectionId)).get()
  if (!section) throw new Error('Section not found.')
  if (!Number.isInteger(opts.minutes) || opts.minutes < 15 || opts.minutes > 240) {
    throw new Error('Sessions are 15 minutes to 4 hours.')
  }
  const slot = opts.start
    ? {
        start: toIso(Temporal.Instant.from(opts.start)),
        end: toIso(Temporal.Instant.from(opts.start).add({ minutes: opts.minutes }))
      }
    : nextFreeSlot(db, opts.minutes, now)
  const settings = getSettings(db)
  const mod = settings.moduleId
    ? db.select().from(t.modules).where(eq(t.modules.id, settings.moduleId)).get()
    : undefined
  const id = `ds-${randomUUID().slice(0, 12)}`
  db.insert(t.blocks)
    .values({
      id,
      kind: 'flexible',
      type: 'dissertation',
      title: `Dissertation: ${section.title}`,
      start: slot.start,
      end: slot.end,
      categoryId: mod?.categoryId ?? null,
      linkedType: 'dissertation-section',
      linkedId: sectionId,
      source: 'user',
      detached: true
    })
    .run()
  return id
}

// --- Plan import --------------------------------------------------------------------------

/**
 * Save a plan the user has checked: sections (new titles only) and milestones are added, and
 * the title, submission date and word target are set when given.
 */
export function applyPlan(db: Db, draft: PlanDraft): { sections: number; milestones: number } {
  const have = new Set(
    db
      .select({ title: t.dissSections.title })
      .from(t.dissSections)
      .all()
      .map((s) => s.title.toLowerCase())
  )
  let sections = 0
  let milestones = 0
  db.transaction(() => {
    const patch: Partial<DissertationSettings> = {}
    if (draft.title?.trim()) patch.title = draft.title.trim()
    if (draft.submissionDue) {
      patch.submissionDue = DATE.test(draft.submissionDue)
        ? toIso(atLocalTime(draft.submissionDue, '12:00'))
        : draft.submissionDue
    }
    if (draft.wordTarget) patch.wordTarget = draft.wordTarget
    if (Object.keys(patch).length) updateSettings(db, patch)
    for (const s of draft.sections) {
      if (!s.title.trim() || have.has(s.title.trim().toLowerCase())) continue
      addSection(db, s.title, s.wordTarget)
      have.add(s.title.trim().toLowerCase())
      sections++
    }
    for (const m of draft.milestones) {
      if (!m.title.trim() || !DATE.test(m.due)) continue
      addMilestone(db, m.title, m.due)
      milestones++
    }
  })
  return { sections, milestones }
}

// --- Reading it all back ------------------------------------------------------------------

export function getOverview(db: Db, now: Temporal.Instant): DissertationOverview {
  const settings = getSettings(db)
  const nowIso = toIso(now)
  const sectionRows = db.select().from(t.dissSections).orderBy(asc(t.dissSections.position)).all()
  const reading = db.select().from(t.readingItems).all()
  const blocks = db
    .select()
    .from(t.blocks)
    .where(eq(t.blocks.linkedType, 'dissertation-section'))
    .orderBy(asc(t.blocks.start))
    .all()
  const logged = new Map<string, number>()
  for (const s of db
    .select({ linkedId: t.sessions.linkedId, minutes: t.sessions.minutes })
    .from(t.sessions)
    .where(and(eq(t.sessions.linkedType, 'dissertation-section'), isNotNull(t.sessions.linkedId)))
    .all()) {
    logged.set(s.linkedId!, (logged.get(s.linkedId!) ?? 0) + s.minutes)
  }

  const sections = sectionRows.map((s) => ({
    ...s,
    loggedMinutes: logged.get(s.id) ?? 0,
    upcoming: blocks
      .filter((b) => b.linkedId === s.id && b.outcome === 'none' && b.end > nowIso)
      .map((b) => ({ id: b.id, start: b.start, end: b.end })),
    readingCount: reading.filter((r) => r.sectionIds.includes(s.id)).length
  }))

  const actions = db.select().from(t.meetingActions).orderBy(asc(t.meetingActions.position)).all()
  const todoDone = new Map(
    db
      .select({ id: t.todos.id, done: t.todos.done })
      .from(t.todos)
      .all()
      .map((x) => [x.id, x.done])
  )
  const meetings: Meeting[] = db
    .select()
    .from(t.meetings)
    .all()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((m) => ({
      ...m,
      actions: actions
        .filter((a) => a.meetingId === m.id)
        .map((a) => ({
          id: a.id,
          text: a.text,
          todoId: a.todoId,
          done: a.todoId ? (todoDone.get(a.todoId) ?? false) : false
        }))
    }))

  const vivaDays = [
    ...new Set(
      db
        .select({ start: t.timetableEvents.start })
        .from(t.timetableEvents)
        .where(and(eq(t.timetableEvents.type, 'viva'), gt(t.timetableEvents.start, nowIso)))
        .orderBy(asc(t.timetableEvents.start))
        .all()
        .map((e) => zoned(e.start).toPlainDate().toString())
    )
  ]
  const synced = db.select().from(t.dissertation).where(eq(t.dissertation.id, ID)).get()

  return {
    settings,
    sections,
    milestones: db.select().from(t.dissMilestones).orderBy(asc(t.dissMilestones.due)).all(),
    reading: reading.sort((a, b) => a.creators.localeCompare(b.creators)),
    meetings,
    wordCount: sectionRows.reduce((n, s) => n + (s.wordCount ?? 0), 0),
    zoteroSyncedAt: synced?.zoteroSyncedAt ?? null,
    vivaDays,
    colour: settings.moduleId
      ? (listModules(db).find((m) => m.id === settings.moduleId)?.colour ?? null)
      : null
  }
}

/** Submission, your viva and open milestones, for the calendar's deadline strip. */
export function dissertationDeadlines(db: Db, startIso: string, endIso: string): Deadline[] {
  const s = getSettings(db)
  const mod = s.moduleId
    ? db.select().from(t.modules).where(eq(t.modules.id, s.moduleId)).get()
    : undefined
  const categoryId = mod?.categoryId ?? null
  const out: Deadline[] = []
  const inRange = (iso: string) => iso >= startIso && iso < endIso
  if (s.submissionDue && inRange(s.submissionDue)) {
    out.push({
      id: 'diss-submission',
      title: 'Dissertation due',
      at: s.submissionDue,
      categoryId,
      kind: 'dissertation'
    })
  }
  if (s.vivaDate) {
    const at = toIso(atLocalTime(s.vivaDate, s.vivaTime ?? '09:00'))
    if (inRange(at)) {
      out.push({ id: 'diss-viva', title: 'Your viva', at, categoryId, kind: 'dissertation' })
    }
  }
  for (const m of db.select().from(t.dissMilestones).all()) {
    if (m.doneAt) continue
    const at = toIso(atLocalTime(m.due, '12:00'))
    if (inRange(at)) {
      out.push({ id: `diss-m-${m.id}`, title: m.title, at, categoryId, kind: 'dissertation' })
    }
  }
  return out
}
