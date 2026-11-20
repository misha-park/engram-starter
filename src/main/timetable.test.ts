import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTimetable, type TimetableEvent } from '../core/ics'
import { lectureStatus, writeUpMinutesFor } from '../core/lectures'
import { writeUpLimit } from '../core/scheduler'
import { minutesBetween, toIso } from '../core/time'
import { AppContext } from './app-context'
import * as bl from './backlog'
import * as cal from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import * as repo from './repo'
import { buildDemoTimetableIcs } from './seed/demo-timetable'
import * as tt from './timetable'
import { ChangeTracker, revertChanges } from './assistant/changes'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z') // Wednesday 14:00

const contexts: AppContext[] = []
function seeded(): Db {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-tt-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const feed = (): TimetableEvent[] =>
  parseTimetable(buildDemoTimetableIcs(NOW), {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2027-03-01T00:00:00Z')
  }).events
const blocks = (db: Db) => db.select().from(t.blocks).all()
const lectures = (db: Db) => db.select().from(t.lectures).all()
const later = (iso: string, hours: number) => toIso(Temporal.Instant.from(iso).add({ hours }))
const reimport = (db: Db, events = feed(), now = NOW) =>
  tt.importTimetable(db, events, now, { source: 'test' })

describe('importing the fake UCL feed (via the demo seed)', () => {
  it('creates numbered lectures per module', () => {
    const db = seeded()
    const ls = lectures(db)
    const count = (m: string) => ls.filter((l) => l.moduleId === m).length
    expect([count('neur'), count('phys'), count('phar'), count('proj')]).toEqual([12, 12, 12, 0])
    const neur = ls.filter((l) => l.moduleId === 'neur').sort((a, b) => a.number - b.number)
    const titles = neur.map((l) => blocks(db).find((b) => b.id === l.blockId)!.title)
    expect(titles[0]).toBe('NEUR L1')
    expect(titles[11]).toBe('NEUR L12')
    const starts = neur.map((l) => blocks(db).find((b) => b.id === l.blockId)!.start)
    expect([...starts].sort()).toEqual(starts)
  })

  it('places every write-up after its lecture, within 3 working days, without overlaps', () => {
    const db = seeded()
    const all = blocks(db)
    for (const l of lectures(db)) {
      const lecture = all.find((b) => b.id === l.blockId)!
      const wu = all.find((b) => b.id === l.writeUpBlockId)
      expect(wu, `write-up for ${lecture.title}`).toBeDefined()
      expect(wu!.start >= lecture.end).toBe(true)
      const limit = toIso(writeUpLimit(lecture.end))
      expect(wu!.end <= limit).toBe(true)
      expect(wu!.title).toBe(`${lecture.title} write-up`)
      expect(wu!.linkedId).toBe(l.id)
      const clash = all.find((b) => b.id !== wu!.id && b.start < wu!.end && b.end > wu!.start)
      expect(clash, `${wu!.title} overlaps ${clash?.title}`).toBeUndefined()
    }
  })

  it('never places a write-up in the past while its window is still open', () => {
    const db = seeded()
    const all = blocks(db)
    for (const l of lectures(db)) {
      const lecture = all.find((b) => b.id === l.blockId)!
      const wu = all.find((b) => b.id === l.writeUpBlockId)!
      const windowOpen = lecture.end <= toIso(NOW) && wu.start > lecture.end && wu.end > toIso(NOW)
      if (windowOpen) expect(wu.start >= toIso(NOW)).toBe(true)
    }
  })

  it('merges the cross-listed PBL (3 feed names) into one block per week', () => {
    const db = seeded()
    const pbl = blocks(db).filter((b) => b.type === 'pbl')
    expect(pbl).toHaveLength(6)
    expect(pbl.every((b) => b.categoryId === 'proj' && b.title === 'PROJ PBL')).toBe(true)
    const events = db
      .select()
      .from(t.timetableEvents)
      .all()
      .filter((e) => e.feedType === 'Problem Based Learning')
    expect(events).toHaveLength(18)
    expect(new Set(events.map((e) => e.blockId)).size).toBe(6)
  })

  it('keeps unmapped names grey and lists them', () => {
    const db = seeded()
    const stats = blocks(db).filter((b) => b.title.startsWith('Statistics for Biosciences'))
    expect(stats.length).toBe(6)
    expect(stats.every((b) => b.categoryId === null)).toBe(true)
    expect(
      tt.listFeedNames(db).find((f) => f.name === 'Statistics for Biosciences')?.moduleId
    ).toBeNull()
    // Names with only hidden [None] events don't count as needing a mapping.
    expect(tt.lastImport(db)?.unmappedNames).toEqual(['Statistics for Biosciences'])
    const tutor = tt.listFeedNames(db).find((f) => f.name === 'Personal Tutor Drop-in')
    expect(tutor?.hiddenOnly).toBe(true)
  })

  it('stores [None] events but creates no blocks for them', () => {
    const db = seeded()
    expect(
      db
        .select()
        .from(t.timetableEvents)
        .where(eq(t.timetableEvents.moduleName, 'Personal Tutor Drop-in'))
        .all()
    ).toHaveLength(6)
    expect(blocks(db).some((b) => b.title.includes('Tutor'))).toBe(false)
  })

  it('turns Assessment events into deadlines, and viva sessions into a deadline but no block', () => {
    const db = seeded()
    expect(blocks(db).some((b) => b.type === 'viva')).toBe(false)
    const d = repo
      .listDeadlines(db, '2026-11-16T00:00:00Z', '2027-01-01T00:00:00Z')
      .filter((x) => x.kind !== 'dissertation')
      .filter((x) => x.kind !== 'assignment')
      .filter((x) => x.kind !== 'todo')
    expect(d.map((x) => [x.kind, x.title])).toEqual([
      ['assessment', 'Systems Physiology assessment'],
      ['viva', 'Research Project viva sessions']
    ])
  })
})

describe('re-importing', () => {
  it('is idempotent: the same feed changes nothing', () => {
    const db = seeded()
    const before = JSON.stringify(blocks(db).sort((a, b) => a.id.localeCompare(b.id)))
    const summary = reimport(db)
    expect([summary.added, summary.updated, summary.removed]).toEqual([0, 0, 0])
    expect(JSON.stringify(blocks(db).sort((a, b) => a.id.localeCompare(b.id)))).toBe(before)
  })

  it('follows a lecture that moved in the feed, re-placing its untouched write-up', () => {
    const db = seeded()
    const events = feed()
    const ev = events.find((e) => e.type === 'lecture' && e.start > '2026-11-26')!
    const lec = lectures(db).find(
      (l) => blocks(db).find((b) => b.id === l.blockId)!.start === ev.start
    )!
    ev.start = later(ev.start, 5)
    ev.end = later(ev.end, 5)
    const summary = reimport(db, events)
    expect(summary.updated).toBe(1)
    const lectureBlock = cal.getBlock(db, lec.blockId)!
    expect(lectureBlock.start).toBe(ev.start)
    const wu = cal.getBlock(db, lectures(db).find((l) => l.id === lec.id)!.writeUpBlockId!)!
    expect(wu.start >= ev.end).toBe(true)
  })

  it('never clobbers a write-up the user moved', () => {
    const db = seeded()
    const events = feed()
    const ev = events.find((e) => e.type === 'lecture' && e.start > '2026-11-26')!
    const lec = lectures(db).find(
      (l) => blocks(db).find((b) => b.id === l.blockId)!.start === ev.start
    )!
    const wu = cal.getBlock(db, lec.writeUpBlockId!)!
    const moved = cal.moveBlock(
      db,
      wu.id,
      wu.start.replace(/T\d\d/, 'T19'),
      wu.end.replace(/T\d\d/, 'T20')
    )
    ev.start = later(ev.start, 5)
    ev.end = later(ev.end, 5)
    reimport(db, events)
    const after = cal.getBlock(db, wu.id)!
    expect([after.start, after.end]).toEqual([moved.start, moved.end])
  })

  it('removes future events that left the feed (and their untouched write-ups), but keeps the past', () => {
    const db = seeded()
    const events = feed()
    const futureLecture = events.find((e) => e.type === 'lecture' && e.start > '2026-11-26')!
    const pastLecture = events.find((e) => e.type === 'lecture' && e.end < '2026-11-01')!
    const lec = lectures(db).find(
      (l) => blocks(db).find((b) => b.id === l.blockId)!.start === futureLecture.start
    )!
    const summary = reimport(
      db,
      events.filter((e) => e !== futureLecture && e !== pastLecture)
    )
    expect(summary.removed).toBe(1)
    expect(cal.getBlock(db, lec.blockId)).toBeUndefined()
    expect(cal.getBlock(db, lec.writeUpBlockId!)).toBeUndefined()
    expect(blocks(db).some((b) => b.start === pastLecture.start && b.type === 'lecture')).toBe(true)
  })
})

describe('module mapping', () => {
  it('mapping a name to a new module colours its blocks', () => {
    const db = seeded()
    const id = tt.createModule(
      db,
      {
        name: 'Statistics for Biosciences',
        shortLabel: 'stat',
        colour: '#5b8cff',
        feedName: 'Statistics for Biosciences'
      },
      NOW
    )
    const stats = blocks(db).filter((b) => b.title === 'STAT Workshop')
    expect(stats).toHaveLength(6)
    expect(stats.every((b) => b.categoryId === id)).toBe(true)
  })

  it('splitting and re-merging a cross-listed name', () => {
    const db = seeded()
    tt.assignFeedName(db, 'Neuroscience Research Project', null, NOW)
    expect(blocks(db).filter((b) => b.type === 'pbl')).toHaveLength(12) // merged + split-off copy
    tt.assignFeedName(db, 'Neuroscience Research Project', 'proj', NOW)
    expect(blocks(db).filter((b) => b.type === 'pbl')).toHaveLength(6)
  })

  it('unmapping a module drops its lectures and untouched write-ups but keeps finished work', () => {
    const db = seeded()
    const physLectures = lectures(db).filter((l) => l.moduleId === 'phys')
    const doneWriteUp = blocks(db).find(
      (b) => b.type === 'write-up' && b.categoryId === 'phys' && b.outcome === 'done'
    )!
    tt.assignFeedName(db, 'Systems Physiology', null, NOW)
    expect(lectures(db).filter((l) => l.moduleId === 'phys')).toHaveLength(0)
    expect(cal.getBlock(db, physLectures[0].blockId)!.categoryId).toBeNull() // the event stays, grey
    expect(cal.getBlock(db, doneWriteUp.id)!.attention).toMatch(/removed/)
    const untouched = physLectures
      .map((l) => l.writeUpBlockId)
      .filter((id) => id && id !== doneWriteUp.id)
    expect(untouched.some((id) => cal.getBlock(db, id!)?.outcome === 'none')).toBe(false)

    tt.assignFeedName(db, 'Systems Physiology', 'phys', NOW)
    expect(lectures(db).filter((l) => l.moduleId === 'phys')).toHaveLength(12)
    // The finished write-up is re-adopted by its lecture, not duplicated.
    const readopted = cal.getBlock(db, doneWriteUp.id)!
    expect(readopted.attention).toBeNull()
    expect(lectures(db).some((l) => l.writeUpBlockId === doneWriteUp.id)).toBe(true)
    expect(blocks(db).filter((b) => b.title === doneWriteUp.title)).toHaveLength(1)
  })

  it('updates module settings and retitles on a label change', () => {
    const db = seeded()
    tt.updateModule(db, 'neur', { shortLabel: 'neuro', writeUpMinutes: 60 }, NOW)
    expect(blocks(db).some((b) => b.title === 'NEURO L1')).toBe(true)
    expect(blocks(db).some((b) => b.title === 'NEURO L1 write-up')).toBe(true)
    expect(() => tt.updateModule(db, 'neur', { writeUpMinutes: 5 }, NOW)).toThrow(/between/)
  })
})

it('lectureStatus', () => {
  const end = '2026-11-18T11:00:00Z'
  expect(lectureStatus(end, null, Temporal.Instant.from('2026-11-18T10:00:00Z'))).toBe('scheduled')
  expect(lectureStatus(end, 'none', NOW)).toBe('attended')
  expect(lectureStatus(end, 'done', NOW)).toBe('written-up')
})

describe('write-up length scales with the lecture', () => {
  it('gives an hour of write-up per hour of lecture by default', () => {
    const db = seeded()
    for (const l of lectures(db)) {
      const lecture = blocks(db).find((b) => b.id === l.blockId)!
      const wu = blocks(db).find((b) => b.id === l.writeUpBlockId)
      if (!wu || wu.detached) continue
      const lectureMinutes = (Date.parse(lecture.end) - Date.parse(lecture.start)) / 60000
      expect((Date.parse(wu.end) - Date.parse(wu.start)) / 60000).toBe(lectureMinutes)
    }
    // The demo has 2-hour lectures too.
    expect(
      lectures(db).some((l) => {
        const b = blocks(db).find((x) => x.id === l.blockId)!
        return Date.parse(b.end) - Date.parse(b.start) === 2 * 3600_000
      })
    ).toBe(true)
  })

  it('writeUpMinutesFor rounds to quarter hours', () => {
    expect(writeUpMinutesFor(60, 60)).toBe(60)
    expect(writeUpMinutesFor(120, 60)).toBe(120)
    expect(writeUpMinutesFor(120, 45)).toBe(90)
    expect(writeUpMinutesFor(50, 60)).toBe(45)
    expect(writeUpMinutesFor(10, 30)).toBe(15)
  })

  it('flashcards can be ticked and unticked per lecture', () => {
    const db = seeded()
    const l = lectures(db)[0]
    tt.setFlashcards(db, l.id, true, NOW)
    expect(
      repo.getModuleDetail(db, l.moduleId, NOW)!.lectures.find((x) => x.id === l.id)!.flashcards
    ).toBe(true)
    tt.setFlashcards(db, l.id, false, NOW)
    expect(
      repo.getModuleDetail(db, l.moduleId, NOW)!.lectures.find((x) => x.id === l.id)!.flashcards
    ).toBe(false)
  })

  it('notes made can be ticked and unticked per lecture, apart from flashcards', () => {
    const db = seeded()
    const l = lectures(db)[0]
    const get = () =>
      repo.getModuleDetail(db, l.moduleId, NOW)!.lectures.find((x) => x.id === l.id)!
    tt.setNotes(db, l.id, true, NOW)
    expect(get().notes).toBe(true)
    expect(get().flashcards).toBe(false)
    tt.setNotes(db, l.id, false, NOW)
    expect(get().notes).toBe(false)
  })
})

describe('splitting a timetable event that is really two lectures', () => {
  /** The demo feed plus a 2-hour NEUR lecture on Fri 27 Nov, 11:00–13:00. */
  const twoHourFeed = () => {
    const events = feed()
    const name = events.find((e) => e.type === 'lecture')!.moduleName
    const base = { moduleName: name, level: 6, feedType: 'Lecture', type: 'lecture' as const }
    events.push({
      ...base,
      uid: 'long-1',
      start: '2026-11-27T11:00:00Z',
      end: '2026-11-27T13:00:00Z'
    })
    return events
  }
  const lectureAt = (db: Db, start: string) =>
    lectures(db).find((l) => blocks(db).find((b) => b.id === l.blockId)!.start === start)
  const minutesOf = (db: Db, blockId: string) => {
    const b = cal.getBlock(db, blockId)!
    return Temporal.Instant.from(b.start).until(Temporal.Instant.from(b.end)).total('minutes')
  }

  it('makes each part its own lecture with its own write-up, and joins them again', () => {
    const db = seeded()
    const events = twoHourFeed()
    reimport(db, events)
    const long = lectureAt(db, '2026-11-27T11:00:00Z')!
    const module = long.moduleId
    const perHour = db.select().from(t.modules).where(eq(t.modules.id, module)).get()!
      .writeUpMinutes
    const count = () => lectures(db).filter((l) => l.moduleId === module).length
    const before = count()
    const later = lectures(db).find((l) => l.moduleId === module && l.number === long.number + 1)!
    expect(minutesOf(db, long.writeUpBlockId!)).toBe(writeUpMinutesFor(120, perHour))

    tt.splitLecture(db, long.id, NOW)
    expect(count()).toBe(before + 1)
    const first = lectureAt(db, '2026-11-27T11:00:00Z')!
    const second = lectureAt(db, '2026-11-27T12:00:00Z')!
    // The first part keeps the lecture (and its block); the second is new, numbered next.
    expect(first.id).toBe(long.id)
    expect(second.number).toBe(first.number + 1)
    expect(cal.getBlock(db, first.blockId)!.end).toBe('2026-11-27T12:00:00Z')
    expect(cal.getBlock(db, second.blockId)!.end).toBe('2026-11-27T13:00:00Z')
    // Each has a write-up sized to its hour; later lectures moved down a number.
    expect(minutesOf(db, first.writeUpBlockId!)).toBe(writeUpMinutesFor(60, perHour))
    expect(minutesOf(db, second.writeUpBlockId!)).toBe(writeUpMinutesFor(60, perHour))
    expect(lectures(db).find((l) => l.id === later.id)!.number).toBe(later.number + 1)
    // Can't split a part again.
    expect(() => tt.splitLecture(db, first.id, NOW)).toThrow(/already split/)

    // Re-importing keeps the split; nothing changes.
    reimport(db, events)
    expect(count()).toBe(before + 1)
    expect(lectureAt(db, '2026-11-27T12:00:00Z')!.id).toBe(second.id)

    // Joining (from either part) makes it one lecture again.
    tt.joinLecture(db, second.id, NOW)
    expect(count()).toBe(before)
    const joined = lectureAt(db, '2026-11-27T11:00:00Z')!
    expect(joined.id).toBe(long.id)
    expect(cal.getBlock(db, joined.blockId)!.end).toBe('2026-11-27T13:00:00Z')
    expect(minutesOf(db, joined.writeUpBlockId!)).toBe(writeUpMinutesFor(120, perHour))
    expect(lectureAt(db, '2026-11-27T12:00:00Z')).toBeUndefined()
  })

  it('splits at given points, refuses parts that are too short, ignores a split that no longer fits', () => {
    const db = seeded()
    const events = twoHourFeed()
    reimport(db, events)
    const long = lectureAt(db, '2026-11-27T11:00:00Z')!
    expect(() => tt.splitLecture(db, long.id, NOW, [5])).toThrow(/at least 15 minutes/)
    tt.splitLecture(db, long.id, NOW, [45])
    expect(cal.getBlock(db, lectureAt(db, '2026-11-27T11:45:00Z')!.blockId)!.end).toBe(
      '2026-11-27T13:00:00Z'
    )
    // The feed shortens the event to 30 minutes: the 45-minute cut no longer fits.
    events.find((e) => e.uid === 'long-1')!.end = '2026-11-27T11:30:00Z'
    reimport(db, events)
    expect(lectureAt(db, '2026-11-27T11:45:00Z')).toBeUndefined()
    expect(cal.getBlock(db, lectureAt(db, '2026-11-27T11:00:00Z')!.blockId)!.end).toBe(
      '2026-11-27T11:30:00Z'
    )
  })
})

describe('the start date (first setup)', () => {
  it('leaves earlier lectures’ write-ups to the Backlog, and places them again when cleared', () => {
    const db = seeded()
    const start = '2026-11-16' // Monday of this week
    const before = (l: { blockId: string }) => cal.getBlock(db, l.blockId)!.start < '2026-11-16'
    const early = lectures(db).filter(before)
    expect(early.length).toBeGreaterThan(0)
    // As on a fresh import: nothing marked yet.
    for (const l of early)
      if (l.writeUpBlockId)
        db.update(t.blocks).set({ outcome: 'none' }).where(eq(t.blocks.id, l.writeUpBlockId)).run()
    // One earlier write-up the user moved by hand: it stays.
    const kept = early.find((l) => {
      const wu = l.writeUpBlockId ? cal.getBlock(db, l.writeUpBlockId) : null
      return wu && wu.outcome === 'none'
    })!
    db.update(t.blocks).set({ detached: true }).where(eq(t.blocks.id, kept.writeUpBlockId!)).run()
    const untouched = early.filter((l) => {
      const wu = l.writeUpBlockId ? cal.getBlock(db, l.writeUpBlockId) : null
      return wu && wu.source === 'auto' && !wu.detached && wu.outcome === 'none'
    })
    expect(untouched.length).toBeGreaterThan(0)

    tt.setStartDate(db, start, NOW)
    expect(tt.getStartDate(db)).toBe(start)
    for (const l of untouched) {
      expect(lectures(db).find((x) => x.id === l.id)!.writeUpBlockId).toBeNull()
      expect(cal.getBlock(db, l.writeUpBlockId!)).toBeUndefined()
    }
    expect(lectures(db).find((x) => x.id === kept.id)!.writeUpBlockId).toBe(kept.writeUpBlockId)
    // Later lectures keep theirs.
    const later = lectures(db).filter(
      (l) => !before(l) && cal.getBlock(db, l.blockId)!.end < toIso(NOW)
    )
    expect(later.every((l) => l.writeUpBlockId)).toBe(true)
    // They wait in the Backlog, marked as from before the start.
    const items = bl.listBacklog(db, NOW).filter((i) => i.kind === 'unscheduled-write-up')
    expect(items.length).toBeGreaterThanOrEqual(untouched.length)
    expect(items.every((i) => i.detail.includes('from before you started using Engram'))).toBe(true)
    // A re-import doesn't place them.
    reimport(db)
    expect(lectures(db).find((x) => x.id === untouched[0].id)!.writeUpBlockId).toBeNull()

    tt.setStartDate(db, null, NOW)
    expect(lectures(db).find((x) => x.id === untouched[0].id)!.writeUpBlockId).not.toBeNull()
  })
})

describe('deleting a timetabled event', () => {
  it('takes it (and its untouched write-up) off the calendar, keeps it off, and can bring it back', () => {
    const db = seeded()
    const module = lectures(db)[0].moduleId
    const own = () =>
      lectures(db)
        .filter((l) => l.moduleId === module)
        .sort((a, b) => a.number - b.number)
    const before = own()
    const target = before[before.length - 1] // a future lecture
    const block = cal.getBlock(db, target.blockId)!
    const writeUp = target.writeUpBlockId!

    expect(tt.hideTimetableBlock(db, block.id, NOW)).toBeGreaterThan(0)
    expect(cal.getBlock(db, block.id)).toBeUndefined()
    expect(cal.getBlock(db, writeUp)).toBeUndefined()
    expect(own()).toHaveLength(before.length - 1)
    expect(tt.hiddenTimetableCount(db)).toBeGreaterThan(0)

    // A later import keeps it off.
    reimport(db)
    expect(own()).toHaveLength(before.length - 1)
    expect(
      blocks(db).some(
        (b) =>
          b.start === block.start &&
          b.title.startsWith(block.title.split(' ')[0]) &&
          b.source === 'timetable' &&
          b.end === block.end &&
          b.categoryId === block.categoryId
      )
    ).toBe(false)

    // Listed one by one, and each can come back on its own.
    const listed = tt.listHiddenTimetable(db)
    expect(listed.length).toBe(tt.hiddenTimetableCount(db))
    expect(listed[0]).toMatchObject({ start: block.start, end: block.end })
    tt.restoreHiddenEvent(db, listed[0].uid, NOW)
    expect(own()).toHaveLength(before.length)

    tt.restoreHiddenTimetable(db, NOW)
    expect(own()).toHaveLength(before.length)
    expect(tt.hiddenTimetableCount(db)).toBe(0)
  })

  it('can be undone exactly, lecture details and write-up included', () => {
    const db = seeded()
    const target = lectures(db)
      .filter((l) => l.writeUpBlockId)
      .sort((a, b) => b.number - a.number)[0]
    tt.renameLecture(db, target.id, 'My own name')
    const block = cal.getBlock(db, target.blockId)!
    const tracker = new ChangeTracker(db)
    tracker.track(() => tt.hideTimetableBlock(db, block.id, NOW))
    expect(cal.getBlock(db, block.id)).toBeUndefined()
    revertChanges(db, tracker.all)
    expect(cal.getBlock(db, block.id)).toMatchObject({ start: block.start, end: block.end })
    expect(lectures(db).find((l) => l.id === target.id)).toMatchObject({
      title: 'My own name',
      writeUpBlockId: target.writeUpBlockId
    })
    expect(cal.getBlock(db, target.writeUpBlockId!)).toBeDefined()
    expect(tt.hiddenTimetableCount(db)).toBe(0)
    // And it stays back after the next import.
    reimport(db)
    expect(cal.getBlock(db, block.id)).toBeDefined()
  })

  it('refuses anything that isn’t from the timetable', () => {
    const db = seeded()
    const handMade = blocks(db).find((b) => b.source !== 'timetable')!
    expect(() => tt.hideTimetableBlock(db, handMade.id, NOW)).toThrow(/Not a timetabled event/)
  })
})

describe('attendance', () => {
  it('counts a past lecture as attended until it’s marked as missed', () => {
    const db = seeded()
    const past = repo
      .getModuleDetail(db, lectures(db)[0].moduleId, NOW)!
      .lectures.find((l) => l.status === 'attended')!
    tt.setAttended(db, past.id, false)
    const missed = repo
      .getModuleDetail(db, past.moduleId, NOW)!
      .lectures.find((l) => l.id === past.id)!
    expect(missed.status).toBe('missed')
    tt.setAttended(db, past.id, true)
    expect(
      repo.getModuleDetail(db, past.moduleId, NOW)!.lectures.find((l) => l.id === past.id)!.status
    ).toBe('attended')
    // A future lecture stays scheduled either way.
    expect(lectureStatus('2026-12-01T10:00:00Z', null, NOW, true)).toBe('scheduled')
    expect(lectureStatus('2026-11-01T10:00:00Z', 'done', NOW, true)).toBe('written-up')
  })
})

describe('one lecture across two sessions', () => {
  it('shares the number, gets one write-up after the last part, and separates again', () => {
    const db = seeded()
    const module = lectures(db)[0].moduleId
    const own = () =>
      lectures(db)
        .filter((l) => l.moduleId === module)
        .sort((a, b) =>
          cal.getBlock(db, a.blockId)!.start.localeCompare(cal.getBlock(db, b.blockId)!.start)
        )
    // Two future sessions, so their write-ups are Engram's own and untouched.
    const future = own().filter((l) => cal.getBlock(db, l.blockId)!.start > toIso(NOW))
    const [first, second] = future
    const before = own().length
    const perHour = db.select().from(t.modules).where(eq(t.modules.id, module)).get()!
      .writeUpMinutes
    const len = (id: string) => {
      const b = cal.getBlock(db, id)!
      return Temporal.Instant.from(b.start).until(Temporal.Instant.from(b.end)).total('minutes')
    }
    const total = len(first.blockId) + len(second.blockId)

    tt.combineLectures(db, second.id, first.id, NOW)
    const a = lectures(db).find((l) => l.id === first.id)!
    const b = lectures(db).find((l) => l.id === second.id)!
    expect(b.number).toBe(a.number)
    expect(cal.getBlock(db, b.blockId)!.title).toMatch(/· part 2$/)
    // Later lectures keep counting from the first part.
    const later = own().find(
      (l) => cal.getBlock(db, l.blockId)!.start > cal.getBlock(db, b.blockId)!.start
    )!
    expect(later.number).toBe(a.number + 1)
    // One write-up, after the second session, sized for both.
    expect(b.writeUpBlockId).toBeNull()
    const wu = cal.getBlock(db, a.writeUpBlockId!)!
    expect(wu.start >= cal.getBlock(db, b.blockId)!.end).toBe(true)
    expect(len(wu.id)).toBe(writeUpMinutesFor(total, perHour))
    expect(own()).toHaveLength(before)

    // It survives a re-import.
    reimport(db)
    expect(lectures(db).find((l) => l.id === second.id)!.number).toBe(a.number)

    tt.separateLecture(db, second.id, NOW)
    const back = lectures(db).find((l) => l.id === second.id)!
    expect(back.number).toBe(a.number + 1)
    expect(back.writeUpBlockId).not.toBeNull()
    expect(() => tt.combineLectures(db, first.id, second.id, NOW)).toThrow(/earlier lecture/)
  })

  it('merging after moving the write-ups by hand: one write-up, lengthened to cover both', () => {
    const db = seeded()
    const module = lectures(db)[0].moduleId
    const future = lectures(db)
      .filter((l) => l.moduleId === module)
      .map((l) => ({ l, block: cal.getBlock(db, l.blockId)! }))
      .filter((x) => x.block.start > toIso(NOW))
      .sort((a, b) => a.block.start.localeCompare(b.block.start))
    const [first, second] = future
    const perHour = db.select().from(t.modules).where(eq(t.modules.id, module)).get()!
      .writeUpMinutes
    const total =
      minutesBetween(first.block.start, first.block.end) +
      minutesBetween(second.block.start, second.block.end)
    // Both write-ups moved by hand, the first one well after the second session.
    const moveTo = (id: string, start: string) => {
      const b = cal.getBlock(db, id)!
      const end = Temporal.Instant.from(start).add({ minutes: minutesBetween(b.start, b.end) })
      cal.moveBlock(db, id, start, toIso(end), 'user')
    }
    const later = toIso(Temporal.Instant.from(second.block.end).add({ hours: 24 }))
    moveTo(first.l.writeUpBlockId!, later)
    moveTo(
      second.l.writeUpBlockId!,
      toIso(Temporal.Instant.from(second.block.end).add({ hours: 2 }))
    )
    const secondWriteUp = second.l.writeUpBlockId!

    tt.combineLectures(db, second.l.id, first.l.id, NOW)
    const a = lectures(db).find((l) => l.id === first.l.id)!
    expect(lectures(db).find((l) => l.id === second.l.id)!.writeUpBlockId).toBeNull()
    expect(cal.getBlock(db, secondWriteUp)).toBeUndefined()
    const wu = cal.getBlock(db, a.writeUpBlockId!)!
    expect(wu.start).toBe(later)
    expect(minutesBetween(wu.start, wu.end)).toBe(writeUpMinutesFor(total, perHour))
  })

  it('merges with the lecture before in one step, and unmerges a whole lecture', () => {
    const db = seeded()
    const module = lectures(db)[0].moduleId
    const own = () =>
      lectures(db)
        .filter((l) => l.moduleId === module)
        .sort((a, b) =>
          cal.getBlock(db, a.blockId)!.start.localeCompare(cal.getBlock(db, b.blockId)!.start)
        )
    const future = own().filter((l) => cal.getBlock(db, l.blockId)!.start > toIso(NOW))
    const [a, b, c] = future
    expect(tt.previousLecture(db, b.id)).toBe(a.id)
    expect(tt.mergeWithPrevious(db, b.id, NOW)).toBe(a.id)
    // The next one merges into the same lecture (its first session), not into b.
    expect(tt.previousLecture(db, c.id)).toBe(a.id)
    tt.mergeWithPrevious(db, c.id, NOW)
    const numbers = () =>
      own()
        .filter((l) => [a.id, b.id, c.id].includes(l.id))
        .map((l) => l.number)
    expect(new Set(numbers()).size).toBe(1)
    // The first lecture of the module has nothing before it.
    expect(() => tt.mergeWithPrevious(db, own()[0].id, NOW)).toThrow(/no earlier lecture/)
    // Unmerging the first session makes every session its own lecture again.
    tt.separateLecture(db, a.id, NOW)
    expect(new Set(numbers()).size).toBe(3)
    expect(lectures(db).filter((l) => l.continuesId)).toHaveLength(0)
  })
})

describe('workshops, practicals and other sessions', () => {
  const physLectures = (db: Db) => repo.getModuleDetail(db, 'phys', NOW)!.lectures

  it('guesses kinds from names, labels them per kind, and keeps what the user confirms', () => {
    const db = seeded()
    const [first, second, third] = physLectures(db)
    tt.renameLecture(db, first.id, 'Ephys WS1')
    tt.renameLecture(db, second.id, 'Stats & Analysis Support')
    tt.reconcileTimetable(db, NOW)
    let ls = physLectures(db)
    const byId = (id: string) => ls.find((l) => l.id === id)!
    expect(byId(first.id)).toMatchObject({ kind: 'workshop', kindConfirmed: false, label: 'WS1' })
    expect(byId(second.id)).toMatchObject({ kind: 'other', kindConfirmed: false, label: '' })
    // Lectures are numbered on their own; Claude's numbers still run through everything.
    expect(byId(third.id)).toMatchObject({ kind: 'lecture', label: 'L1', number: 3 })
    expect(cal.getBlock(db, first.blockId)!.title).toBe('PHYS WS1')
    expect(cal.getBlock(db, second.blockId)!.title).toBe('PHYS Stats & Analysis Support')
    expect(repo.withDisplay(db, [cal.getBlock(db, first.blockId)!])[0].detail).toBe(
      'WS1. Ephys WS1'
    )

    expect(tt.confirmKinds(db, 'phys', 'workshop', NOW)).toBe(1)
    ls = physLectures(db)
    expect(byId(first.id).kindConfirmed).toBe(true)
    expect(byId(second.id).kindConfirmed).toBe(false)

    // The user says it's a lecture after all: its name no longer decides.
    tt.setLectureKind(db, first.id, 'lecture', NOW)
    ls = physLectures(db)
    expect(byId(first.id)).toMatchObject({ kind: 'lecture', kindConfirmed: true, label: 'L1' })
    expect(byId(third.id).label).toBe('L2')
    tt.setLectureKind(db, first.id, null, NOW)
    ls = physLectures(db)
    expect(byId(first.id)).toMatchObject({ kind: 'workshop', kindConfirmed: false })
  })

  it('leaves sessions with no write-up out of the written-up count', () => {
    const db = seeded()
    const before = repo.getModuleDetail(db, 'phys', NOW)!
    const past = before.lectures.find((l) => l.status === 'attended')!
    tt.setNoWriteUp(db, past.id, true, NOW)
    const after = repo.getModuleDetail(db, 'phys', NOW)!
    expect(after.lecturesSoFar).toBe(before.lecturesSoFar - 1)
    expect(after.writtenUp).toBe(before.writtenUp)
  })

  it('lists the timetable’s practicals with write-ups only when the module says so', () => {
    const db = seeded()
    const events = feed()
    const lecture = events.find((e) => e.moduleName === 'Systems Physiology')!
    const practical: TimetableEvent = {
      ...lecture,
      uid: 'prac-1@test',
      feedType: 'Practical',
      type: 'practical',
      start: '2026-11-23T13:00:00Z',
      end: '2026-11-23T16:00:00Z'
    }
    reimport(db, [...events, practical])
    const before = physLectures(db).length
    const count = repo.getModuleDetail(db, 'phys', NOW)!.timetabledSessionCount
    expect(count).toBeGreaterThan(1) // the demo's own, and this one
    expect(repo.getModuleDetail(db, 'phys', NOW)!.timetabledSessions).toBeNull()

    tt.updateModule(db, 'phys', { timetabledSessions: true }, NOW)
    const ls = physLectures(db)
    expect(ls).toHaveLength(before + count)
    const prac = ls.find((l) => l.start === practical.start)!
    expect(prac).toMatchObject({ kind: 'practical', kindConfirmed: true })
    expect(prac.label).toMatch(/^P\d+$/)
    expect(prac.writeUp).not.toBeNull()
    expect(cal.getBlock(db, prac.blockId)!.title).toBe(`PHYS ${prac.label}`)
    // Lecture labels still count lectures only.
    expect(ls.filter((l) => l.kind === 'lecture').map((l) => l.label)[0]).toBe('L1')

    tt.updateModule(db, 'phys', { timetabledSessions: false }, NOW)
    expect(physLectures(db)).toHaveLength(before)
    expect(blocks(db).some((b) => b.id === prac.writeUp!.id)).toBe(false)
  })
})
