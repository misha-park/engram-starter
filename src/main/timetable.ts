import { createHash } from 'crypto'
import { and, eq, gt, inArray, lt, ne } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type { FeedName, ImportSummary, ModuleUpdate } from '../shared/types'
import type { TimetableEvent } from '../core/ics'
import { MIN_PART, validCuts } from '../core/lecture-list'
import { timetableTitle, writeUpMinutesFor } from '../core/lectures'
import { kindOf, sessionLabels, type SessionKind } from '../core/session-kinds'
import {
  placeWriteUp,
  WRITE_UP_MAX_DAYS_AFTER,
  writeUpLimit,
  type Interval
} from '../core/scheduler'
import { atLocalTime, minutesBetween, toIso } from '../core/time'
import { getAvailability, logChange } from './calendar'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'
import { resetModuleForums } from './moodle/forums'

// Timetable import and module mapping.
//
// - Events are keyed on the feed UID, so importing the same feed twice changes nothing.
// - Several feed names can map to one module (cross-listed modules). Events that become
//   identical after mapping (same module, type and time) share one block.
// - Timetabled blocks are never moved by hand, so the feed's times always win for them.
//   Derived write-up blocks the user has moved (detached) or marked are never touched.

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const OUTSIDE_AVAILABILITY = `Placed outside your availability: no free time within ${WRITE_UP_MAX_DAYS_AFTER} working days of the lecture.`
const LECTURE_REMOVED = 'Its lecture was removed from the timetable.'

export function importTimetable(
  db: Db,
  events: TimetableEvent[],
  now: Temporal.Instant,
  opts: { source: string; skipped?: number }
): ImportSummary {
  const nowIso = toIso(now)
  let added = 0
  let updated = 0
  let removed = 0

  const summary = db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(t.timetableEvents)
        .all()
        .map((r) => [r.uid, r])
    )
    const seen = new Set<string>()

    for (const ev of events) {
      seen.add(ev.uid)
      const row = existing.get(ev.uid)
      const values = {
        moduleName: ev.moduleName,
        level: ev.level,
        feedType: ev.feedType,
        type: ev.type,
        start: ev.start,
        end: ev.end,
        lastSeenAt: nowIso
      }
      if (!row) {
        tx.insert(t.timetableEvents)
          .values({ uid: ev.uid, ...values })
          .run()
        added++
      } else {
        const changed =
          row.moduleName !== ev.moduleName ||
          row.feedType !== ev.feedType ||
          row.start !== ev.start ||
          row.end !== ev.end
        tx.update(t.timetableEvents).set(values).where(eq(t.timetableEvents.uid, ev.uid)).run()
        if (changed) updated++
      }
    }

    // Events that disappeared from the feed: drop future ones; keep the past (feeds trim history).
    for (const [uid, row] of existing) {
      if (!seen.has(uid) && row.start > nowIso) {
        tx.delete(t.timetableEvents).where(eq(t.timetableEvents.uid, uid)).run()
        removed++
      }
    }

    const result = reconcileTimetable(tx, now)
    const summary: ImportSummary = {
      at: nowIso,
      source: opts.source,
      events: events.length,
      added,
      updated,
      removed,
      hidden: events.filter((e) => e.type === null).length,
      skipped: opts.skipped ?? 0,
      lectures: result.lectures,
      writeUpsPlaced: result.writeUpsPlaced,
      writeUpsNeedingAttention: result.writeUpsNeedingAttention,
      unmappedNames: listFeedNames(tx)
        .filter((f) => f.moduleId === null && !f.hiddenOnly)
        .map((f) => f.name)
    }
    tx.insert(t.settings)
      .values({ key: 'timetableLastImport', value: summary })
      .onConflictDoUpdate({ target: t.settings.key, set: { value: summary } })
      .run()
    logChange(tx, {
      actor: 'system',
      action: 'timetable.import',
      entityType: 'timetable',
      entityId: opts.source,
      after: { added, updated, removed }
    })
    return summary
  })
  return summary
}

/**
 * Bring blocks, lectures and write-ups in line with the stored timetable events and the
 * current module mapping. Safe to run any time (after an import, or after a mapping change).
 */
