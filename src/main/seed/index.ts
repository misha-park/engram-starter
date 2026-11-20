import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import type {
  Block,
  RecurrenceRule,
  ReviewRating,
  SectionStatus,
  SeedSummary,
  Session
} from '../../shared/types'
import { nextDue, REVIEW_STEPS } from '../../core/reviews'
import { parseTimetable } from '../../core/ics'
import { firstFit } from '../../core/scheduler'
import { occurrenceDates, occurrenceRange } from '../../core/recurrence'
import {
  atLocalTime,
  localRange,
  minutesBetween,
  startOfWeek,
  toIso,
  todayLocalDate,
  zoned
} from '../../core/time'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { assertDemo, type ProfilePaths } from '../profile'
import { importTimetable } from '../timetable'
import * as assignments from '../assignments'
import { placeReview } from '../reviews'
import * as diss from '../dissertation'
import { addFiles } from '../attachments'
import zoteroDemo from '../../../resources/fixtures/zotero-demo.json'
import moodleDemo from '../../../resources/fixtures/moodle-demo.json'
import { isReadable, type ZoteroItemJson } from '../zotero'
import {
  DEMO_ASSIGNMENTS,
  DEMO_CATEGORIES,
  DEMO_SETTINGS,
  DEMO_TODOS,
  DEMO_TOT_DOT,
  DEMO_ESSAY_BRIEF,
  DEMO_SAMPLE_BRIEF,
  PUB_SHIFT,
  PUB_SHIFT_WEEKS,
  SOCIAL_SLOT,
  TEACHING_WEEKS
} from './demo-data'
import { buildDemoTimetableIcs } from './demo-timetable'

export const DEMO_TIMETABLE_SOURCE = 'Demo timetable (fake feed)'

/**
 * Fill an empty demo database. Deterministic for a given `now`; every date is relative to
 * the week containing `now`, so the demo never goes stale.
 *
 * Order matters, and mirrors real use: setup (modules, feed-name mapping, availability,
 * pub shift and other commitments) → timetable import (which places write-ups) → history
 * (outcomes, sessions, debriefs) → todos.
 */
