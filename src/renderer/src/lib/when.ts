import { Temporal } from 'temporal-polyfill'
import { formatClock, TZ, zoned } from '@core/time'

/** "Today, 14:30", "Yesterday, 09:05", "Mon 17 Nov, 18:00". */
export function when(iso: string): string {
  const date = zoned(iso).toPlainDate()
  const today = Temporal.Now.plainDateISO(TZ)
  const day =
    Temporal.PlainDate.compare(date, today) === 0
      ? 'Today'
      : Temporal.PlainDate.compare(date, today.subtract({ days: 1 })) === 0
        ? 'Yesterday'
        : date.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${formatClock(iso)}`
}
