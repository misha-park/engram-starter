import { Temporal } from 'temporal-polyfill'
import type { AssignmentSummary, AssignmentType } from '@shared/types'
import { formatClock, zoned } from '@core/time'

export const TYPE_LABEL: Record<AssignmentType, string> = {
  essay: 'Essay',
  'lab-report': 'Lab report',
  'problem-set': 'Problem set',
  presentation: 'Presentation',
  other: 'Other'
}

export const STATUS_LABEL: Record<AssignmentSummary['status'], string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  submitted: 'Submitted'
}

/** "Fri 27 Nov, 12:00" */
export function formatDue(iso: string): string {
  const date = zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${date}, ${formatClock(iso)}`
}

/** "in 9 days", "tomorrow", "today", "3 days ago" */
export function relativeDays(iso: string, now: Temporal.Instant): string {
  const days = zoned(now).toPlainDate().until(zoned(iso).toPlainDate()).days
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}