export function seedDemo(db: Db, paths: ProfilePaths, now: Temporal.Instant): SeedSummary {
  assertDemo(paths)
  const thisMonday = startOfWeek(now).toPlainDate()
  const today = todayLocalDate(now)
  const nowIso = toIso(now)

  // --- 1. Setup: modules, mapping, settings, recurring and personal commitments ------------
  db.transaction((tx) => {
    DEMO_CATEGORIES.forEach((c, i) => {
      tx.insert(t.categories)
        .values({
          id: c.id,
          kind: c.kind,
          name: c.name,
          shortLabel: c.shortLabel,
          colour: c.colour,
          sortOrder: i
        })
        .run()
      if (c.kind === 'module') {
        tx.insert(t.modules)
          .values({
            id: c.id,
            categoryId: c.id,
            writeUpMinutes: c.writeUpMinutes ?? 60,
            assessmentNotes: c.assessmentNotes ?? null
          })
          .run()
        for (const feedName of c.feedNames ?? []) {
          tx.insert(t.moduleAliases).values({ moduleId: c.id, feedName }).run()
        }
      }
    })
    for (const [key, value] of Object.entries({ ...DEMO_SETTINGS, seededAt: nowIso })) {
      tx.insert(t.settings).values({ key, value }).run()
    }

    // Recurring pub shift (the same occurrence logic the app uses to extend series).
    const pubStartsOn = thisMonday
      .add({ weeks: PUB_SHIFT_WEEKS.from })
      .add({ days: PUB_SHIFT.weekday - 1 })
    const pubRule: RecurrenceRule = {
      freq: 'weekly',
      byWeekday: [PUB_SHIFT.weekday],
      startTime: PUB_SHIFT.start,
      endTime: PUB_SHIFT.end
    }
    tx.insert(t.recurrences)
      .values({
        id: PUB_SHIFT.id,
        title: PUB_SHIFT.title,
        kind: 'fixed',
        type: 'pub-shift',
        categoryId: 'work',
        rule: pubRule,
        startsOn: pubStartsOn.toString()
      })
      .run()
    for (const date of occurrenceDates(pubRule, {
      startsOn: pubStartsOn.toString(),
      from: pubStartsOn,
      to: thisMonday.add({ weeks: PUB_SHIFT_WEEKS.to + 1 }).subtract({ days: 1 })
    })) {
      const { start, end } = occurrenceRange(pubRule, date)
      tx.insert(t.blocks)
        .values({
          id: `${PUB_SHIFT.id}-${date}`,
          kind: 'fixed',
          type: 'pub-shift',
          title: PUB_SHIFT.title,
          start: toIso(start),
          end: toIso(end),
          categoryId: 'work',
          source: 'user',
          recurrenceId: PUB_SHIFT.id,
          occurrenceDate: date.toString()
        })
        .run()
    }

    for (let w = TEACHING_WEEKS.from; w <= TEACHING_WEEKS.to; w++) {
      const date = thisMonday.add({ weeks: w }).add({ days: SOCIAL_SLOT.weekday - 1 })
      const r = localRange(date, SOCIAL_SLOT.start, SOCIAL_SLOT.end)
      tx.insert(t.blocks)
        .values({
          id: `social-${date}`,
          kind: 'fixed',
          type: 'social',
          title: SOCIAL_SLOT.title,
          start: toIso(r.start),
          end: toIso(r.end),
          categoryId: 'social',
          source: 'user'
        })
        .run()
    }
  })

  // --- 2. Timetable: generate the fake UCL feed and import it like a real one ----------------
  const parsed = parseTimetable(buildDemoTimetableIcs(now), {
    from: new Date(now.subtract({ hours: 24 * 7 * 10 }).epochMilliseconds),
    to: new Date(now.add({ hours: 24 * 7 * 10 }).epochMilliseconds)
  })
  importTimetable(db, parsed.events, now, {
    source: DEMO_TIMETABLE_SOURCE,
    skipped: parsed.skipped.length
  })

  // --- 3. History: outcomes and sessions for write-ups that have already happened ------------
  // Deterministic mix: mostly done, every 4th partial, every 6th skipped. The most recent past
  // write-up is a timed-out timer awaiting a check-in; the most recent partial awaits a debrief.
  db.transaction((tx) => {
    const pastWriteUps = tx
      .select()
      .from(t.blocks)
      .where(and(eq(t.blocks.type, 'write-up'), lt(t.blocks.end, nowIso)))
      .all()
      .sort((a, b) => a.start.localeCompare(b.start))
    const sessions: Omit<Session, 'note' | 'plannedEnd' | 'promptedAt'>[] = []
    let n = 1
    const sessionId = () => `s${String(n++).padStart(4, '0')}`
    const outcomes = new Map<string, Block['outcome']>()

    pastWriteUps.forEach((b, i) => {
      const planned = minutesBetween(b.start, b.end)
      const link = { linkedType: b.linkedType, linkedId: b.linkedId }
      if (i === pastWriteUps.length - 1) {
        sessions.push({
          id: sessionId(),
          blockId: b.id,
          start: b.start,
          end: b.end,
          minutes: planned,
          manual: false,
          ...link,
          outcome: null,
          debrief: null,
          checkinPending: true
        })
        return
      }
      const outcome = i % 6 === 5 ? 'skipped' : i % 4 === 3 ? 'partial' : 'done'
      outcomes.set(b.id, outcome)
      if (outcome === 'skipped') return
      const minutes = outcome === 'partial' ? Math.round(planned / 2) : planned + ((i % 3) - 1) * 10
      sessions.push({
        id: sessionId(),
        blockId: b.id,
        start: b.start,
        end: toIso(Temporal.Instant.from(b.start).add({ minutes })),
        minutes,
        manual: false,
        ...link,
        outcome,
        debrief:
          outcome === 'partial'
            ? 'Covered the first half of the slides. Left: the second half and the figure on page 12.'
            : null,
        checkinPending: false
      })
    })

    const latestPartial = [...pastWriteUps].reverse().find((b) => outcomes.get(b.id) === 'partial')
    for (const [id, outcome] of outcomes) {
      tx.update(t.blocks)
        .set({ outcome, debriefPending: id === latestPartial?.id })
        .where(eq(t.blocks.id, id))
        .run()
    }
    const pendingSession = sessions.find((s) => s.blockId === latestPartial?.id)
    if (pendingSession) pendingSession.debrief = null

    // One manual session (time spent outside a block) earlier this week, if the week has started.
    const manual = localRange(thisMonday, '19:00', '20:00')
    if (Temporal.PlainDate.compare(today, thisMonday) > 0) {
      sessions.push({
        id: sessionId(),
        blockId: null,
        start: toIso(manual.start),
        end: toIso(manual.end),
        minutes: 60,
        manual: true,
        linkedType: 'module',
        linkedId: 'neur',
        outcome: 'done',
        debrief: null,
        checkinPending: false
      })
    }
    for (const s of sessions) tx.insert(t.sessions).values(s).run()
  })

  // --- 4. Assignments, back-scheduled around everything above ------------------------------
  seedAssignments(db, now)

  // --- 5. A flexible block later today, and todos -------------------------------------------
  db.transaction((tx) => {
    // First free whole hour before 22:00, so "remaining today"
    // and timers have something to show.
    const dayEnd = toIso(localRange(today, '00:00', '00:00').end)
    const todays = tx
      .select({ start: t.blocks.start, end: t.blocks.end })
      .from(t.blocks)
      .where(and(lt(t.blocks.start, dayEnd), gt(t.blocks.end, nowIso)))
      .all()
    for (let hour = zoned(now).hour + 1; hour < 22; hour++) {
      const r = localRange(
        today,
        `${String(hour).padStart(2, '0')}:00`,
        `${String(hour + 1).padStart(2, '0')}:00`
      )
      const [s, e] = [toIso(r.start), toIso(r.end)]
      if (!todays.some((b) => b.start < e && b.end > s)) {
        tx.insert(t.blocks)
          .values({
            id: 'problem-sheet',
            kind: 'flexible',
            type: 'other',
            title: 'PHYS problem sheet',
            start: s,
            end: e,
            categoryId: 'phys',
            source: 'user'
          })
          .run()
        break
      }
    }

    // Todos --------------------------------------------------------------------------
    DEMO_TODOS.forEach((d, i) => {
      let dueDate = d.due === undefined ? null : today.add({ days: d.due }).toString()
      if (d.weeklyOn)
        dueDate = today.add({ days: (d.weeklyOn - today.dayOfWeek + 7) % 7 }).toString()
      tx.insert(t.todos)
        .values({
          id: `t${String(i + 1).padStart(3, '0')}`,
          title: d.title,
          done: d.done ?? false,
          dueDate,
          linkedType: d.categoryId ? 'module' : null,
          linkedId: d.categoryId ?? null,
          recurrence: d.weeklyOn ? { freq: 'weekly', byWeekday: [d.weeklyOn] } : null,
          source: 'app',
          doneAt: d.done ? nowIso : null
        })
        .run()
    })
  })

  // --- 6. Spaced-repetition history for the lectures already written up -------------------
  seedReviews(db, now)

  // --- 7. The dissertation: plan, timeline, reading list, a meeting and sessions ----------
  seedDissertation(db, now)

  // --- 8. The demo's stand-in for Tot's UNI dot (a text file; the first sync merges it) ----
  writeFileSync(paths.totDemoFile, DEMO_TOT_DOT)

  // --- 9. Files: a brief on the essay, and a sample brief to try "Plan from brief" ----------
  seedFiles(db, paths)

  // --- 10. Moodle forums, as if first synced 3 days ago: the newer fixture posts notify ----
  seedForums(db, now)

  const count = (table: typeof t.blocks | typeof t.sessions | typeof t.todos) =>
    db.select().from(table).all().length
  return {
    categories: DEMO_CATEGORIES.length,
    modules: DEMO_CATEGORIES.filter((c) => c.kind === 'module').length,
    blocks: count(t.blocks),
    sessions: count(t.sessions),
    todos: count(t.todos)
  }
}