export function reconcileTimetable(
  db: DbOrTx,
  now: Temporal.Instant
): { lectures: number; writeUpsPlaced: number; writeUpsNeedingAttention: number } {
  const nowIso = toIso(now)
  const aliases = new Map(
    db
      .select()
      .from(t.moduleAliases)
      .all()
      .map((a) => [a.feedName, a.moduleId])
  )
  const modules = new Map(
    db
      .select({
        id: t.modules.id,
        categoryId: t.modules.categoryId,
        label: t.categories.shortLabel,
        writeUpMinutes: t.modules.writeUpMinutes,
        timetabledSessions: t.modules.timetabledSessions
      })
      .from(t.modules)
      .innerJoin(t.categories, eq(t.modules.categoryId, t.categories.id))
      .all()
      .map((m) => [m.id, m])
  )

  // 1. Group visible events into blocks (cross-listed duplicates collapse into one).
  const events = db.select().from(t.timetableEvents).all()
  const groups = new Map<string, typeof events>()
  for (const ev of events) {
    // [None] events stay hidden. Viva events in the feed are cohort-wide viva sessions (long
    // blocks on many days, several at once), not the user's own viva: they become deadlines
    // (see listDeadlines) but never calendar blocks, which would block out whole days.
    if (ev.type === null || ev.type === 'viva' || ev.hidden) continue
    const moduleKey = aliases.get(ev.moduleName) ?? `feed:${ev.moduleName}`
    const key = `${moduleKey}|${ev.type}|${ev.start}|${ev.end}`
    groups.set(key, [...(groups.get(key) ?? []), ev])
  }

  const laterParts = applySplits(db, groups)

  const liveBlockIds = new Set<string>()
  const groupBlocks: {
    blockId: string
    first: (typeof events)[number]
    moduleId: string | null
  }[] = []
  const lectureBlocks: {
    blockId: string
    moduleId: string
    start: string
    end: string
    timeChanged: boolean
    /** A [Practical] or [Workshop] event listed with the lectures (the module's choice). */
    feedKind: SessionKind | null
  }[] = []

  // Decide which block each group uses, keeping block identities stable:
  //  (a) the block created for exactly this group before (its deterministic id), then
  //  (b) a block its events already point at (e.g. the event's time changed in the feed),
  //  (c) otherwise a new, unused id.
  const existingIds = new Set(
    db
      .select({ id: t.blocks.id })
      .from(t.blocks)
      .all()
      .map((b) => b.id)
  )
  const claimed = new Map<string, string>()
  for (const key of groups.keys()) {
    const id = `tt-${hash(key)}`
    if (existingIds.has(id)) {
      claimed.set(key, id)
      liveBlockIds.add(id)
    }
  }
  for (const [key, group] of groups) {
    if (claimed.has(key)) continue
    // A later part of a split lecture never takes over the block its events point at (the
    // first part's).
    const reuse = (laterParts.has(key) ? [] : group)
      .map((e) => e.blockId)
      .find((id) => id && existingIds.has(id) && !liveBlockIds.has(id))
    let id = reuse ?? `tt-${hash(key)}`
    for (let n = 2; !reuse && (existingIds.has(id) || liveBlockIds.has(id)); n++) {
      id = `tt-${hash(`${key}#${n}`)}`
    }
    claimed.set(key, id)
    liveBlockIds.add(id)
  }

  for (const [key, group] of groups) {
    group.sort((a, b) => a.uid.localeCompare(b.uid))
    const first = group[0]
    const moduleId = aliases.get(first.moduleName) ?? null
    const mod = moduleId ? modules.get(moduleId) : undefined
    const blockId = claimed.get(key)!
    const existingBlock = existingIds.has(blockId)
      ? db.select().from(t.blocks).where(eq(t.blocks.id, blockId)).get()
      : undefined
    const type = first.type!
    const values = {
      kind: 'fixed' as const,
      type,
      start: first.start,
      end: first.end,
      categoryId: mod?.categoryId ?? null,
      source: 'timetable' as const
    }
    const timeChanged =
      !!existingBlock && (existingBlock.start !== first.start || existingBlock.end !== first.end)
    if (existingBlock) {
      db.update(t.blocks)
        .set({ ...values, updatedAt: timeChanged ? nowIso : existingBlock.updatedAt })
        .where(eq(t.blocks.id, blockId))
        .run()
    } else {
      db.insert(t.blocks)
        .values({ id: blockId, title: first.moduleName, ...values })
        .run()
    }
    groupBlocks.push({ blockId, first, moduleId })
    for (const ev of group) {
      if (!laterParts.has(key) && ev.blockId !== blockId) {
        db.update(t.timetableEvents).set({ blockId }).where(eq(t.timetableEvents.uid, ev.uid)).run()
      }
    }
    // Lectures, plus practicals and workshops in modules that list them (with write-ups).
    const listed =
      type === 'lecture' ||
      ((type === 'practical' || type === 'workshop') && !!mod?.timetabledSessions)
    if (listed && moduleId) {
      lectureBlocks.push({
        blockId,
        moduleId,
        start: first.start,
        end: first.end,
        timeChanged,
        feedKind: type === 'lecture' ? null : type
      })
    }
  }

  // 2. Remove timetable blocks no event points at any more (their lecture rows cascade).
  const lectureRows = db.select().from(t.lectures).all()
  const orphanLectures = new Map(lectureRows.map((l) => [l.blockId, l]))
  for (const b of db
    .select({ id: t.blocks.id })
    .from(t.blocks)
    .where(eq(t.blocks.source, 'timetable'))
    .all()) {
    if (liveBlockIds.has(b.id)) continue
    const lecture = orphanLectures.get(b.id)
    if (lecture?.writeUpBlockId) releaseWriteUp(db, lecture.writeUpBlockId)
    db.delete(t.blocks).where(eq(t.blocks.id, b.id)).run()
  }

  // 3. Lectures: one per lecture block with a mapped module; renumber per module by start.
  const byBlock = new Map(
    db
      .select()
      .from(t.lectures)
      .all()
      .map((l) => [l.blockId, l])
  )
  for (const lb of lectureBlocks) {
    const lecture = byBlock.get(lb.blockId)
    if (!lecture) {
      db.insert(t.lectures)
        .values({
          id: `lec-${lb.blockId.slice(3)}`,
          moduleId: lb.moduleId,
          blockId: lb.blockId,
          number: 0,
          // The timetable says what it is, so it isn't a guess.
          kind: lb.feedKind
        })
        .run()
    } else if (lecture.moduleId !== lb.moduleId) {
      db.update(t.lectures)
        .set({ moduleId: lb.moduleId })
        .where(eq(t.lectures.id, lecture.id))
        .run()
    }
  }
  const lectureBlockIds = new Set(lectureBlocks.map((l) => l.blockId))
  for (const l of db.select().from(t.lectures).all()) {
    if (!lectureBlockIds.has(l.blockId)) {
      // The block is no longer a mapped lecture (e.g. its feed name was unmapped).
      if (l.writeUpBlockId) releaseWriteUp(db, l.writeUpBlockId)
      db.delete(t.lectures).where(eq(t.lectures.id, l.id)).run()
    }
  }

  // Renumber and retitle. A session that continues an earlier lecture (one lecture across
  // several days) shares its number and is "part 2"; it isn't counted. Numbers run through
  // all of a module's sessions (Claude refers to them by number); titles use the per-kind
  // labels the module page shows ("INV WS1").
  const sessions = lectureGroups(db)
  for (const [moduleId] of modules) {
    const own = lectureBlocks
      .filter((l) => l.moduleId === moduleId)
      .sort((a, b) => a.start.localeCompare(b.start))
    let n = 0
    const numberOf = new Map<string, number>()
    for (const lb of own) {
      const g = sessions.byBlock.get(lb.blockId)
      if (g && g.rootBlockId !== lb.blockId) continue
      n++
      numberOf.set(lb.blockId, n)
      db.update(t.lectures).set({ number: n }).where(eq(t.lectures.blockId, lb.blockId)).run()
    }
    for (const lb of own) {
      const g = sessions.byBlock.get(lb.blockId)
      if (!g || g.rootBlockId === lb.blockId) continue
      const num = numberOf.get(g.rootBlockId) ?? 0
      db.update(t.lectures).set({ number: num }).where(eq(t.lectures.blockId, lb.blockId)).run()
    }
  }
  const titleOf = new Map<string, string>()
  const info = sessionInfo(db)
  for (const l of db.select().from(t.lectures).all()) {
    const mod = modules.get(l.moduleId)
    const s = info.get(l.id)
    if (!mod || !s) continue
    const part = sessions.byBlock.get(l.blockId)?.part ?? 1
    const name = s.label || s.rootTitle?.trim() || 'Session'
    titleOf.set(l.blockId, `${mod.label} ${name}${part > 1 ? ` · part ${part}` : ''}`)
  }
  for (const { blockId, first, moduleId } of groupBlocks) {
    const title =
      titleOf.get(blockId) ??
      timetableTitle({
        moduleLabel: moduleId ? (modules.get(moduleId)?.label ?? null) : null,
        feedModuleName: first.moduleName,
        type: first.type!,
        feedType: first.feedType
      })
    db.update(t.blocks).set({ title }).where(eq(t.blocks.id, blockId)).run()
  }

  // 4. Write-ups: place missing ones; re-place untouched ones whose lecture moved. Lectures
  // before the start date (setup) get none: they wait in the Backlog as write-ups to do.
  const availability = getAvailability(db)
  const startDate = getStartDate(db)
  const startIso = startDate ? toIso(atLocalTime(startDate, '00:00')) : null
  let writeUpsPlaced = 0
  let writeUpsNeedingAttention = 0
  const lectures = db
    .select()
    .from(t.lectures)
    .all()
    .sort((a, b) => {
      const sa = lectureBlocks.find((l) => l.blockId === a.blockId)!.start
      const sb = lectureBlocks.find((l) => l.blockId === b.blockId)!.start
      return sa.localeCompare(sb)
    })
  for (const lecture of lectures) {
    const own = lectureBlocks.find((l) => l.blockId === lecture.blockId)!
    const title = `${titleOf.get(own.blockId)} write-up`
    const current = lecture.writeUpBlockId
      ? db.select().from(t.blocks).where(eq(t.blocks.id, lecture.writeUpBlockId)).get()
      : undefined

    // One lecture across several sessions: the first part gets one write-up, after the last
    // part and sized for all of them; the other parts get none (Engram's own is removed).
    const group = sessions.byBlock.get(own.blockId)
    if (group && group.rootBlockId !== own.blockId) {
      if (current && current.source === 'auto' && !current.detached && current.outcome === 'none') {
        db.delete(t.blocks).where(eq(t.blocks.id, current.id)).run()
        db.update(t.lectures)
          .set({ writeUpBlockId: null })
          .where(eq(t.lectures.id, lecture.id))
          .run()
      }
      continue
    }
    const members = group
      ? lectureBlocks.filter((l) => sessions.byBlock.get(l.blockId)?.rootBlockId === own.blockId)
      : [own]
    const lb = {
      ...own,
      end: members.reduce((e, m) => (m.end > e ? m.end : e), own.end),
      minutes: members.reduce((sum, m) => sum + minutesBetween(m.start, m.end), 0),
      timeChanged: members.some((m) => m.timeChanged)
    }

    // You deleted its write-up: none is placed again (keep one you put back by hand).
    if (lecture.noWriteUp) continue

    if (startIso && lb.start < startIso) {
      // Before the start date: drop a write-up Engram placed itself (untouched); keep any the
      // user moved, marked or scheduled from the Backlog.
      if (current && current.source === 'auto' && !current.detached && current.outcome === 'none') {
        db.delete(t.blocks).where(eq(t.blocks.id, current.id)).run()
        db.update(t.lectures)
          .set({ writeUpBlockId: null })
          .where(eq(t.lectures.id, lecture.id))
          .run()
      } else if (current && current.title !== title) {
        db.update(t.blocks).set({ title }).where(eq(t.blocks.id, current.id)).run()
      }
      continue
    }

    if (current) {
      const replace = lb.timeChanged && !current.detached && current.outcome === 'none'
      if (!replace) {
        if (current.title !== title)
          db.update(t.blocks).set({ title }).where(eq(t.blocks.id, current.id)).run()
        continue
      }
      db.delete(t.blocks).where(eq(t.blocks.id, current.id)).run()
    }

    // The lecture came back (e.g. its module was re-mapped): re-adopt the write-up it had.
    const id = `wu-${lecture.id.slice(4)}`
    const previous = db.select().from(t.blocks).where(eq(t.blocks.id, id)).get()
    if (previous) {
      db.update(t.blocks)
        .set({
          linkedType: 'lecture',
          linkedId: lecture.id,
          title,
          attention: previous.attention === LECTURE_REMOVED ? null : previous.attention
        })
        .where(eq(t.blocks.id, id))
        .run()
      db.update(t.lectures).set({ writeUpBlockId: id }).where(eq(t.lectures.id, lecture.id)).run()
      continue
    }

    const mod = modules.get(lecture.moduleId)!
    const slot = placeWriteUp({
      lectureEnd: lb.end,
      durationMinutes: writeUpMinutesFor(lb.minutes, mod.writeUpMinutes),
      busy: busyAround(db, lb.end),
      availability,
      now: nowIso
    })
    if (!slot) {
      db.update(t.lectures).set({ writeUpBlockId: null }).where(eq(t.lectures.id, lecture.id)).run()
      writeUpsNeedingAttention++
      continue
    }
    db.insert(t.blocks)
      .values({
        id,
        kind: 'flexible',
        type: 'write-up',
        title,
        start: slot.start,
        end: slot.end,
        categoryId: mod.categoryId,
        linkedType: 'lecture',
        linkedId: lecture.id,
        source: 'auto',
        attention: slot.withinAvailability ? null : OUTSIDE_AVAILABILITY
      })
      .run()
    db.update(t.lectures).set({ writeUpBlockId: id }).where(eq(t.lectures.id, lecture.id)).run()
    writeUpsPlaced++
    if (!slot.withinAvailability) writeUpsNeedingAttention++
  }

  return { lectures: lectures.length, writeUpsPlaced, writeUpsNeedingAttention }
}

