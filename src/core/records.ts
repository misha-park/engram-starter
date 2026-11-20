import type { Outcome } from '../shared/types'
import { formatClock, formatMinutes, zoned } from './time'

// Markdown for record files. The app writes these as append-only logs that people (and the
// assistant) read; nothing is ever parsed back out of them.

const dayLabel = (iso: string) =>
  zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

const OUTCOME_LABEL: Record<Exclude<Outcome, 'none'>, string> = {
  done: 'Done',
  partial: 'Partial',
  skipped: 'Skipped'
}

export interface RecordEntity {
  type: 'lecture' | 'assignment' | 'module' | 'dissertation' | 'other'
  /** Heading for a new file. */
  title: string
  /** Optional lines under the heading (e.g. when the lecture was). */
  intro?: string
}

export function recordHeader(entity: RecordEntity): string {
  return `# ${entity.title}\n\n${entity.intro ? `${entity.intro}\n\n` : ''}`
}

export interface SessionEntry {
  start: string
  end: string | null
  minutes: number
  outcome: Exclude<Outcome, 'none'>
  manual?: boolean
  blockTitle?: string
  planned?: { start: string; end: string }
  note?: string | null
  debrief?: string | null
  /** The timer stopped itself here; the user corrected the end at check-in. */
  timedOutAt?: string | null
}

/** One "## …" section for a session (or a skipped block, which has no time). */
export function sessionEntry(e: SessionEntry): string {
  const head =
    e.outcome === 'skipped' && e.minutes === 0
      ? `## ${dayLabel(e.start)} · Skipped`
      : `## ${dayLabel(e.start)} · ${formatClock(e.start)}–${e.end ? formatClock(e.end) : '…'} · ${formatMinutes(e.minutes)} · ${e.manual ? 'Manual time' : OUTCOME_LABEL[e.outcome]}`
  const lines = [head, '']
  if (e.blockTitle) {
    const planned = e.planned
      ? ` (planned ${formatClock(e.planned.start)}–${formatClock(e.planned.end)})`
      : ''
    lines.push(`Block: ${e.blockTitle}${planned}`)
  }
  if (e.timedOutAt) {
    lines.push(
      `The timer stopped itself at ${formatClock(e.timedOutAt)}; end time confirmed at check-in.`
    )
  }
  if (e.note) lines.push(`Note: ${e.note}`)
  if (e.debrief) lines.push('', '**Debrief**', '', e.debrief)
  return lines.join('\n') + '\n\n'
}

/** A debrief written after the session was logged. */
export function debriefEntry(at: string, debrief: string): string {
  return `## ${dayLabel(at)} · Debrief\n\n${debrief}\n\n`
}

/** A file-name-safe version of a title. */
export function safeName(s: string): string {
  return (
    s
      .replace(/[/\\:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled'
  )
}
