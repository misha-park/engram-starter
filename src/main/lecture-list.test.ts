import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTimetable } from '../core/ics'
import { AppContext } from './app-context'
import * as t from './db/schema'
import { analyseLectureList, applyLectureSplits, cleanListedLectures } from './lecture-list'
import { buildDemoTimetableIcs } from './seed/demo-timetable'
import * as tt from './timetable'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

function withTwoHourLecture() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-ll-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  const db = ctx.db
  const events = parseTimetable(buildDemoTimetableIcs(NOW), {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2027-03-01T00:00:00Z')
  }).events
  const name = events.find((e) => e.type === 'lecture')!.moduleName
  const base = { moduleName: name, level: 6, feedType: 'Lecture', type: 'lecture' as const }
  events.push({
    ...base,
    uid: 'long-1',
    start: '2026-11-27T11:00:00Z',
    end: '2026-11-27T13:00:00Z'
  })
  tt.importTimetable(db, events, NOW, { source: 'test' })
  const moduleId = db
    .select()
    .from(t.moduleAliases)
    .all()
    .find((a) => a.feedName === name)!.moduleId
  return { db, moduleId }
}

describe('lecture lists', () => {
  it('tidies what Claude read', () => {
    expect(
      cleanListedLectures({
        lectures: [
          { title: ' Limbic system ', date: '2026-10-13', weekday: 2, start: '9:00', end: '11.00' },
          { title: 'No times', date: null, weekday: null, start: 'morning', end: '' },
          { title: 'Bad date', date: '2026-02-30', weekday: 9, start: '10:00', end: '11:00' }
        ]
      })
    ).toEqual([
      { title: 'Limbic system', date: '2026-10-13', weekday: 2, start: '09:00', end: '11:00' },
      { title: 'Bad date', date: null, weekday: null, start: '10:00', end: '11:00' }
    ])
  })

  it('suggests splitting the 2-hour event from a dated list, and splits it when accepted', async () => {
    const { db, moduleId } = withTwoHourLecture()
    let prompt = ''
    const analysis = await analyseLectureList(
      db,
      moduleId,
      'Lecture list for the module, autumn 2026. Fri 27 Nov 11:00 Part one, 12:00 Part two. (plus the weekly lectures)',
      async (_s, p) => {
        prompt = p
        // The weekly lectures (as timetabled) plus the two lectures in the 2-hour slot.
        const rows = db
          .select({ start: t.blocks.start, end: t.blocks.end, moduleId: t.lectures.moduleId })
          .from(t.lectures)
          .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
          .all()
          .filter((r) => r.moduleId === moduleId && !r.start.startsWith('2026-11-27'))
          .map((r) => {
            const z = Temporal.Instant.from(r.start).toZonedDateTimeISO('Europe/London')
            const e = Temporal.Instant.from(r.end).toZonedDateTimeISO('Europe/London')
            const hm = (x: Temporal.ZonedDateTime) =>
              `${String(x.hour).padStart(2, '0')}:${String(x.minute).padStart(2, '0')}`
            return {
              title: 'Weekly',
              date: z.toPlainDate().toString(),
              weekday: null,
              start: hm(z),
              end: hm(e)
            }
          })
        return {
          lectures: [
            ...rows,
            { title: 'Part one', date: '2026-11-27', weekday: 5, start: '11:00', end: '12:00' },
            { title: 'Part two', date: '2026-11-27', weekday: 5, start: '12:00', end: '13:00' }
          ]
        }
      }
    )
    expect(prompt).toContain('The module:')
    expect(analysis.method).toBe('dates')
    expect(analysis.proposals).toHaveLength(1)
    expect(analysis.proposals[0]).toMatchObject({ cuts: [60], confidence: 'sure' })
    expect(analysis.proposals[0].parts.map((p) => p.title)).toEqual(['Part one', 'Part two'])
    const count = () =>
      db
        .select()
        .from(t.lectures)
        .all()
        .filter((l) => l.moduleId === moduleId).length
    const before = count()
    const accepted = analysis.proposals.map(({ lectureId, cuts }) => ({ lectureId, cuts }))
    expect(applyLectureSplits(db, accepted, NOW)).toBe(1)
    expect(count()).toBe(before + 1)
    expect(db.select().from(t.lectureSplits).all()[0]).toMatchObject({
      uid: 'long-1',
      cuts: [60],
      source: 'list'
    })
    // Applying again changes nothing.
    expect(applyLectureSplits(db, accepted, NOW)).toBe(0)
    expect(count()).toBe(before + 1)
  })
})
