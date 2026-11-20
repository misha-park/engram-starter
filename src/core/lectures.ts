import { Temporal } from 'temporal-polyfill'
import type { BlockType, LectureStatus, Outcome } from '../shared/types'

/**
 * A lecture is "written up" when its write-up block is done, "attended" once it has ended
 * (there is deliberately no "missed" status), and "scheduled" before that.
 */
export function lectureStatus(
  lectureEnd: string,
  writeUpOutcome: Outcome | null,
  now: Temporal.Instant,
  missed = false
): LectureStatus {
  if (writeUpOutcome === 'done') return 'written-up'
  if (Temporal.Instant.compare(Temporal.Instant.from(lectureEnd), now) > 0) return 'scheduled'
  // Once it's over a lecture counts as attended, unless the user said they didn't go.
  return missed ? 'missed' : 'attended'
}

const TYPE_LABEL: Partial<Record<BlockType, string>> = {
  practical: 'Practical',
  workshop: 'Workshop',
  pbl: 'PBL',
  presentation: 'Presentation',
  assessment: 'Assessment',
  viva: 'Viva'
}

/** Block title for a timetabled event: "NEUR L7", "PHAR Practical", or the feed name if unmapped. */
export function timetableTitle(opts: {
  moduleLabel: string | null
  feedModuleName: string
  type: BlockType
  feedType: string
  lectureNumber?: number
}): string {
  const who = opts.moduleLabel ?? opts.feedModuleName
  if (opts.type === 'lecture' && opts.lectureNumber && opts.moduleLabel) {
    return `${who} L${opts.lectureNumber}`
  }
  return `${who} ${TYPE_LABEL[opts.type] ?? opts.feedType}`
}

/** Default write-up time per hour of lecture. */
export const DEFAULT_WRITE_UP_MINUTES_PER_HOUR = 60

/** Write-up length for a lecture: scales with its length, in quarter hours (at least 15 min). */
export function writeUpMinutesFor(lectureMinutes: number, minutesPerHour: number): number {
  return Math.max(15, Math.round((lectureMinutes * minutesPerHour) / 60 / 15) * 15)
}

/**
 * A lecture as the calendar's second line shows it: "L12. Ion channels", or "L12" when it has
 * no name yet; a later session of a lecture across several days adds "(part 2)".
 */
export function lectureLine(number: number, title: string | null, part = 1): string {
  const n = `L${number}${part > 1 ? ` (part ${part})` : ''}`
  return title?.trim() ? `${n}. ${title.trim()}` : n
}

/**
 * What a block's bubble shows when Engram has nothing better: a timetabled title like
 * "NEUR Practical" becomes the module's name on top and "Practical" below.
 */
export function splitLabelledTitle(
  title: string,
  shortLabel: string | null,
  moduleName: string | null
): { heading: string; detail: string | null } {
  if (shortLabel && moduleName && title.startsWith(`${shortLabel} `)) {
    return { heading: moduleName, detail: title.slice(shortLabel.length + 1) }
  }
  return { heading: title, detail: null }
}