/**
 * Three assignments at different stages: one under way (first stage done, with past work
 * logged), one not started and due soon, and one already submitted.
 */
function seedAssignments(db: Db, now: Temporal.Instant): void {
  const today = todayLocalDate(now)
  for (const d of DEMO_ASSIGNMENTS) {
    const due = toIso(localRange(today.add({ days: d.dueInDays }), d.dueTime, d.dueTime).start)
    // Past-due assignments are created as if set before they were due.
    const createdAt =
      d.dueInDays < 0 ? Temporal.Instant.from(due).subtract({ hours: 24 * 21 }) : now
    const id = assignments.createAssignment(
      db,
      {
        moduleId: d.moduleId,
        title: d.title,
        due,
        type: d.type,
        weighting: d.weighting,
        wordLimit: d.wordLimit ?? null,
        estimateMinutes: d.estimateHours * 60
      },
      createdAt
    )
    const detail = assignments.getAssignment(db, id)!
    if (d.submitted) {
      // Replace the plan made at creation with what actually happened (below).
      const ids = detail.stages.flatMap((st) => st.blocks.map((b) => b.id))
      if (ids.length) db.delete(t.blocks).where(inArray(t.blocks.id, ids)).run()
    }
    const finishedStages = d.submitted ? detail.stages : detail.stages.slice(0, d.stagesDone)
    db.transaction((tx) => {
      finishedStages.forEach((stage, i) => {
        // Two past sessions of work on each finished stage, on consecutive evenings, each up to
        // half the stage's estimate (so finished work roughly matches the plan).
        const length = Math.min(90, Math.round(stage.estimateMinutes / 2 / 15) * 15)
        const base = Temporal.Instant.from(d.submitted ? due : toIso(now))
          .toZonedDateTimeISO('Europe/London')
          .toPlainDate()
          .subtract({ days: 2 * (finishedStages.length - i) + 5 })
        for (const [n, date] of [base, base.add({ days: 1 })].entries()) {
          // The first free 90 minutes that evening (or that day), like a real plan would be.
          const day = localRange(date, '00:00', '00:00')
          const busy = tx
            .select({ start: t.blocks.start, end: t.blocks.end })
            .from(t.blocks)
            .where(and(lt(t.blocks.start, toIso(day.end)), gt(t.blocks.end, toIso(day.start))))
            .all()
          const slot =
            firstFit(toIsoRange(localRange(date, '17:00', '22:00')), length, busy) ??
            firstFit(toIsoRange(localRange(date, '09:00', '22:00')), length, busy)
          if (!slot) continue
          const r = {
            start: Temporal.Instant.from(slot.start),
            end: Temporal.Instant.from(slot.end)
          }
          const blockId = `seed-${id.slice(0, 8)}-${i}-${n}`
          tx.insert(t.blocks)
            .values({
              id: blockId,
              kind: 'flexible',
              type: 'assignment-stage',
              title: `${stage.name} · ${d.title}`,
              start: toIso(r.start),
              end: toIso(r.end),
              categoryId: d.moduleId,
              linkedType: 'assignment-stage',
              linkedId: stage.id,
              source: 'auto',
              outcome: 'done'
            })
            .run()
          tx.insert(t.sessions)
            .values({
              id: `seed-s-${id.slice(0, 8)}-${i}-${n}`,
              blockId,
              start: toIso(r.start),
              end: toIso(r.end),
              minutes: length,
              linkedType: 'assignment-stage',
              linkedId: stage.id,
              outcome: 'done'
            })
            .run()
        }
        tx.update(t.assignmentStages)
          .set({ doneAt: toIso(now) })
          .where(eq(t.assignmentStages.id, stage.id))
          .run()
      })
      if (d.submitted) {
        tx.update(t.assignments)
          .set({ submittedAt: toIso(Temporal.Instant.from(due).subtract({ hours: 20 })) })
          .where(eq(t.assignments.id, id))
          .run()
      }
    })
    assignments.rescheduleAssignment(db, id, now)
  }
}