type TimetableEventRow = typeof t.timetableEvents.$inferSelect

/**
 * Lectures that are one lecture across several sessions (continuesId): for each session in a
 * group, its first session's block and which part it is (1 = the first). Links to a lecture
 * of another module, or loops, are ignored.
 */
/**
 * The first session of a lecture across several (itself otherwise): slides and names belong
 * to it, since the later sessions share its number.
 */
export function rootLectureId(db: DbOrTx, lectureId: string): string {
  const rows = db
    .select({
      id: t.lectures.id,
      continuesId: t.lectures.continuesId,
      moduleId: t.lectures.moduleId
    })
    .from(t.lectures)
    .all()
  return rootLectureIds(rows).get(lectureId) ?? lectureId
}

/**
 * Each lecture's kind (the user's, or guessed from its name), whether the user confirmed it,
 * and its label ("L3", "WS1", "P2"; "" for an other session), numbered per kind within its
 * module. A later session of one lecture takes its first session's kind and label.
 */
export function sessionInfo(
  db: DbOrTx
): Map<
  string,
  { kind: SessionKind; kindConfirmed: boolean; label: string; rootTitle: string | null }
> {
  const rows = db
    .select({
      id: t.lectures.id,
      moduleId: t.lectures.moduleId,
      blockId: t.lectures.blockId,
      kind: t.lectures.kind,
      title: t.lectures.title,
      start: t.blocks.start
    })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .all()
  const groups = lectureGroups(db).byBlock
  const byId = new Map(rows.map((r) => [r.id, r]))
  const rootOf = (r: (typeof rows)[number]) => byId.get(groups.get(r.blockId)?.rootId ?? '') ?? r
  const info = new Map<
    string,
    { kind: SessionKind; kindConfirmed: boolean; label: string; rootTitle: string | null }
  >()
  for (const moduleId of new Set(rows.map((r) => r.moduleId))) {
    const own = rows.filter((r) => r.moduleId === moduleId)
    const labels = sessionLabels(
      own.map((r) => {
        const root = rootOf(r)
        return { id: r.id, start: r.start, kind: kindOf(root.kind, root.title), rootId: root.id }
      })
    )
    for (const r of own) {
      const root = rootOf(r)
      info.set(r.id, {
        kind: kindOf(root.kind, root.title),
        kindConfirmed: root.kind !== null,
        label: labels.get(r.id) ?? '',
        rootTitle: root.title
      })
    }
  }
  return info
}

