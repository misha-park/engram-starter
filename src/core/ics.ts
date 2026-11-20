import ical, { type VEvent } from 'node-ical'
import type { BlockType } from '../shared/types'

// Parses the UCL timetable feed (iCalendar). Pure: text in, events out; no I/O.
//
// SUMMARY format: "<Module name> Level <n> [<Event type>]". The type comes from the bracket,
// because CATEGORIES is sometimes "None". Only time, module and type are kept.

export interface TimetableEvent {
  uid: string
  /** UTC ISO instants */
  start: string
  end: string
  /** The module name exactly as it appears in the feed (several can map to one module). */
  moduleName: string
  level: number | null
  /** The bracketed type as written in the feed, e.g. "Problem Based Learning". */
  feedType: string
  /** Our block type, or null for "None" events (hidden by default). */
  type: BlockType | null
}

export interface ParseResult {
  events: TimetableEvent[]
  skipped: { uid: string; summary: string; reason: string }[]
}

const TYPE_MAP: Record<string, BlockType | null> = {
  lecture: 'lecture',
  practical: 'practical',
  workshop: 'workshop',
  presentation: 'presentation',
  assessment: 'assessment',
  'problem based learning': 'pbl',
  viva: 'viva',
  none: null
}

export function mapEventType(feedType: string): BlockType | null {
  const key = feedType.trim().toLowerCase()
  return key in TYPE_MAP ? TYPE_MAP[key] : 'other'
}

/** "Cellular Neurophysiology Level 6 [Lecture]" → name, level, type text. */
export function parseSummary(
  summary: string
): { moduleName: string; level: number | null; feedType: string } | null {
  const s = summary.trim()
  const withLevel = /^(.+?)\s+Level\s+(\d+)\s*\[([^\]]+)\]$/i.exec(s)
  if (withLevel) {
    return {
      moduleName: withLevel[1].trim(),
      level: Number(withLevel[2]),
      feedType: withLevel[3].trim()
    }
  }
  const noLevel = /^(.+?)\s*\[([^\]]+)\]$/.exec(s)
  if (noLevel) return { moduleName: noLevel[1].trim(), level: null, feedType: noLevel[2].trim() }
  return null
}

/**
 * The UCL feed lists a cross-listed module by repeating its name(s) in one SUMMARY, comma
 * separated: "X, X, X". Names can contain commas themselves ("Methods in A, B and C"), so we
 * only collapse an exact repetition of the same sequence; a genuine list of different names
 * stays as one feed name (mapped to a module in setup).
 */
export function collapseRepeatedName(name: string): string {
  const parts = name.split(', ')
  for (let k = 1; k < parts.length; k++) {
    if (parts.length % k !== 0) continue
    const unit = parts.slice(0, k).join(', ')
    if (Array.from({ length: parts.length / k }, () => unit).join(', ') === name) return unit
  }
  return name
}

const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : v && typeof v === 'object' && 'val' in v
      ? String((v as { val: unknown }).val)
      : ''

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Parse feed text. Recurring events (RRULE) are expanded within `window`; each instance gets
 * a stable uid of "<uid>#<start>". Cancelled events are skipped.
 */
export function parseTimetable(
  icsText: string,
  window: { from: Date; to: Date } = {
    from: new Date(Date.now() - 365 * 864e5),
    to: new Date(Date.now() + 365 * 864e5)
  }
): ParseResult {
  const data = ical.sync.parseICS(icsText)
  const events: TimetableEvent[] = []
  const skipped: ParseResult['skipped'] = []

  for (const [key, component] of Object.entries(data)) {
    if (
      !component ||
      typeof component !== 'object' ||
      (component as { type?: string }).type !== 'VEVENT'
    ) {
      continue
    }
    const ev = component as VEvent
    const uid = ev.uid || key
    const summary = text(ev.summary)
    if (ev.status === 'CANCELLED') {
      skipped.push({ uid, summary, reason: 'cancelled' })
      continue
    }
    const parsed = parseSummary(summary)
    // Fall back to CATEGORIES only when the summary has no bracketed type.
    const categories = Array.isArray(ev.categories) ? (ev.categories as string[]) : []
    if (!parsed) {
      skipped.push({ uid, summary, reason: 'summary not in "<Module> Level <n> [<Type>]" format' })
      continue
    }
    const feedType = parsed.feedType || categories[0] || 'None'

    const instances: { uid: string; start: Date; end: Date }[] = []
    if (ev.rrule) {
      for (const inst of ical.expandRecurringEvent(ev, { from: window.from, to: window.to })) {
        instances.push({ uid: `${uid}#${iso(inst.start)}`, start: inst.start, end: inst.end })
      }
    } else if (ev.start && ev.end) {
      instances.push({ uid, start: ev.start, end: ev.end })
    }
    if (instances.length === 0) {
      skipped.push({ uid, summary, reason: 'no start/end time' })
      continue
    }
    for (const inst of instances) {
      if (inst.end.getTime() <= inst.start.getTime()) {
        skipped.push({ uid: inst.uid, summary, reason: 'ends before it starts' })
        continue
      }
      events.push({
        uid: inst.uid,
        start: iso(inst.start),
        end: iso(inst.end),
        moduleName: collapseRepeatedName(parsed.moduleName),
        level: parsed.level,
        feedType,
        type: mapEventType(feedType)
      })
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid))
  return { events, skipped }
}
