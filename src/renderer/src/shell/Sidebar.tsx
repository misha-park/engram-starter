import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { createPortal } from 'react-dom'
import type { Deadline } from '@shared/types'
import { atLocalTime, formatClock, toIso, zoned } from '@core/time'
import { useCategories, useDeadlines } from '../lib/queries'
import { useRemembered } from '../lib/remember'
import { Countdown } from './Countdown'
import { TodoList } from './TodoList'
import s from './Sidebar.module.css'

// Home-screen sidebar: mini month, calendar (category) toggles, small todos, deadlines.

interface Props {
  now: Temporal.Instant
  /** The date the main calendar is showing; the mini month follows it. */
  shownDate: Temporal.PlainDate
  onPickDate: (date: Temporal.PlainDate) => void
  hiddenCategories: Set<string>
  onToggleCategory: (id: string) => void
}

export function Sidebar({ now, shownDate, onPickDate, hiddenCategories, onToggleCategory }: Props) {
  const today = zoned(now).toPlainDate()
  return (
    <aside className={s.sidebar}>
      <MiniMonth today={today} shownDate={shownDate} onPickDate={onPickDate} />
      <CalendarsSection hidden={hiddenCategories} onToggle={onToggleCategory} />
      <TodoList today={today} />
      <Countdown today={today} />
    </aside>
  )
}

/** Mini month scrolling: a week's row (26px day + 2px gap), the snap home, the settling. */
const ROW_PX = 28
const ROW_GAP_PX = 2
const SNAP_WEEKS = 1
const SETTLE_AFTER_MS = 160
const GLIDE_MS = 220

/** Weeks shown in the mini calendar: one past week, the anchor week, then four ahead. */
const MINI_WEEKS = 6

/**
 * A rolling mini calendar: the week the main calendar is on is always the second row, so
 * it shows one week of the past and four of the future (the future matters more).
 */