/**
 * Say what a session is (lecture, workshop, practical or other), or null to go back to the
 * guess from its name. A lecture across several sessions changes as a whole.
 */
export function setLectureKind(
  db: Db,
  lectureId: string,
  kind: SessionKind | null,
  now: Temporal.Instant
): void {
  const id = rootLectureId(db, lectureId)
  const lecture = db.select().from(t.lectures).where(eq(t.lectures.id, id)).get()
  if (!lecture) throw new Error('Lecture not found.')
  db.transaction((tx) => {
    tx.update(t.lectures).set({ kind }).where(eq(t.lectures.id, id)).run()
    logChange(tx, {
      actor: 'user',
      action: 'lecture.kind',
      entityType: 'lecture',
      entityId: id,
      before: { kind: lecture.kind },
      after: { kind }
    })
    reconcileTimetable(tx, now) // block titles use the labels
  })
}

/** The guesses for one kind in a module are right: keep them. Returns how many. */
export function confirmKinds(
  db: Db,
  moduleId: string,
  kind: SessionKind,
  now: Temporal.Instant
): number {
  const info = sessionInfo(db)
  const ids = db
    .select({ id: t.lectures.id, kind: t.lectures.kind, continuesId: t.lectures.continuesId })
    .from(t.lectures)
    .where(eq(t.lectures.moduleId, moduleId))
    .all()
    .filter((l) => l.kind === null && !l.continuesId && info.get(l.id)?.kind === kind)
    .map((l) => l.id)
  if (!ids.length) return 0
  db.transaction((tx) => {
    tx.update(t.lectures).set({ kind }).where(inArray(t.lectures.id, ids)).run()
    logChange(tx, {
      actor: 'user',
      action: 'lecture.kind',
      entityType: 'module',
      entityId: moduleId,
      after: { kind, lectures: ids.length }
    })
    reconcileTimetable(tx, now)
  })
  return ids.length
}

/** Each lecture's first session (see `rootLectureId`), from rows already loaded. */
export function rootLectureIds(
  rows: { id: string; continuesId: string | null; moduleId: string }[]
): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const roots = new Map<string, string>()
  for (const r of rows) {
    let cur = r
    const seen = new Set<string>()
    while (cur.continuesId && !seen.has(cur.id)) {
      seen.add(cur.id)
      const next = byId.get(cur.continuesId)
      if (!next || next.moduleId !== r.moduleId) break
      cur = next
    }
    roots.set(r.id, cur.id)
  }
  return roots
}

export function lectureGroups(db: DbOrTx) {
  const rows = db
    .select({
      id: t.lectures.id,
      blockId: t.lectures.blockId,
      moduleId: t.lectures.moduleId,
      continuesId: t.lectures.continuesId,
      start: t.blocks.start
    })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const rootOf = (r: (typeof rows)[number]) => {
    let cur = r
    const seen = new Set<string>()
    while (cur.continuesId && !seen.has(cur.id)) {
      seen.add(cur.id)
      const next = byId.get(cur.continuesId)
      if (!next || next.moduleId !== r.moduleId) break
      cur = next
    }
    return cur
  }
  const members = new Map<string, (typeof rows)[number][]>()
  for (const r of rows) {
    const root = rootOf(r)
    if (root.id === r.id && !r.continuesId) continue
    members.set(root.id, [...(members.get(root.id) ?? [root]), ...(root.id === r.id ? [] : [r])])
  }
  const byBlock = new Map<string, { rootId: string; rootBlockId: string; part: number }>()
  for (const [rootId, list] of members) {
    const sorted = [...new Map(list.map((x) => [x.id, x])).values()].sort((a, b) =>
      a.start.localeCompare(b.start)
    )
    if (sorted.length < 2) continue
    const root = byId.get(rootId)!
    sorted.forEach((x, i) =>
      byBlock.set(x.blockId, { rootId, rootBlockId: root.blockId, part: i + 1 })
    )
  }
  return { byBlock }
}

/**
 * Delete a lecture's write-up and place none again (the user doesn't want one), or, with
 * `wanted`, take that back and place one.
 */
export function setNoWriteUp(
  db: Db,
  lectureId: string,
  noWriteUp: boolean,
  now: Temporal.Instant,
  actor: 'user' | 'claude' = 'user'
): void {
  const id = rootLectureId(db, lectureId)
  const lecture = db.select().from(t.lectures).where(eq(t.lectures.id, id)).get()
  if (!lecture) throw new Error('Lecture not found.')
  db.transaction((tx) => {
    tx.update(t.lectures).set({ noWriteUp }).where(eq(t.lectures.id, id)).run()
    if (noWriteUp && lecture.writeUpBlockId) {
      tx.update(t.lectures).set({ writeUpBlockId: null }).where(eq(t.lectures.id, id)).run()
      tx.delete(t.blocks).where(eq(t.blocks.id, lecture.writeUpBlockId)).run()
    }
    logChange(tx, {
      actor,
      action: noWriteUp ? 'lecture.noWriteUp' : 'lecture.writeUpWanted',
      entityType: 'lecture',
      entityId: id
    })
  })
  if (!noWriteUp) reconcileTimetable(db, now)
}