const toIsoRange = (r: { start: Temporal.ZonedDateTime; end: Temporal.ZonedDateTime }) => ({
  start: toIso(r.start),
  end: toIso(r.end)
})

/**
 * Review history for written-up lectures: past reviews done with a mix of ratings, then the
 * next one open (planned through the scheduler). One recent review was missed and not planned
 * again, so the Revision tab has something overdue to show.
 */
function seedReviews(db: Db, now: Temporal.Instant): void {
  const today = todayLocalDate(now)
  const RATINGS: ReviewRating[] = ['ok', 'easy', 'hard', 'ok', 'easy']
  const written = db
    .select({ lectureId: t.lectures.id, end: t.blocks.end })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.writeUpBlockId, t.blocks.id))
    .where(eq(t.blocks.outcome, 'done'))
    .orderBy(asc(t.blocks.end))
    .all()
  written.forEach((w, i) => {
    let finishedOn = zoned(w.end).toPlainDate()
    let previous: ReviewRating | null = null
    for (let step = 1; step <= REVIEW_STEPS; step++) {
      const due = nextDue(finishedOn, step, previous)!
      const id = `rv-${w.lectureId}-${step}`
      const past = Temporal.PlainDate.compare(due, today) < 0
      // Only one recent review was missed; everything older was done.
      const missed = past && i === written.length - 3 && today.since(due).days <= 7
      if (past && !missed) {
        const rating = RATINGS[(i + step) % RATINGS.length]
        db.insert(t.reviews)
          .values({
            id,
            lectureId: w.lectureId,
            step,
            due: due.toString(),
            rating,
            doneAt: toIso(atLocalTime(due, '18:00'))
          })
          .run()
        finishedOn = due
        previous = rating
        continue
      }
      db.insert(t.reviews).values({ id, lectureId: w.lectureId, step, due: due.toString() }).run()
      // A missed review stays unplanned; the rest get a block from the scheduler.
      if (!past) placeReview(db, id, now)
      break
    }
  })
}

