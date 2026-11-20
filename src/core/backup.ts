// Backups (Phase 9): naming and retention, no I/O. A backup is a folder named by when it was
// made, in London time ("2026-11-18 1430"), so names sort by date.

import { Temporal } from 'temporal-polyfill'
import { startOfWeek, TZ } from './time'

const NAME = /^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})$/

export function backupName(at: Temporal.Instant): string {
  const z = at.toZonedDateTimeISO(TZ)
  return `${z.toPlainDate().toString()} ${String(z.hour).padStart(2, '0')}${String(z.minute).padStart(2, '0')}`
}

/** When a backup was made, from its folder name (null if it isn't a backup folder). */
export function backupTime(name: string): Temporal.ZonedDateTime | null {
  const m = NAME.exec(name)
  if (!m) return null
  try {
    return Temporal.PlainDate.from(m[1]).toZonedDateTime({
      timeZone: TZ,
      plainTime: Temporal.PlainTime.from({ hour: Number(m[2]), minute: Number(m[3]) })
    })
  } catch {
    return null
  }
}

export interface Retention {
  /** Keep the newest backup of each of the last N days. */
  days: number
  /** Then the newest of each of the N weeks before that. */
  weeks: number
}

export const DEFAULT_RETENTION: Retention = { days: 14, weeks: 8 }

/**
 * Which backups to delete: everything except those from the last 24 hours, the newest per day
 * for `days` days and the newest per week for `weeks` weeks after that. The newest backup and
 * any in `protect` (e.g. one being restored) are always kept.
 */
export function backupsToDelete(
  names: string[],
  now: Temporal.Instant,
  keep: Retention = DEFAULT_RETENTION,
  protect: string[] = []
): string[] {
  const dated = names
    .map((name) => ({ name, at: backupTime(name) }))
    .filter((b): b is { name: string; at: Temporal.ZonedDateTime } => b.at !== null)
    .sort((a, b) => Temporal.ZonedDateTime.compare(b.at, a.at))
  if (!dated.length) return []
  const today = now.toZonedDateTimeISO(TZ).toPlainDate()
  const dayCutoff = today.subtract({ days: keep.days - 1 })
  // The weeks are counted back from the week the daily backups stop in.
  const weekCutoff = dayCutoff
    .subtract({ days: dayCutoff.dayOfWeek - 1 })
    .subtract({ weeks: keep.weeks })
  const recent = now.subtract({ hours: 24 })
  const kept = new Set<string>([dated[0].name, ...protect])
  for (const b of dated) {
    if (Temporal.Instant.compare(b.at.toInstant(), recent) >= 0) kept.add(b.name)
  }
  const seen = new Set<string>()
  for (const b of dated) {
    const day = b.at.toPlainDate()
    let bucket: string | null = null
    if (Temporal.PlainDate.compare(day, dayCutoff) >= 0) bucket = `d${day}`
    else if (Temporal.PlainDate.compare(day, weekCutoff) >= 0) {
      bucket = `w${startOfWeek(b.at.toInstant()).toPlainDate()}`
    }
    if (bucket && !seen.has(bucket)) {
      seen.add(bucket)
      kept.add(b.name)
    }
  }
  return dated.filter((b) => !kept.has(b.name)).map((b) => b.name)
}