/** Remove a lecture's write-up if Engram placed it and nobody touched it (so it's placed again). */
function dropUntouchedWriteUp(db: DbOrTx, lectureId: string): void {
  const l = db.select().from(t.lectures).where(eq(t.lectures.id, lectureId)).get()
  if (!l?.writeUpBlockId) return
  const wu = db.select().from(t.blocks).where(eq(t.blocks.id, l.writeUpBlockId)).get()
  if (wu && wu.source === 'auto' && !wu.detached && wu.outcome === 'none') {
    db.update(t.lectures).set({ writeUpBlockId: null }).where(eq(t.lectures.id, lectureId)).run()
    db.delete(t.blocks).where(eq(t.blocks.id, wu.id)).run()
  }
}

/**
 * Sessions were just merged into one lecture (`rootId` is its first): the later sessions'
 * write-ups not done yet go, even ones moved by hand, and the first session's must cover them
 * all. One Engram placed itself is placed again (by `reconcileTimetable`, sized for every
 * session); one moved by hand stays where it is, lengthened, while it's still after the last
 * session, and is placed again otherwise.
 */
function mergeWriteUps(db: DbOrTx, rootId: string): void {
  const writeUpOf = (l: { writeUpBlockId: string | null }) =>
    l.writeUpBlockId
      ? db.select().from(t.blocks).where(eq(t.blocks.id, l.writeUpBlockId)).get()
      : undefined
  const drop = (lectureId: string, blockId: string) => {
    db.update(t.lectures).set({ writeUpBlockId: null }).where(eq(t.lectures.id, lectureId)).run()
    db.delete(t.blocks).where(eq(t.blocks.id, blockId)).run()
  }
  const root = db.select().from(t.lectures).where(eq(t.lectures.id, rootId)).get()!
  const parts = db.select().from(t.lectures).where(eq(t.lectures.continuesId, rootId)).all()
  for (const p of parts) {
    const wu = writeUpOf(p)
    if (wu && wu.outcome === 'none') drop(p.id, wu.id)
  }
  const wu = writeUpOf(root)
  if (!wu || wu.outcome !== 'none') return
  if (wu.source === 'auto' && !wu.detached) return drop(root.id, wu.id)
  const sessions = [root, ...parts]
    .map((l) => db.select().from(t.blocks).where(eq(t.blocks.id, l.blockId)).get())
    .filter((b) => b !== undefined)
  const lastEnd = sessions.reduce((e, b) => (b.end > e ? b.end : e), '')
  if (wu.start < lastEnd) return drop(root.id, wu.id)
  const mod = db.select().from(t.modules).where(eq(t.modules.id, root.moduleId)).get()!
  const needed = writeUpMinutesFor(
    sessions.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0),
    mod.writeUpMinutes
  )
  if (minutesBetween(wu.start, wu.end) < needed) {
    const end = toIso(Temporal.Instant.from(wu.start).add({ minutes: needed }))
    db.update(t.blocks).set({ end }).where(eq(t.blocks.id, wu.id)).run()
  }
}

/**
 * Make a lecture session part of an earlier lecture (one lecture across several days): it
 * shares that lecture's number and name, and the lecture gets one write-up after its last
 * part, sized for all of them.
 */
export function combineLectures(
  db: Db,
  lectureId: string,
  earlierLectureId: string,
  now: Temporal.Instant
): void {
  const get = (id: string) => {
    const l = db.select().from(t.lectures).where(eq(t.lectures.id, id)).get()
    if (!l) throw new Error('Lecture not found.')
    return { l, block: db.select().from(t.blocks).where(eq(t.blocks.id, l.blockId)).get()! }
  }
  const later = get(lectureId)
  let earlier = get(earlierLectureId)
  if (later.l.id === earlier.l.id) throw new Error('A lecture can’t continue itself.')
  if (later.l.moduleId !== earlier.l.moduleId)
    throw new Error('Only lectures of the same module can be one lecture.')
  // Point at the first part of the earlier lecture.
  while (earlier.l.continuesId) earlier = get(earlier.l.continuesId)
  if (earlier.l.id === later.l.id) throw new Error('That lecture already continues this one.')
  if (later.block.start <= earlier.block.start)
    throw new Error('Choose an earlier lecture for this one to continue.')
  db.transaction((tx) => {
    tx.update(t.lectures)
      .set({ continuesId: earlier.l.id })
      .where(eq(t.lectures.id, later.l.id))
      .run()
    // Anything that continued the later one now continues the first part.
    tx.update(t.lectures)
      .set({ continuesId: earlier.l.id })
      .where(eq(t.lectures.continuesId, later.l.id))
      .run()
    mergeWriteUps(tx, earlier.l.id)
    reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'lecture.combine',
      entityType: 'lecture',
      entityId: later.l.id,
      after: { continues: earlier.l.id }
    })
  })
}

/**
 * Make a session that continued an earlier lecture its own lecture again. Given the first
 * session of a lecture across several, every session becomes its own lecture again.
 */
export function separateLecture(db: Db, lectureId: string, now: Temporal.Instant): void {
  const l = db.select().from(t.lectures).where(eq(t.lectures.id, lectureId)).get()
  if (!l) throw new Error('Lecture not found.')
  const rootId = l.continuesId ?? l.id
  const parts = l.continuesId
    ? [l.id]
    : db
        .select({ id: t.lectures.id })
        .from(t.lectures)
        .where(eq(t.lectures.continuesId, l.id))
        .all()
        .map((x) => x.id)
  if (!parts.length) return
  db.transaction((tx) => {
    tx.update(t.lectures).set({ continuesId: null }).where(inArray(t.lectures.id, parts)).run()
    dropUntouchedWriteUp(tx, rootId)
    reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'lecture.separate',
      entityType: 'lecture',
      entityId: lectureId
    })
  })
}

/**
 * The lecture just before this one in its module (the first session of it, when that lecture
 * runs across several sessions), or null. Sessions already part of this lecture don't count.
 */
export function previousLecture(db: DbOrTx, lectureId: string): string | null {
  const l = db.select().from(t.lectures).where(eq(t.lectures.id, lectureId)).get()
  if (!l) throw new Error('Lecture not found.')
  const rows = db
    .select({ id: t.lectures.id, continuesId: t.lectures.continuesId, start: t.blocks.start })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.blocks.id, t.lectures.blockId))
    .where(eq(t.lectures.moduleId, l.moduleId))
    .all()
    .sort((a, b) => a.start.localeCompare(b.start))
  const own = rows.find((r) => r.id === l.id)!
  const myRoot = l.continuesId ?? l.id
  const before = rows.filter(
    (r) => r.start < own.start && (r.continuesId ?? r.id) !== myRoot && r.id !== myRoot
  )
  const prev = before[before.length - 1]
  return prev ? (prev.continuesId ?? prev.id) : null
}