/**
 * A fictional literature-review dissertation in the Research Project module: sections at
 * different stages, milestones around today, the fixture reading list with statuses, a past
 * supervisor meeting with action items, one logged session and one coming up.
 */
function seedDissertation(db: Db, now: Temporal.Instant): void {
  const today = todayLocalDate(now)
  const monday = startOfWeek(now).toPlainDate()
  const submission = monday.add({ weeks: 18, days: 3 }) // a Thursday
  diss.updateSettings(db, {
    title: 'Microglia and synaptic pruning in development: a literature review',
    moduleId: 'proj',
    submissionDue: toIso(atLocalTime(submission, '12:00')),
    vivaDate: submission.add({ days: 19 }).toString(),
    vivaTime: '10:30',
    wordTarget: 8000,
    startedOn: monday.subtract({ weeks: 6 }).toString(),
    zoteroCollectionKey: 'DEMOLITR',
    zoteroCollectionName: 'Literature project / Microglia and pruning'
  })

  const sections: [string, SectionStatus, number | null, number][] = [
    ['Introduction', 'drafting', 450, 1000],
    ['Search strategy and methods', 'drafted', 620, 800],
    ['Microglia: origins and functions', 'reading', null, 1500],
    ['Synaptic pruning in development', 'reading', 150, 2000],
    ['Mechanisms: complement and fractalkine', 'not-started', null, 1500],
    ['Discussion', 'not-started', null, 1000],
    ['Conclusion', 'not-started', null, 200]
  ]
  const ids = sections.map(([title, status, words, target]) => {
    const id = diss.addSection(db, title, target)
    diss.updateSection(db, id, { status, wordCount: words })
    return id
  })

  const milestones: [string, number, boolean][] = [
    ['Proposal approved', -35, true],
    ['Literature search complete', -6, true],
    ['Methods section drafted', 5, false],
    ['Full first draft', 62, false],
    ['Draft to supervisor', 76, false],
    ['Final edits and formatting', 112, false]
  ]
  for (const [title, days, done] of milestones) {
    const id = diss.addMilestone(db, title, today.add({ days }).toString())
    if (done) diss.updateMilestone(db, id, { done: true }, now)
  }

  const items = (zoteroDemo.items as Record<string, ZoteroItemJson[]>).DEMOLITR.filter(isReadable)
  diss.syncReading(db, items, now)
  const links: Record<number, number[]> = {
    0: [2, 3],
    1: [4],
    2: [4],
    3: [3],
    4: [1],
    5: [5],
    6: [4],
    7: [0, 2],
    8: [5],
    9: [4, 5],
    10: [1],
    11: [5]
  }
  items.forEach((item, i) => {
    diss.updateReading(db, item.key, {
      status: i < 4 ? 'notes-done' : i < 7 ? 'read' : 'to-read',
      sectionIds: (links[i] ?? []).map((n) => ids[n])
    })
  })

  // A supervisor meeting ten days ago; the first action item is already done.
  const meetingAt = toIso(atLocalTime(today.subtract({ days: 10 }), '14:00'))
  const meetingId = diss.saveMeeting(db, {
    at: meetingAt,
    notes:
      'Happy with the scope. Narrow the review to development (not ageing). Search strategy needs to be written up so it can be repeated. Next meeting once the methods section is drafted.',
    actions: [
      'Send search strategy to supervisor',
      'Add a flow diagram of included papers to the methods',
      'Book the next meeting for early December'
    ]
  })
  const first = db
    .select()
    .from(t.meetingActions)
    .where(eq(t.meetingActions.meetingId, meetingId))
    .all()
    .find((a) => a.position === 0)
  if (first?.todoId) {
    db.update(t.todos)
      .set({ done: true, doneAt: toIso(now) })
      .where(eq(t.todos.id, first.todoId))
      .run()
  }

  // One session done last week (logged), one planned in two days, both in free time.
  const freeOn = (day: Temporal.PlainDate) =>
    firstFit(
      { start: toIso(atLocalTime(day, '09:00')), end: toIso(atLocalTime(day, '18:00')) },
      90,
      db.select({ start: t.blocks.start, end: t.blocks.end }).from(t.blocks).all()
    )
  const pastSlot = freeOn(today.subtract({ days: 5 }))!
  const pastStart = Temporal.Instant.from(pastSlot.start)
  const pastId = diss.scheduleSession(db, ids[1], { minutes: 90, start: pastSlot.start }, now)
  db.update(t.blocks).set({ outcome: 'done' }).where(eq(t.blocks.id, pastId)).run()
  db.insert(t.sessions)
    .values({
      id: `diss-session-1`,
      blockId: pastId,
      start: toIso(pastStart),
      end: toIso(pastStart.add({ minutes: 85 })),
      minutes: 85,
      linkedType: 'dissertation-section',
      linkedId: ids[1],
      outcome: 'done'
    })
    .run()
  const free = freeOn(today.add({ days: 2 }))
  if (free) diss.scheduleSession(db, ids[0], { minutes: 90, start: free.start }, now)
}

