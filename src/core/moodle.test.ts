import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import {
  academicYearStart,
  courseTitle,
  htmlToText,
  isCurrentCourse,
  sectionWeek,
  similarity,
  suggestModule,
  teachingWeek,
  wantedFile,
  yearLabel
} from './moodle'

const day = (s: string) => Temporal.PlainDate.from(s)

describe('UCL teaching weeks', () => {
  it('counts from the week of 1 September', () => {
    expect(academicYearStart(day('2026-11-18')).toString()).toBe('2026-08-31')
    expect(academicYearStart(day('2027-02-01')).toString()).toBe('2026-08-31')
    expect(academicYearStart(day('2026-08-20')).toString()).toBe('2025-09-01')
    // NEUR0014's first lecture (Week 6) and a November lecture (Week 12).
    expect(teachingWeek('2026-10-06T10:00:00Z')).toBe(6)
    expect(teachingWeek('2026-11-18T10:00:00Z')).toBe(12)
    // Term 2 carries on the numbering.
    expect(teachingWeek('2027-01-12T10:00:00Z')).toBe(20)
  })

  it('reads the week from a section name', () => {
    expect(sectionWeek('Week 8: Simple supervised learning &amp; more')).toBe(8)
    expect(sectionWeek('week 12 - Molecular Techniques')).toBe(12)
    expect(sectionWeek('Assessment and feedback')).toBeNull()
    expect(sectionWeek('Weekly quiz')).toBeNull()
  })
})

describe('this year’s courses', () => {
  const nov = day('2026-11-18')
  it('knows the year label and which courses are current', () => {
    expect(yearLabel(nov)).toBe('26-27')
    expect(isCurrentCourse({ shortname: 'NEUR0014_26-27', fullname: '' }, nov)).toBe(true)
    expect(isCurrentCourse({ shortname: 'X', fullname: 'Advanced Project 2026-27' }, nov)).toBe(
      true
    )
    expect(isCurrentCourse({ shortname: 'Y', fullname: 'Something 26/27' }, nov)).toBe(true)
    expect(isCurrentCourse({ shortname: 'NEUR0014_25-26', fullname: 'Old 25/26' }, nov)).toBe(false)
    expect(isCurrentCourse({ shortname: 'CompSci Careers', fullname: 'Careers' }, nov)).toBe(false)
  })

  it('strips codes and years from titles and suggests the module', () => {
    expect(courseTitle('NEUR0014: Neural Basis of Motivation and Learning 26/27')).toBe(
      'Neural Basis of Motivation and Learning'
    )
    expect(
      courseTitle(
        'CELL0005/NEUR0002/PHAR0016/PHOL0013: Advanced Investigative Project in Neuroscience 2026-27'
      )
    ).toBe('Advanced Investigative Project in Neuroscience')
    const modules = [
      {
        id: 'm1',
        name: 'Motivation and Learning',
        feedNames: ['Neural Basis of Motivation and Learning']
      },
      {
        id: 'm2',
        name: 'Neural Computation',
        feedNames: ['Neural Computation: Models of Brain Function']
      }
    ]
    expect(
      suggestModule(
        { fullname: 'NEUR0014: Neural Basis of Motivation and Learning 26/27' },
        modules
      )
    ).toBe('m1')
    expect(
      suggestModule(
        { fullname: 'NEUR0016: Neural Computation: Models of Brain Function 26/27' },
        modules
      )
    ).toBe('m2')
    expect(suggestModule({ fullname: 'ACC Life Sciences 26/27' }, modules)).toBeNull()
    expect(similarity('Essay (Level 6 Students)', 'Neural computation essay')).toBe(1)
    expect(similarity('Submit your draft here', 'Project draft')).toBe(1)
    expect(similarity('Graph submission', 'Project draft')).toBe(0)
  })
})

describe('files and briefs', () => {
  it('keeps documents and skips videos, data and huge files', () => {
    expect(wantedFile('Intro slides.pdf', 2_000_000)).toBe(true)
    expect(wantedFile('the task.PPTX', 50_000)).toBe(true)
    expect(wantedFile('Denk.m4v', 10_000_000)).toBe(false)
    expect(wantedFile('HillInhibition.FDF', 2000)).toBe(false)
    expect(wantedFile('huge.pdf', 60 * 1024 * 1024)).toBe(false)
  })

  it('turns an assignment description into plain text', () => {
    expect(
      htmlToText(
        '<p>Write an essay on <strong>one</strong> paper.</p><ul><li>2,000 words</li><li>Due &amp; marked</li></ul><p>Good&nbsp;luck</p>'
      )
    ).toBe('Write an essay on one paper.\n\n• 2,000 words\n• Due & marked\n\nGood luck')
  })
})