/** "Same lecture as the one before": make this session the rest of the previous lecture. */
export function mergeWithPrevious(db: Db, lectureId: string, now: Temporal.Instant): string {
  const prev = previousLecture(db, lectureId)
  if (!prev) throw new Error('There’s no earlier lecture in this module to merge with.')
  combineLectures(db, lectureId, prev, now)
  return prev
}

/**
 * Split lecture groups the user (or a lecture list) marked as several lectures
 * (lecture_splits): the group is replaced by one group per part, each with the part's times.
 * Returns the keys of the parts after the first; their events must keep pointing at the first
 * part's block (an event row has one block). A split that no longer fits is ignored.
 */
function applySplits(db: DbOrTx, groups: Map<string, TimetableEventRow[]>): Set<string> {
  const later = new Set<string>()
  const splits = new Map(
    db
      .select()
      .from(t.lectureSplits)
      .all()
      .map((s) => [s.uid, s.cuts])
  )
  if (!splits.size) return later
  for (const [key, group] of [...groups]) {
    if (group[0].type !== 'lecture') continue
    const cuts = group.map((e) => splits.get(e.uid)).find((c) => c)
    const { start, end } = group[0]
    if (!cuts || !validCuts(cuts, minutesBetween(start, end))) continue
    const at = (minutes: number) => toIso(Temporal.Instant.from(start).add({ minutes }))
    const bounds = [start, ...cuts.map(at), end]
    groups.delete(key)
    for (let i = 0; i + 1 < bounds.length; i++) {
      const part = `${key}|part${i}`
      groups.set(
        part,
        group.map((ev) => ({ ...ev, start: bounds[i], end: bounds[i + 1] }))
      )
      if (i > 0) later.add(part)
    }
  }
  return later
}

/** The feed events behind a lecture: the event it is, or the split event it's a part of. */
function lectureEvents(db: DbOrTx, lectureId: string) {
  const l = db.select().from(t.lectures).where(eq(t.lectures.id, lectureId)).get()
  if (!l) throw new Error('Lecture not found.')
  const block = db.select().from(t.blocks).where(eq(t.blocks.id, l.blockId)).get()!
  const own = db
    .select()
    .from(t.timetableEvents)
    .where(eq(t.timetableEvents.blockId, l.blockId))
    .all()
  if (own.length) return { lecture: l, block, events: own }
  // A later part of a split: its events point at the first part's block. Find the split event
  // of the same module that contains this part.
  const partOf = splitEventsOf(db).filter(
    (s) => s.moduleId === l.moduleId && s.start <= block.start && s.end >= block.end
  )
  return { lecture: l, block, events: partOf.flatMap((s) => s.events) }
}

/** The split events, grouped by the first part's block, with their module and full times. */
export function splitEventsOf(db: DbOrTx) {
  const uids = new Set(
    db
      .select({ uid: t.lectureSplits.uid })
      .from(t.lectureSplits)
      .all()
      .map((s) => s.uid)
  )
  if (!uids.size) return []
  const byBlock = new Map<string, TimetableEventRow[]>()
  for (const ev of db.select().from(t.timetableEvents).all()) {
    if (uids.has(ev.uid) && ev.blockId)
      byBlock.set(ev.blockId, [...(byBlock.get(ev.blockId) ?? []), ev])
  }
  const lectures = new Map(
    db
      .select()
      .from(t.lectures)
      .all()
      .map((l) => [l.blockId, l.moduleId])
  )
  return [...byBlock].flatMap(([blockId, events]) => {
    const moduleId = lectures.get(blockId)
    return moduleId
      ? [{ blockId, moduleId, start: events[0].start, end: events[0].end, events }]
      : []
  })
}

/**
 * Split a lecture into several (each gets its own number and write-up, sized to its length;
 * later lectures are renumbered). `cuts` are where the parts begin, in minutes from the
 * lecture's start; by default it's split in half.
 */
export function splitLecture(
  db: Db,
  lectureId: string,
  now: Temporal.Instant,
  cuts?: number[],
  source: 'list' | 'user' = 'user'
): void {
  const { block, events } = lectureEvents(db, lectureId)
  if (!events.length) throw new Error('Only lectures from the timetable can be split.')
  const ev = events[0]
  if (ev.blockId !== block.id || ev.start !== block.start || ev.end !== block.end)
    throw new Error('That lecture is already split. Join it first.')
  const length = minutesBetween(ev.start, ev.end)
  const at = cuts ?? [Math.round(length / 2 / 5) * 5]
  if (!validCuts(at, length))
    throw new Error(`Each part must be at least ${MIN_PART} minutes long.`)
  for (const e of events) {
    db.insert(t.lectureSplits)
      .values({ uid: e.uid, cuts: at, source })
      .onConflictDoUpdate({ target: t.lectureSplits.uid, set: { cuts: at, source } })
      .run()
  }
  reconcileTimetable(db, now)
}

/**
 * Delete a timetabled event from the calendar (e.g. a session the user won't go to). Its feed
 * events are kept but hidden, so later imports leave it out; its lecture goes, and its
 * write-up too unless the user moved or marked it. A part of a split lecture takes the whole
 * timetable slot with it.
 */
export function hideTimetableBlock(db: Db, blockId: string, now: Temporal.Instant): number {
  const block = db.select().from(t.blocks).where(eq(t.blocks.id, blockId)).get()
  if (!block || block.source !== 'timetable') throw new Error('Not a timetabled event.')
  let uids = db
    .select({ uid: t.timetableEvents.uid })
    .from(t.timetableEvents)
    .where(eq(t.timetableEvents.blockId, blockId))
    .all()
    .map((e) => e.uid)
  if (!uids.length) {
    const lecture = db.select().from(t.lectures).where(eq(t.lectures.blockId, blockId)).get()
    if (lecture) uids = lectureEvents(db, lecture.id).events.map((e) => e.uid)
  }
  if (!uids.length) throw new Error('This event isn’t in the timetable any more.')
  db.transaction((tx) => {
    tx.update(t.timetableEvents)
      .set({ hidden: true })
      .where(inArray(t.timetableEvents.uid, uids))
      .run()
    reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'timetable.hide',
      entityType: 'block',
      entityId: blockId,
      before: { title: block.title, start: block.start, end: block.end, uids }
    })
  })
  return uids.length
}