function MiniMonth({
  today,
  shownDate,
  onPickDate
}: {
  today: Temporal.PlainDate
  shownDate: Temporal.PlainDate
  onPickDate: (date: Temporal.PlainDate) => void
}) {
  // Follows the main calendar, but scrolls smoothly (in weeks, fractions while moving); when
  // it comes to rest it settles on a whole week, or back home when within a week of it. The
  // arrows glide 4 weeks.
  const [pos, setPos] = useState(0)
  const posRef = useRef(0)
  useLayoutEffect(() => {
    posRef.current = pos
  })
  const [lastShown, setLastShown] = useState(shownDate.toString())
  if (lastShown !== shownDate.toString()) {
    setLastShown(shownDate.toString())
    setPos(0)
  }
  const whole = Math.floor(pos)
  const frac = pos - whole
  const anchorWeek = shownDate.subtract({ days: shownDate.dayOfWeek - 1 }).add({ weeks: whole })
  const gridStart = anchorWeek.subtract({ weeks: 1 })
  // One extra row below, for the one sliding in.
  const gridEnd = gridStart.add({ weeks: MINI_WEEKS + 1 })
  const lastDay = gridStart.add({ weeks: MINI_WEEKS }).subtract({ days: 1 })
  const thisWeekStart = today.subtract({ days: today.dayOfWeek - 1 })

  const { data: deadlines = [] } = useDeadlines(
    toIso(atLocalTime(gridStart, '00:00')),
    toIso(atLocalTime(gridEnd, '00:00'))
  )
  const deadlinesOn = new Map<string, Deadline[]>()
  for (const d of deadlines) {
    const key = zoned(d.at).toPlainDate().toString()
    deadlinesOn.set(key, [...(deadlinesOn.get(key) ?? []), d])
  }
  // Hovering a day with a red dot shows its deadlines straight away.
  const [tip, setTip] = useState<{ items: Deadline[]; left: number; top: number } | null>(null)

  // Keyboard: the grid is one Tab stop; arrows move a day or a week, Enter shows that date.
  const [cursor, setCursor] = useState<Temporal.PlainDate | null>(null)
  const inGrid = (d: Temporal.PlainDate) =>
    Temporal.PlainDate.compare(d, gridStart) >= 0 && Temporal.PlainDate.compare(d, gridEnd) < 0
  const focusDay = cursor && inGrid(cursor) ? cursor : inGrid(today) ? today : anchorWeek
  const grid = useRef<HTMLDivElement>(null)
  const weeksRef = useRef<HTMLDivElement>(null)

  // Gliding to a position (settling, or the arrows).
  const anim = useRef(0)
  const glideTo = useCallback((target: number) => {
    cancelAnimationFrame(anim.current)
    const from = posRef.current
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / GLIDE_MS)
      const eased = 1 - Math.pow(1 - k, 3)
      setPos(from + (target - from) * eased)
      if (k < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }, [])

  // Scrolling over it moves it by the pixel; it settles once the scrolling stops.
  useEffect(() => {
    const el = weeksRef.current
    if (!el) return
    let settle: ReturnType<typeof setTimeout> | null = null
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
      e.preventDefault()
      cancelAnimationFrame(anim.current)
      const px = e.deltaMode === 1 ? e.deltaY * ROW_PX : e.deltaY
      setPos((p) => p + px / ROW_PX)
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        const p = posRef.current
        glideTo(Math.abs(p) <= SNAP_WEEKS ? 0 : Math.round(p))
      }, SETTLE_AFTER_MS)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (settle) clearTimeout(settle)
      cancelAnimationFrame(anim.current)
    }
  }, [glideTo])
  const onGridKey = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (!step) return
    e.preventDefault()
    const next = focusDay.add({ days: step })
    if (!inGrid(next)) return
    setCursor(next)
    requestAnimationFrame(() =>
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus()
    )
  }

  const title =
    gridStart.month === lastDay.month
      ? gridStart.toLocaleString('en-GB', { month: 'long', year: 'numeric' })
      : gridStart.year === lastDay.year
        ? `${gridStart.toLocaleString('en-GB', { month: 'short' })} – ${lastDay.toLocaleString('en-GB', { month: 'short', year: 'numeric' })}`
        : `${gridStart.toLocaleString('en-GB', { month: 'short', year: 'numeric' })} – ${lastDay.toLocaleString('en-GB', { month: 'short', year: 'numeric' })}`

  return (
    <section className={s.month}>
      <div className={s.monthHeader}>
        <span className={s.monthTitle}>{title}</span>
        <button className={s.monthNav} onClick={() => glideTo(Math.round(pos) - 4)} title="Earlier">
          <ChevronLeft size={14} />
        </button>
        <button className={s.monthNav} onClick={() => glideTo(Math.round(pos) + 4)} title="Later">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className={s.monthGrid}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className={s.weekday}>
            {d}
          </span>
        ))}
      </div>
      <div
        className={s.weeksWindow}
        ref={weeksRef}
        onWheel={() => setTip(null)}
        style={{ height: MINI_WEEKS * ROW_PX - ROW_GAP_PX }}
      >
        <div
          className={`${s.monthGrid} ${s.weeksTrack}`}
          ref={grid}
          onKeyDown={onGridKey}
          style={{ transform: frac ? `translateY(${-frac * ROW_PX}px)` : undefined }}
        >
          {Array.from({ length: MINI_WEEKS + 1 }, (_, w) => {
            const weekStart = gridStart.add({ weeks: w })
            return (
              <div
                key={weekStart.toString()}
                className={s.week}
                data-current={weekStart.equals(thisWeekStart) || undefined}
              >
                {Array.from({ length: 7 }, (_, d) => {
                  const date = weekStart.add({ days: d })
                  const due = deadlinesOn.get(date.toString())
                  return (
                    <button
                      key={d}
                      className={`${s.date} num`}
                      data-past={Temporal.PlainDate.compare(date, today) < 0 || undefined}
                      data-today={date.equals(today) || undefined}
                      data-month-start={date.day === 1 || undefined}
                      data-date={date.toString()}
                      data-mini-date={date.toString()}
                      tabIndex={date.equals(focusDay) ? 0 : -1}
                      aria-label={
                        date.toLocaleString('en-GB', {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long'
                        }) + (due ? `, due: ${due.map((x) => x.title).join(', ')}` : '')
                      }
                      onClick={() => onPickDate(date)}
                      onMouseEnter={(e) => {
                        if (!due) return setTip(null)
                        const r = e.currentTarget.getBoundingClientRect()
                        // Kept clear of the window's left edge (the card is centred on the day).
                        const left = Math.max(r.left + r.width / 2, 150)
                        setTip({ items: due, left, top: r.bottom + 4 })
                      }}
                      onMouseLeave={() => setTip(null)}
                    >
                      {date.day === 1 ? date.toLocaleString('en-GB', { month: 'short' }) : date.day}
                      {due && <span className={s.dot} />}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      {tip &&
        createPortal(
          <div className={s.dayTip} style={{ left: tip.left, top: tip.top }} role="tooltip">
            {tip.items.map((d) => (
              <div key={`${d.kind}:${d.id}`} className={s.dayTipRow}>
                <span className={s.dayTipTitle}>{d.title}</span>
                <span className={`${s.dayTipWhen} num`}>
                  {d.kind === 'todo' ? 'Todo' : formatClock(d.at)}
                </span>
              </div>
            ))}
          </div>,
          document.body
        )}
    </section>
  )
}

function CalendarsSection({
  hidden,
  onToggle
}: {
  hidden: Set<string>
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useRemembered('sidebar.calendarsOpen', false)
  const { data: categories = [] } = useCategories()

  return (
    <section className={s.section}>
      <button className={s.sectionHeader} onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Calendars
        {hidden.size > 0 && <span className={s.count}>{hidden.size} hidden</span>}
      </button>
      {open && (
        <ul className={s.list}>
          {categories.map((c) => (
            <li key={c.id}>
              <label className={s.toggle} style={{ '--cat': c.colour } as CSSProperties}>
                <input
                  type="checkbox"
                  checked={!hidden.has(c.id)}
                  onChange={() => onToggle(c.id)}
                />
                <span className={s.check} />
                <span className={s.itemLabel}>{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
