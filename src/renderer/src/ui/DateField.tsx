import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { TZ } from '@core/time'
import f from './fields.module.css'

interface Props {
  /** Local date, YYYY-MM-DD */
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  className?: string
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** A date field with a calendar popover in the app's own style (replaces the native picker). */
export function DateField({ value, onChange, ariaLabel = 'Date', className }: Props) {
  const today = Temporal.Now.plainDateISO(TZ)
  const selected = safeDate(value) ?? today
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(selected.with({ day: 1 }))
  const [focus, setFocus] = useState(selected)
  const [up, setUp] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) =>
      root.current && !root.current.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep keyboard focus on the focused day while open.
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus()
  }, [open, focus])

  const toggle = () => {
    if (!open) {
      setMonth(selected.with({ day: 1 }))
      setFocus(selected)
      const rect = root.current?.getBoundingClientRect()
      setUp(!!rect && window.innerHeight - rect.bottom < 330 && rect.top > 330)
    }
    setOpen((o) => !o)
  }
  const pick = (d: Temporal.PlainDate) => {
    onChange(d.toString())
    setOpen(false)
  }
  const moveFocus = (d: Temporal.PlainDate) => {
    setFocus(d)
    if (d.month !== month.month || d.year !== month.year) setMonth(d.with({ day: 1 }))
  }
  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, Temporal.DurationLike> = {
      ArrowLeft: { days: -1 },
      ArrowRight: { days: 1 },
      ArrowUp: { days: -7 },
      ArrowDown: { days: 7 },
      PageUp: { months: -1 },
      PageDown: { months: 1 }
    }
    if (step[e.key]) {
      e.preventDefault()
      moveFocus(focus.add(step[e.key]))
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
    }
  }

  const gridStart = month.subtract({ days: month.dayOfWeek - 1 })
  const days = Array.from({ length: 42 }, (_, i) => gridStart.add({ days: i }))

  return (
    <div className={`${f.root} ${className ?? ''}`} ref={root}>
      <button
        type="button"
        className={f.field}
        onClick={toggle}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <span className="num">
          {selected.toLocaleString('en-GB', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          })}
        </span>
        <CalendarDays size={14} className={f.icon} />
      </button>
      {open && (
        <div
          className={f.popover}
          data-up={up || undefined}
          role="dialog"
          aria-label={`${ariaLabel}: choose a date`}
          onKeyDown={onKey}
        >
          <div className={f.calHeader}>
            <span className={f.calTitle}>
              {month.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}
            </span>
            <button
              type="button"
              className={f.nav}
              onClick={() => setMonth(month.subtract({ months: 1 }))}
              title="Previous month"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className={f.nav}
              onClick={() => setMonth(month.add({ months: 1 }))}
              title="Next month"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className={f.calGrid} ref={grid}>
            {WEEKDAYS.map((w, i) => (
              <span key={i} className={f.weekday}>
                {w}
              </span>
            ))}
            {days.map((d) => (
              <button
                type="button"
                key={d.toString()}
                data-date={d.toString()}
                className={`${f.day} num`}
                data-outside={d.month !== month.month || undefined}
                data-past={Temporal.PlainDate.compare(d, today) < 0 || undefined}
                data-today={d.equals(today) || undefined}
                data-selected={d.equals(selected) || undefined}
                tabIndex={d.equals(focus) ? 0 : -1}
                onClick={() => pick(d)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), pick(d))}
              >
                {d.day}
              </button>
            ))}
          </div>
          <div className={f.calFooter}>
            <button type="button" className={f.link} onClick={() => pick(today)}>
              Today
            </button>
            <button type="button" className={f.link} onClick={() => pick(today.add({ days: 1 }))}>
              Tomorrow
            </button>
            <button type="button" className={f.link} onClick={() => pick(today.add({ weeks: 1 }))}>
              In a week
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function safeDate(v: string): Temporal.PlainDate | null {
  try {
    return Temporal.PlainDate.from(v)
  } catch {
    return null
  }
}