/** How many timetable events the user has deleted (each feed event counts once). */
export function hiddenTimetableCount(db: DbOrTx): number {
  return db.select().from(t.timetableEvents).where(eq(t.timetableEvents.hidden, true)).all().length
}

/** The timetable events the user deleted, soonest first: what each was and when. */
export function listHiddenTimetable(
  db: DbOrTx
): { uid: string; moduleName: string; feedType: string; start: string; end: string }[] {
  return db
    .select({
      uid: t.timetableEvents.uid,
      moduleName: t.timetableEvents.moduleName,
      feedType: t.timetableEvents.feedType,
      start: t.timetableEvents.start,
      end: t.timetableEvents.end
    })
    .from(t.timetableEvents)
    .where(eq(t.timetableEvents.hidden, true))
    .all()
    .sort((a, b) => a.start.localeCompare(b.start))
}

/** Bring one deleted timetable event back. */
export function restoreHiddenEvent(db: Db, uid: string, now: Temporal.Instant): void {
  db.transaction((tx) => {
    tx.update(t.timetableEvents).set({ hidden: false }).where(eq(t.timetableEvents.uid, uid)).run()
    reconcileTimetable(tx, now)
  })
}

/** Bring every deleted timetable event back. */
export function restoreHiddenTimetable(db: Db, now: Temporal.Instant): void {
  db.transaction((tx) => {
    tx.update(t.timetableEvents).set({ hidden: false }).run()
    reconcileTimetable(tx, now)
  })
}

/**
 * Name a lecture by hand. A name the user gives is locked (Claude never changes it); clearing
 * it hands the lecture back to Claude.
 */
export function renameLecture(db: Db, lectureId: string, title: string | null): void {
  const name = title?.trim().slice(0, 200) || null
  const changed = db
    .update(t.lectures)
    .set({ title: name, titleLocked: !!name })
    .where(eq(t.lectures.id, lectureId))
    .run().changes
  if (!changed) throw new Error('Lecture not found.')
  logChange(db, {
    actor: 'user',
    action: 'lecture.rename',
    entityType: 'lecture',
    entityId: lectureId,
    after: { title: name }
  })
}

/** Mark a lecture as attended (the default once it's over) or not. */
export function setAttended(db: Db, lectureId: string, attended: boolean): void {
  const changed = db
    .update(t.lectures)
    .set({ missed: !attended })
    .where(eq(t.lectures.id, lectureId))
    .run().changes
  if (!changed) throw new Error('Lecture not found.')
  logChange(db, {
    actor: 'user',
    action: attended ? 'lecture.attended' : 'lecture.missed',
    entityType: 'lecture',
    entityId: lectureId
  })
}

/** Make a split lecture's parts one lecture again (any part can be given). */
export function joinLecture(db: Db, lectureId: string, now: Temporal.Instant): void {
  const { events } = lectureEvents(db, lectureId)
  const uids = events.map((e) => e.uid)
  if (!uids.length) return
  db.delete(t.lectureSplits).where(inArray(t.lectureSplits.uid, uids)).run()
  reconcileTimetable(db, now)
}

/** All blocks overlapping the write-up window after a lecture (everything counts as busy). */
function busyAround(db: DbOrTx, lectureEnd: string): Interval[] {
  const until = writeUpLimit(lectureEnd).add({ hours: 24 })
  return db
    .select({ start: t.blocks.start, end: t.blocks.end })
    .from(t.blocks)
    .where(
      and(
        lt(t.blocks.start, toIso(until)),
        gt(t.blocks.end, lectureEnd),
        ne(t.blocks.outcome, 'skipped')
      )
    )
    .all()
}

/** A write-up whose lecture went away: delete it if untouched, otherwise keep it and flag it. */
function releaseWriteUp(db: DbOrTx, blockId: string): void {
  const block = db.select().from(t.blocks).where(eq(t.blocks.id, blockId)).get()
  if (!block) return
  if (!block.detached && block.outcome === 'none') {
    db.delete(t.blocks).where(eq(t.blocks.id, blockId)).run()
  } else {
    db.update(t.blocks)
      .set({ attention: LECTURE_REMOVED, linkedType: null, linkedId: null })
      .where(eq(t.blocks.id, blockId))
      .run()
  }
}

// --- Start date ----------------------------------------------------------------------------

/** The day the user started using Engram (YYYY-MM-DD, London), set in setup; null = none. */
export function getStartDate(db: DbOrTx): string | null {
  const row = db.select().from(t.settings).where(eq(t.settings.key, 'startDate')).get()
  return typeof row?.value === 'string' ? row.value : null
}

/**
 * Set (or clear) the start date. Lectures before it lose the write-ups Engram placed for them
 * and wait in the Backlog instead; clearing it places them again.
 */
export function setStartDate(db: Db, date: string | null, now: Temporal.Instant): void {
  if (date !== null) Temporal.PlainDate.from(date) // throws on a bad date
  db.transaction((tx) => {
    if (date === null) tx.delete(t.settings).where(eq(t.settings.key, 'startDate')).run()
    else
      tx.insert(t.settings)
        .values({ key: 'startDate', value: date })
        .onConflictDoUpdate({ target: t.settings.key, set: { value: date } })
        .run()
    reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'setup.startDate',
      entityType: 'settings',
      entityId: 'startDate',
      after: { date }
    })
  })
}

// --- Module mapping ------------------------------------------------------------------------

