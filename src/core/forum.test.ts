import { describe, expect, it } from 'vitest'
import {
  changedDiscussions,
  fallbackImportant,
  forumHints,
  forumTitle,
  isNewPost,
  isStaffRole,
  postKind,
  triage
} from './forum'

describe('forumHints', () => {
  it('finds changes to lectures, rooms, releases, deadlines and extensions', () => {
    expect(forumHints('Friday’s lecture has moved: 6 November, 10am')).toEqual(['moved'])
    expect(forumHints('Tomorrow’s lecture is cancelled')).toEqual(['cancelled'])
    expect(forumHints('No lecture on Monday')).toEqual(['no lecture'])
    expect(forumHints('We’ll be in Room 1.03, Malet Place')).toEqual(['room'])
    expect(forumHints('The essay brief has been released')).toEqual(['released'])
    expect(forumHints('The deadline is now 4 December')).toEqual(['deadline'])
    expect(forumHints('Everyone gets a one-week extension')).toEqual(['extension'])
    expect(forumHints('The session won’t take place this week')).toEqual(['won’t take place'])
  })

  it('finds nothing in a plain answer to a question', () => {
    expect(
      forumHints('Hello Defne, the aim is to silence the cells which express the OTRs. Best, Dan')
    ).toEqual([])
  })
})

describe('isStaffRole', () => {
  it('counts leaders, teachers and tutors, not students', () => {
    expect(isStaffRole(['uclleader'])).toBe(true)
    expect(isStaffRole(['editingteacher'])).toBe(true)
    expect(isStaffRole(['uclstudent'])).toBe(false)
    expect(isStaffRole(['student', 'guest'])).toBe(false)
    expect(isStaffRole([])).toBe(false)
    expect(isStaffRole(['uclstudent', 'ucltutor'])).toBe(true)
  })
})

describe('postKind and triage', () => {
  const staff = new Set([10])

  it('counts every Announcements post, whoever wrote it', () => {
    expect(postKind('news', 99, staff)).toBe('announcement')
    expect(triage({ kind: 'announcement', isReply: false, hints: [] })).toBe('important')
  })

  it('never looks at students’ posts in other forums', () => {
    expect(postKind('general', 99, staff)).toBe('other')
    expect(triage({ kind: 'other', isReply: false, hints: ['cancelled'] })).toBe('not-important')
  })

  it('drops a staff reply with no hint of a change (an answer)', () => {
    expect(postKind('general', 10, staff)).toBe('staff')
    expect(triage({ kind: 'staff', isReply: true, hints: [] })).toBe('not-important')
  })

  it('asks Claude about staff posts that start a discussion or hint at a change', () => {
    expect(triage({ kind: 'staff', isReply: false, hints: [] })).toBe('classify')
    expect(triage({ kind: 'staff', isReply: true, hints: ['deadline'] })).toBe('classify')
  })

  it('without Claude, counts only staff discussions that hint at a change', () => {
    expect(fallbackImportant({ isReply: false, hints: ['room'] })).toBe(true)
    expect(fallbackImportant({ isReply: false, hints: [] })).toBe(false)
    expect(fallbackImportant({ isReply: true, hints: ['deadline'] })).toBe(false)
  })
})

describe('isNewPost', () => {
  it('ignores posts from before the first sync and posts already kept', () => {
    const seen = new Set([5])
    expect(isNewPost({ id: 6, created: 200 }, 100, seen)).toBe(true)
    expect(isNewPost({ id: 7, created: 50 }, 100, seen)).toBe(false)
    expect(isNewPost({ id: 5, created: 200 }, 100, seen)).toBe(false)
  })
})

describe('changedDiscussions', () => {
  it('takes discussions changed since the last read, skipping old pinned ones', () => {
    const page = [
      { id: 1, timemodified: 50, pinned: true },
      { id: 2, timemodified: 300 },
      { id: 3, timemodified: 200 },
      { id: 4, timemodified: 90 },
      { id: 5, timemodified: 400 }
    ]
    const r = changedDiscussions(page, 100)
    expect(r.changed.map((d) => d.id)).toEqual([2, 3])
    expect(r.more).toBe(false)
  })

  it('says older pages may hold more when the whole page changed', () => {
    expect(changedDiscussions([{ timemodified: 300 }], 100).more).toBe(true)
    expect(changedDiscussions([], 100).more).toBe(false)
  })
})

describe('forumTitle', () => {
  it('uses Claude’s title, else the subject without “Re:”', () => {
    expect(forumTitle('Friday lecture moved to Room 1.03', 'x')).toBe(
      'Friday lecture moved to Room 1.03'
    )
    expect(forumTitle(null, 'Re: Essay deadline')).toBe('Essay deadline')
    expect(forumTitle('  ', 'Lecture cancelled')).toBe('Lecture cancelled')
  })

  it('keeps it to one short line', () => {
    expect(forumTitle('a\nb', '')).toBe('a b')
    const long = forumTitle('x'.repeat(200), '')
    expect(long).toHaveLength(90)
    expect(long.endsWith('…')).toBe(true)
  })
})
