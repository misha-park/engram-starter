// Lecture lists (Phase 10): match a module's own list of lectures (from its booklet or
// spreadsheet, read by Claude into ListedLecture rows) against the lectures in the timetable,
// to find timetable events that hold more than one lecture (the feed gives a 2-hour slot as
// one event even when it's two different lectures). Pure logic, no I/O.
//
// If the list's dates are this year's (most of them land on a timetabled lecture's day), the
// listed lectures inside each timetabled one are found by date and time. Otherwise (e.g. last
// year's booklet, same order) they're matched by order: each timetabled lecture takes as many
// back-to-back listed lectures as fill its length.

import { Temporal } from 'temporal-polyfill'
import { TZ } from './time'
import type { SessionKind } from './session-kinds'

/** One lecture as the list gives it. Times are London local, 24h. */
export interface ListedLecture {
  title: string
  /** YYYY-MM-DD, when the list gives a date. */
  date: string | null
  /** 1 = Monday … 7 = Sunday, when the list gives a day. */
  weekday: number | null
  start: string
  end: string
}

/** A lecture in the timetable (as Engram has it now). */
export interface TimetabledLecture {
  id: string
  number: number
  /** UTC ISO instants. */
  start: string
  end: string
  /** What the session is (workshops and practicals can sit among the lectures). */
  kind?: SessionKind
}

/** A timetabled lecture that the list shows is really several. */
export interface SplitProposal {
  lectureId: string
  number: number
  /** The lectures in it, as the list gives them. */
  parts: { title: string; start: string; end: string }[]
  /** Where the parts begin, in minutes from the timetabled lecture's start. */
  cuts: number[]
  /** 'sure' when the day and times agree with the list; 'check' when only the order does. */
  confidence: 'sure' | 'check'
}

export interface ListMatch {
  method: 'dates' | 'order'
  proposals: SplitProposal[]
  /** Timetabled lectures that are one lecture of the list: their titles. */
  titled: { lectureId: string; number: number; title: string }[]
  /** Listed lectures that found no place in the timetable. */
  unmatched: number
}

/** The shortest part a lecture can be split into, in minutes. */
export const MIN_PART = 15

/** Whether these cut points split a lecture of this length into valid parts. */
export function validCuts(cuts: number[], lengthMinutes: number): boolean {
  return (
    cuts.length > 0 &&
    cuts.every(
      (c, i) =>
        Number.isInteger(c) &&
        c >= (i ? cuts[i - 1] : 0) + MIN_PART &&
        c <= lengthMinutes - MIN_PART
    )
  )
}
const local = (iso: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(TZ)
const hhmm = (z: Temporal.ZonedDateTime) =>
  `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`
const minutes = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const length = (l: { start: string; end: string }) =>
  Temporal.Instant.from(l.start).until(Temporal.Instant.from(l.end)).total('minutes')
const listedLength = (l: ListedLecture) => {
  const d = minutes(l.end) - minutes(l.start)
  return d > 0 ? d : d + 24 * 60
}

/** Whether the list's dates are this year's: most dated entries fall on a timetabled lecture day. */
export function datesMatch(listed: ListedLecture[], timetable: TimetabledLecture[]): boolean {
  const days = new Set(timetable.map((t) => local(t.start).toPlainDate().toString()))
  const dated = listed.filter((l) => l.date)
  if (dated.length < 3) return false
  return dated.filter((l) => days.has(l.date!)).length / dated.length >= 0.6
}

export function matchLectureList(
  listed: ListedLecture[],
  timetable: TimetabledLecture[]
): ListMatch {
  const lectures = [...timetable].sort((a, b) => a.start.localeCompare(b.start))
  const proposal = (
    l: TimetabledLecture,
    parts: ListedLecture[],
    sure: boolean
  ): SplitProposal[] => {
    const from = minutes(parts[0].start)
    const cuts = parts.slice(1).map((p) => minutes(p.start) - from)
    if (!validCuts(cuts, length(l))) return []
    return [
      {
        lectureId: l.id,
        number: l.number,
        parts: parts.map(({ title, start, end }) => ({ title, start, end })),
        cuts,
        confidence: sure ? 'sure' : 'check'
      }
    ]
  }
  const backToBack = (parts: ListedLecture[]) =>
    parts.every((p, k) => k === 0 || parts[k - 1].end === p.start)

  const titled: ListMatch['titled'] = []
  const title = (l: TimetabledLecture, x: ListedLecture) =>
    titled.push({ lectureId: l.id, number: l.number, title: x.title })

  if (datesMatch(listed, lectures)) {
    const placed = new Set<ListedLecture>()
    const proposals = lectures.flatMap((l) => {
      const z = local(l.start)
      const day = z.toPlainDate().toString()
      const from = minutes(hhmm(z))
      const to = from + length(l)
      const inside = listed
        .filter(
          (x) =>
            x.date === day && minutes(x.start) >= from && minutes(x.start) + listedLength(x) <= to
        )
        .sort((a, b) => a.start.localeCompare(b.start))
      inside.forEach((x) => placed.add(x))
      if (inside.length === 1) title(l, inside[0])
      if (inside.length < 2) return []
      const sure =
        backToBack(inside) &&
        minutes(inside[0].start) === from &&
        minutes(inside[inside.length - 1].start) + listedLength(inside[inside.length - 1]) === to
      return proposal(l, inside, sure)
    })
    const unmatched = listed.filter((x) => x.date && !placed.has(x)).length
    return { method: 'dates', proposals, titled, unmatched }
  }

  // By order: each timetabled lecture takes back-to-back listed lectures until it's full.
  // Only lectures count, so a workshop or practical in between doesn't shift the list by one
  // (unless the module has nothing but other kinds).
  const byOrder = lectures.some((l) => (l.kind ?? 'lecture') === 'lecture')
    ? lectures.filter((l) => (l.kind ?? 'lecture') === 'lecture')
    : lectures
  const sameDay = (a: ListedLecture, b: ListedLecture) =>
    (!a.date || !b.date || a.date === b.date) &&
    (a.weekday === null || b.weekday === null || a.weekday === b.weekday)
  const proposals: SplitProposal[] = []
  let i = 0
  for (const l of byOrder) {
    if (i >= listed.length) break
    const want = length(l)
    let j = i
    let total = listedLength(listed[i])
    while (
      total < want - 10 &&
      j + 1 < listed.length &&
      sameDay(listed[j], listed[j + 1]) &&
      listed[j].end === listed[j + 1].start
    ) {
      j++
      total += listedLength(listed[j])
    }
    if (j === i) title(l, listed[i])
    if (j > i) {
      const z = local(l.start)
      const sure =
        (listed[i].weekday === null || listed[i].weekday === z.dayOfWeek) &&
        listed[i].start === hhmm(z) &&
        Math.abs(total - want) <= 10
      proposals.push(...proposal(l, listed.slice(i, j + 1), sure))
    }
    i = j + 1
  }
  return {
    method: 'order',
    proposals,
    titled,
    unmatched: listed.length - Math.min(i, listed.length)
  }
}