/** Every module name seen in the feed, with its mapping. */
export function listFeedNames(db: DbOrTx): FeedName[] {
  const aliases = new Map(
    db
      .select()
      .from(t.moduleAliases)
      .all()
      .map((a) => [a.feedName, a.moduleId])
  )
  const counts = new Map<string, { events: number; visible: number }>()
  for (const e of db
    .select({ name: t.timetableEvents.moduleName, type: t.timetableEvents.type })
    .from(t.timetableEvents)
    .all()) {
    const c = counts.get(e.name) ?? { events: 0, visible: 0 }
    c.events++
    if (e.type !== null) c.visible++
    counts.set(e.name, c)
  }
  for (const name of aliases.keys())
    if (!counts.has(name)) counts.set(name, { events: 0, visible: 0 })
  return [...counts]
    .map(([name, c]) => ({
      name,
      moduleId: aliases.get(name) ?? null,
      events: c.events,
      hiddenOnly: c.events > 0 && c.visible === 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Map a feed name to a module (merging it with any other names already mapped there), or unmap it. */
export function assignFeedName(
  db: Db,
  feedName: string,
  moduleId: string | null,
  now: Temporal.Instant
): FeedName[] {
  db.transaction((tx) => {
    tx.delete(t.moduleAliases).where(eq(t.moduleAliases.feedName, feedName)).run()
    if (moduleId) {
      const exists = tx.select().from(t.modules).where(eq(t.modules.id, moduleId)).get()
      if (!exists) throw new Error('Module not found.')
      tx.insert(t.moduleAliases).values({ feedName, moduleId }).run()
    }
    reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'module.mapFeedName',
      entityType: 'feedName',
      entityId: feedName,
      after: { moduleId }
    })
  })
  return listFeedNames(db)
}

/** Create a module (and its category) from a feed name. */
export function createModule(
  db: Db,
  input: { name: string; shortLabel: string; colour: string; feedName?: string },
  now: Temporal.Instant
): string {
  const name = input.name.trim()
  const label = input.shortLabel.trim().toUpperCase()
  if (!name || !label) throw new Error('A module needs a name and a short label.')
  if (!/^#[0-9a-f]{6}$/i.test(input.colour)) throw new Error('Invalid colour.')
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'module'
  const taken = new Set(
    db
      .select({ id: t.categories.id })
      .from(t.categories)
      .all()
      .map((c) => c.id)
  )
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  db.transaction((tx) => {
    const order = tx.select({ id: t.categories.id }).from(t.categories).all().length
    tx.insert(t.categories)
      .values({
        id,
        kind: 'module',
        name,
        shortLabel: label,
        colour: input.colour,
        sortOrder: order
      })
      .run()
    tx.insert(t.modules).values({ id, categoryId: id, writeUpMinutes: 60 }).run()
    if (input.feedName) {
      tx.delete(t.moduleAliases).where(eq(t.moduleAliases.feedName, input.feedName)).run()
      tx.insert(t.moduleAliases).values({ feedName: input.feedName, moduleId: id }).run()
    }
    reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'module.create',
      entityType: 'module',
      entityId: id,
      after: input
    })
  })
  return id
}

/** Edit a module's settings. A new write-up length applies to write-ups placed from now on. */
export function updateModule(db: Db, id: string, patch: ModuleUpdate, now: Temporal.Instant): void {
  const mod = db.select().from(t.modules).where(eq(t.modules.id, id)).get()
  if (!mod) throw new Error('Module not found.')
  if (
    patch.writeUpMinutes !== undefined &&
    (!Number.isInteger(patch.writeUpMinutes) ||
      patch.writeUpMinutes < 15 ||
      patch.writeUpMinutes > 480)
  ) {
    throw new Error('Write-up length must be between 15 minutes and 8 hours.')
  }
  if (patch.colour !== undefined && !/^#[0-9a-f]{6}$/i.test(patch.colour))
    throw new Error('Invalid colour.')
  if (patch.name !== undefined && !patch.name.trim()) throw new Error('A module needs a name.')
  if (patch.shortLabel !== undefined && !/^\S{1,8}$/.test(patch.shortLabel.trim()))
    throw new Error('The short label is 1 to 8 characters, no spaces (e.g. NEUR).')
  db.transaction((tx) => {
    const cat: Partial<typeof t.categories.$inferInsert> = {}
    if (patch.name !== undefined) cat.name = patch.name.trim()
    if (patch.shortLabel !== undefined) cat.shortLabel = patch.shortLabel.trim().toUpperCase()
    if (patch.colour !== undefined) cat.colour = patch.colour
    if (Object.keys(cat).length)
      tx.update(t.categories).set(cat).where(eq(t.categories.id, mod.categoryId)).run()
    const m: Partial<typeof t.modules.$inferInsert> = {}
    if (patch.writeUpMinutes !== undefined) m.writeUpMinutes = patch.writeUpMinutes
    if (patch.folderPath !== undefined) m.folderPath = patch.folderPath || null
    if (patch.assessmentNotes !== undefined) m.assessmentNotes = patch.assessmentNotes || null
    if (patch.autoOrganise !== undefined) m.autoOrganise = !!patch.autoOrganise
    if (patch.timetabledSessions !== undefined) m.timetabledSessions = !!patch.timetabledSessions
    if (patch.forumNotifications !== undefined) {
      m.forumNotifications = !!patch.forumNotifications
      // Back on: start the forums afresh, so posts from while it was off don't all arrive.
      if (m.forumNotifications && !mod.forumNotifications) resetModuleForums(tx, id)
    }
    if (Object.keys(m).length) tx.update(t.modules).set(m).where(eq(t.modules.id, id)).run()
    // Titles use the label; listing practicals and workshops adds or removes their rows.
    if (patch.shortLabel !== undefined || patch.timetabledSessions !== undefined)
      reconcileTimetable(tx, now)
    logChange(tx, {
      actor: 'user',
      action: 'module.update',
      entityType: 'module',
      entityId: id,
      after: patch
    })
  })
}

export function lastImport(db: DbOrTx): ImportSummary | null {
  const row = db
    .select()
    .from(t.settings)
    .where(inArray(t.settings.key, ['timetableLastImport']))
    .get()
  return (row?.value as ImportSummary | undefined) ?? null
}

/** Tick (or untick) "flashcards made" for a lecture. */
export function setFlashcards(
  db: Db,
  lectureId: string,
  done: boolean,
  now: Temporal.Instant
): void {
  markLecture(db, lectureId, 'flashcardsAt', done, now)
}

/** Tick (or untick) "notes made" for a lecture. */
export function setNotes(db: Db, lectureId: string, done: boolean, now: Temporal.Instant): void {
  markLecture(db, lectureId, 'notesAt', done, now)
}

function markLecture(
  db: Db,
  lectureId: string,
  field: 'flashcardsAt' | 'notesAt',
  done: boolean,
  now: Temporal.Instant
): void {
  const lecture = db.select().from(t.lectures).where(eq(t.lectures.id, lectureId)).get()
  if (!lecture) throw new Error('Lecture not found.')
  db.update(t.lectures)
    .set({ [field]: done ? (lecture[field] ?? toIso(now)) : null })
    .where(eq(t.lectures.id, lectureId))
    .run()
  const what = field === 'notesAt' ? 'Notes' : 'Flashcards'
  logChange(db, {
    actor: 'user',
    action: done ? `lecture.${what.toLowerCase()}` : `lecture.no${what}`,
    entityType: 'lecture',
    entityId: lectureId
  })
}