/** Where the demo keeps the sample files to drop into the app. */
export const sampleFilesDir = (paths: ProfilePaths) => join(paths.dir, 'sample-files')

function seedForums(db: Db, now: Temporal.Instant): void {
  const baseline = Math.floor(now.subtract({ hours: 72 }).epochMilliseconds / 1000)
  const courses = moodleDemo.courses as {
    id: number
    forums?: { id: number; type: string; name: string }[]
  }[]
  for (const c of courses)
    for (const f of c.forums ?? [])
      db.insert(t.moodleForums)
        .values({
          id: f.id,
          courseId: c.id,
          type: f.type,
          name: f.name,
          baseline,
          seenUntil: baseline
        })
        .run()
}

function seedFiles(db: Db, paths: ProfilePaths): void {
  const samples = sampleFilesDir(paths)
  rmSync(samples, { recursive: true, force: true })
  mkdirSync(samples, { recursive: true })
  const essay = db
    .select()
    .from(t.assignments)
    .where(eq(t.assignments.title, 'Ion channels essay'))
    .get()
  const briefPath = join(samples, 'NEUR0017 essay brief.txt')
  writeFileSync(briefPath, DEMO_ESSAY_BRIEF)
  if (essay) addFiles(db, paths.filesDir, [briefPath], { type: 'assignment', id: essay.id })
  writeFileSync(join(samples, 'PHAR0003 coursework 2 brief.txt'), DEMO_SAMPLE_BRIEF)
}
