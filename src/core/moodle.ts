// Moodle downloads: pure logic, no I/O. Which courses are this year's, which module a course
// probably is, which files to keep, UCL teaching weeks ("Week 8: …" sections), and a brief's
// text from an assignment's HTML description.

import { Temporal } from 'temporal-polyfill'
import { TZ } from './time'

/** Documents worth keeping (slides, handouts, briefs, readings). Videos and data aren't. */
const KEEP = new Set([
  'pdf',
  'ppt',
  'pptx',
  'key',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'odt',
  'odp',
  'rtf',
  'txt',
  'md'
])
export const MAX_FILE_BYTES = 50 * 1024 * 1024

export function wantedFile(name: string, size: number): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return KEEP.has(ext) && size > 0 && size <= MAX_FILE_BYTES
}

/** Moodle sends some text HTML-escaped (e.g. "Pharmacology &amp; Physiology"). */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** A brief's text from an assignment description (HTML): paragraphs and list items kept. */
export function htmlToText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n• ')
      .replace(/<\s*\/(ul|ol)\s*>/gi, '\n\n')
      .replace(/<\s*\/(p|div|h\d|tr)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The Monday that starts UCL's week 1 for the academic year containing `date`: the week of
 * 1 September. Weeks are numbered on through the year (term 2 starts around week 20).
 */
export function academicYearStart(date: Temporal.PlainDate): Temporal.PlainDate {
  const mondayOf = (d: Temporal.PlainDate) => d.subtract({ days: d.dayOfWeek - 1 })
  const thisYear = mondayOf(Temporal.PlainDate.from({ year: date.year, month: 9, day: 1 }))
  return Temporal.PlainDate.compare(date, thisYear) >= 0
    ? thisYear
    : mondayOf(Temporal.PlainDate.from({ year: date.year - 1, month: 9, day: 1 }))
}

/** UCL teaching week of an instant (week 1 = the week of 1 September). */
export function teachingWeek(iso: string): number {
  const date = Temporal.Instant.from(iso).toZonedDateTimeISO(TZ).toPlainDate()
  return Math.floor(academicYearStart(date).until(date).days / 7) + 1
}

/** The week number of a section called "Week 8: …" (null for other sections). */
export function sectionWeek(name: string): number | null {
  const m = /^\s*week\s*(\d{1,2})\b/i.exec(unescapeHtml(name))
  return m ? Number(m[1]) : null
}

/** "26-27" for the academic year containing `date`. */
export function yearLabel(date: Temporal.PlainDate): string {
  const y = academicYearStart(date).add({ days: 7 }).year % 100
  return `${String(y).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`
}

/** Whether a course is this academic year's ("…_26-27", "… 26/27", "2026-27"). */
export function isCurrentCourse(
  c: { shortname: string; fullname: string },
  date: Temporal.PlainDate
): boolean {
  const label = yearLabel(date)
  const [a, b] = label.split('-')
  const text = `${c.shortname} ${unescapeHtml(c.fullname)}`
  return new RegExp(`(^|[^\\d])(20)?${a}\\s*[-/]\\s*(20)?${b}($|[^\\d])`).test(text)
}

/** "BIOS0024: Investigative Methods … 26/27" → "Investigative Methods …". */
export function courseTitle(fullname: string): string {
  return unescapeHtml(fullname)
    .replace(/^[A-Z]{3,4}\d{4}[A-Z]?(\s*[/,]\s*[A-Z]{0,4}\d{4}[A-Z]?)*\s*[:\-–]\s*/, '')
    .replace(/\s*\(?\s*(20)?\d{2}\s*[-/]\s*(20)?\d{2}\s*\)?\s*$/, '')
    .trim()
}

const STOP = new Set([
  ...['and', 'the', 'of', 'in', 'for', 'to', 'a', 'an', 'on', 'with', 'your', 'here', 'please'],
  // Words every Moodle assignment has, which say nothing about which one it is.
  ...['level', 'students', 'student', 'submit', 'submission', 'upload']
])
const words = (s: string) =>
  new Set(
    unescapeHtml(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
  )

/** How alike two titles are (0–1): shared words over the shorter title's words. */
export function similarity(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / Math.min(x.size, y.size)
}

/** The module a course most likely is (by its title against module names and timetable names). */
export function suggestModule(
  course: { fullname: string },
  modules: { id: string; name: string; feedNames: string[] }[]
): string | null {
  const title = courseTitle(course.fullname)
  let best: { id: string; score: number } | null = null
  for (const m of modules) {
    const score = Math.max(
      similarity(title, m.name),
      ...m.feedNames.map((f) => similarity(title, f))
    )
    if (score >= 0.6 && (!best || score > best.score)) best = { id: m.id, score }
  }
  return best?.id ?? null
}
