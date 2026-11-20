import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FullCalendar, {
  type CalendarController,
  type DatesSetInfo,
  type DropInfo,
  type EventClickInfo,
  type EventDropInfo,
  type EventInput,
  type EventResizeDoneInfo
} from '@fullcalendar/react'
import themePlugin from '@fullcalendar/react/themes/forma'
import timeGridPlugin from '@fullcalendar/react/timegrid'
import dayGridPlugin from '@fullcalendar/react/daygrid'
import interactionPlugin from '@fullcalendar/react/interaction'
import '@fullcalendar/react/skeleton.css'
import '@fullcalendar/react/themes/forma/theme.css'
import './fc-theme.css'
import type { BatchSummary, Block, Category, Deadline, LinkedEventView } from '@shared/types'
import { isUserMovable } from '@core/blocks'
import { toBusinessHours } from '@core/availability'
import { UCL_TERMS } from '@core/terms'
import { atLocalTime, toIso, TZ, zoned } from '@core/time'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useAvailability, useMoveBlock, useSetTodoDone } from '../lib/queries'
import { call } from '../lib/api'
import { pushUndo } from '../ui/undoStore'
import { toast } from '../ui/toastStore'
import { blockName } from '../lib/blockName'
import { copiedIntoEngram } from '@core/linked-events'
import { remember, remembered } from '../lib/remember'
import { EventContent, type EventProps } from './EventContent'
import { fcToIso } from './dates'
import s from './Calendar.module.css'

interface Props {
  controller: CalendarController
  blocks: Block[]
  deadlines: Deadline[]
  /** Events of linked calendars (iCloud…): shown for reference, never planned around. */
  linkedEvents?: LinkedEventView[]
  /** Right-click on one of them. */
  onLinkedMenu?: (event: LinkedEventView, e: React.MouseEvent) => void
  /** Double-click on one of them: add it to Engram by hand. */
  onAddLinked?: (event: { title: string; start: string; end: string; allDay: boolean }) => void
  categories: Category[]
  hiddenCategories: Set<string>
  onRangeChange: (range: { start: string; end: string }) => void
  onOpenBlock: (block: Block) => void
  /** Dragging over empty time: add an event there. */
  onSelectTime?: (range: { start: string; end: string }) => void
  /** Accept items dragged in from outside (e.g. the Backlog list). */
  onExternalDrop?: (draggedEl: HTMLElement, startIso: string) => void
  /** An assistant change waiting for review: highlight it and show where blocks were. */
  review?: BatchSummary | null
  /** Right-click on a block. */
  /** Right-click (with the blocks selected by Shift-click, when this is one of them). */
  onBlockMenu?: (block: Block, e: React.MouseEvent, selection: Block[]) => void
  /** The Delete key on a focused block. */
  onBlockDelete?: (block: Block) => void
  /** Month view: the first date in the week at the top of the scroll (for titles). */
  onVisibleDate?: (date: string) => void
  /** Right-click on empty time: the half hour under the pointer (UTC ISO). */
  onSlotMenu?: (startIso: string, e: React.MouseEvent) => void
  /** A block to highlight (just moved). */
  focusId?: string | null
  /** A block dragged out of the calendar onto a day elsewhere (the mini month). */
  onDropOnDate?: (block: Block, date: string) => void
  /**
   * Keep the view (week, day, month) and the hour scrolled to across launches, under this name
   * (lib/remember). The date shown isn't kept: it always opens on today.
   */
  rememberAs?: string
}

/** The grid starts at 07:00 but opens at 08:30; stopping just above 08:30 snaps back to it. */
const DAY_START = '07:00:00'
const OPEN_AT = '08:30:00'
const OPEN_AT_MINUTES = 90 // 08:30 is 90 minutes after DAY_START
const DAY_START_MINUTES = 7 * 60
const GRID_MINUTES = 17 * 60 // 07:00–24:00
const SNAP_WITHIN_MINUTES = 45

/** Move other times by the same number of days and minutes as `from` → `to` (wall clock). */
function wallClockShift(from: string, to: string) {
  const a = zoned(from)
  const b = zoned(to)
  const days = a.toPlainDate().until(b.toPlainDate()).days
  const minutes = b.hour * 60 + b.minute - (a.hour * 60 + a.minute)
  return (iso: string) => toIso(zoned(iso).add({ days }).add({ minutes }))
}

/** The nearest ancestor that scrolls vertically. */
function findScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

/** How close to the calendar's side a dragged block must be, and how long it waits there. */
const EDGE_PX = 48
const EDGE_DELAY_MS = 700
const EDGE_REPEAT_MS = 1100

/**
 * Two-finger swipes between weeks and days. The page follows the fingers one to one and only
 * settles once they stop. A trackpad doesn't say when the fingers lift, so "stopped" is a pause
 * in the wheel events, judged by how the swipe went:
 *  - a flick (a big step then the long tail of small steps that is the trackpad's momentum, so
 *    the fingers are gone) always goes on to the next week, however far the momentum happened
 *    to carry it, and settles at once;
 *  - a slow drag goes on if it passed halfway, otherwise back, after a long pause, so holding
 *    still to read the next week isn't cut short.
 */
const SWIPE_START_PX = 10
const SWIPE_COMMIT = 0.5
const SWIPE_FLICK_STEP = 8 // px: the biggest step must have been at least this
const SWIPE_TAIL_STEPS = 8 // small steps in a row after it
const SWIPE_FLICK_MIN = 0.06 // share of the width a flick must have moved
const SWIPE_REST_MS = 2000
const SWIPE_FLICK_REST_MS = 100
/** Momentum after a swipe is ignored while it keeps dying away (a gap this long ends it). */
const TAIL_GAP_MS = 250
const TAIL_MAX_MS = 6000
const SWIPE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Drawing a new block: press and hold this long, then drag. (A double click makes one too.) */
const DRAW_HOLD_MS = 350

/** Weeks in the scrolling month view. */
const MONTH_WEEKS = 40

/** Not a new array on every render. */
const NO_LINKED: LinkedEventView[] = []

const PLUGINS = [themePlugin, timeGridPlugin, dayGridPlugin, interactionPlugin]
const HOUR_FORMAT = { hour: '2-digit', minute: '2-digit', hour12: false } as const
const VIEWS = {
  timeGridWeek: { dayHeaderFormat: { weekday: 'short', day: 'numeric' } },
  timeGridDay: { dayHeaderFormat: { weekday: 'long', day: 'numeric', month: 'long' } },
  // "Month" is one long grid of weeks you scroll through (from a week back, most of a year);
  // the first of each month is labelled in its cell.
  dayGridMonth: {
    dayHeaderFormat: { weekday: 'short' } as const,
    duration: { weeks: MONTH_WEEKS },
    dateIncrement: { weeks: 4 },
    monthStartFormat: { month: 'short', day: 'numeric' } as const
  }
} as const

export function PlannerCalendar({
  controller,
  blocks,
  deadlines,
  linkedEvents = NO_LINKED,
  onLinkedMenu,
  onAddLinked,
  categories,
  hiddenCategories,
  onRangeChange,
  onOpenBlock,
  onSelectTime,
  onExternalDrop,
  review,
  onBlockMenu,
  onBlockDelete,
  onVisibleDate,
  onSlotMenu,
  focusId,
  onDropOnDate,
  rememberAs
}: Props) {
  const { data: availability } = useAvailability()
  const move = useMoveBlock()
  const qc = useQueryClient()
  const setTodoDone = useSetTodoDone()
  const [error, setError] = useState<string | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  // What was kept from last time (rememberAs): the view to open in and the hour to scroll to.
  const [kept] = useState(() => {
    if (!rememberAs) return null
    const view = remembered<string>(`${rememberAs}.view`, 'timeGridWeek')
    return {
      view: view in VIEWS ? (view as keyof typeof VIEWS) : 'timeGridWeek',
      scroll: remembered<string | null>(`${rememberAs}.scroll`, null)
    }
  })
  const scrollRestored = useRef(false)
  // Shift-click selects several movable blocks; dragging one of them moves them all.
  // Kept as the blocks themselves: they may be in a week no longer on screen.
  const [selected, setSelected] = useState<Map<string, Block>>(new Map())
  // Current times where the calendar has them (the kept copy may be from before a move).
  const onScreen = new Map(blocks.map((b) => [b.id, b]))
  const selection = [...selected.values()].map((b) => onScreen.get(b.id) ?? b)
  const selectionFor = (b: Block) => (selected.has(b.id) && selected.size > 1 ? selection : [])
  useEffect(() => {
    if (!selected.size) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(new Map())
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  // Snap back to 08:30 when a scroll comes to rest just above it (the early hours stay
  // reachable by scrolling further up). Only the time grid's vertical scroller is affected.
  useEffect(() => {
    const el = wrapper.current
    if (!el) return
    const onScrollEnd = (e: Event) => {
      const scroller = e.target as HTMLElement
      if (!(scroller instanceof HTMLElement) || !controller.view?.type.startsWith('timeGrid'))
        return
      if (scroller.scrollHeight <= scroller.clientHeight) return
      const perMinute = scroller.scrollHeight / GRID_MINUTES
      const openAt = OPEN_AT_MINUTES * perMinute
      const top = scroller.scrollTop
      if (top < openAt - 1 && top > openAt - SNAP_WITHIN_MINUTES * perMinute) {
        scroller.scrollTo({ top: openAt, behavior: 'smooth' })
        return
      }
      // Keep the hour at the top for next launch (rememberAs).
      if (rememberAs) {
        const minutes = DAY_START_MINUTES + Math.round(top / perMinute)
        const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
        const mm = String(minutes % 60).padStart(2, '0')
        remember(`${rememberAs}.scroll`, `${hh}:${mm}:00`)
      }
    }
    el.addEventListener('scrollend', onScrollEnd, true)
    return () => el.removeEventListener('scrollend', onScrollEnd, true)
  }, [controller, rememberAs])

  // Dragging a block to the left or right edge and holding it there goes to the previous or
  // next week (or day, or month) after a moment, so it can be dropped in another week.
  const [edge, setEdge] = useState<'left' | 'right' | null>(null)
  const dragging = useRef(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let side: 'left' | 'right' | null = null
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !wrapper.current) return
      const r = wrapper.current.getBoundingClientRect()
      const next =
        e.clientX < r.left + EDGE_PX ? 'left' : e.clientX > r.right - EDGE_PX ? 'right' : null
      if (next === side) return
      side = next
      setEdge(next)
      if (timer) clearTimeout(timer)
      timer = null
      const flip = () => {
        if (!dragging.current || !side) return
        if (side === 'left') controller.prev()
        else controller.next()
        // Keep going while it's held there.
        timer = setTimeout(flip, EDGE_REPEAT_MS)
      }
      if (next) timer = setTimeout(flip, EDGE_DELAY_MS)
    }
    const stop = () => {
      if (timer) clearTimeout(timer)
      timer = null
      side = null
      setEdge(null)
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', stop, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', stop, true)
      stop()
    }
  }, [controller])

  // Two-finger swipes in the week and day views. The next (or previous) week slides in beside
  // this one as the fingers move: a still copy of the current week is left behind and the real
  // calendar moves on to the next week underneath, so both are on screen at once. Everything
  // here moves through refs and transforms, never React state, so it stays smooth.
  const slideEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrapper.current
    const live = slideEl.current
    if (!el || !live) return
    let x = 0
    let width = 0
    let swipe: { forward: boolean; ghost: HTMLElement } | null = null
    let busy = false
    let tail: { at: number; mag: number; since: number } | null = null
    // How the swipe has gone: its biggest step, and the run of small steps that follows.
    let peakStep = 0
    let lowRun = 0
    let flicked = false
    let idle: ReturnType<typeof setTimeout> | null = null
    let settle: ReturnType<typeof setTimeout> | null = null
    let frame = 0

    const paint = () => {
      frame = 0
      if (!swipe) return
      swipe.ghost.style.transform = `translate3d(${x}px,0,0)`
      live.style.transform = `translate3d(${x + (swipe.forward ? width : -width)}px,0,0)`
    }
    const schedulePaint = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    const begin = (forward: boolean) => {
      width = el.clientWidth
      const ghost = live.cloneNode(true) as HTMLElement
      ghost.classList.add(s.ghost)
      ghost.setAttribute('aria-hidden', 'true')
      ghost.setAttribute('inert', '')
      el.insertBefore(ghost, live)
      // The copy keeps the hour the grid is scrolled to.
      const from = live.querySelectorAll<HTMLElement>('*')
      const to = ghost.querySelectorAll<HTMLElement>('*')
      from.forEach((node, i) => {
        if (node.scrollTop || node.scrollLeft) {
          to[i].scrollTop = node.scrollTop
          to[i].scrollLeft = node.scrollLeft
        }
      })
      swipe = { forward, ghost }
      live.style.willChange = 'transform'
      ghost.style.willChange = 'transform'
      // Move the real calendar out of the way before it changes week, so it never flashes.
      paint()
      if (forward) controller.next()
      else controller.prev()
    }

    const cleanUp = () => {
      if (!swipe) return
      swipe.ghost.remove()
      swipe = null
      live.style.transition = ''
      live.style.transform = ''
      live.style.willChange = ''
      x = 0
      busy = false
      peakStep = 0
      lowRun = 0
      flicked = false
    }

    /** Carry on to the next week (`commit`), or put this one back. */
    const finish = (commit: boolean, instant = false) => {
      if (!swipe) return
      if (idle) clearTimeout(idle)
      idle = null
      busy = true
      const { forward, ghost } = swipe
      const target = commit ? (forward ? -width : width) : 0
      const ms = instant ? 0 : Math.round(200 + 220 * (Math.abs(target - x) / width))
      const transition = ms ? `transform ${ms}ms ${SWIPE_EASE}` : ''
      ghost.style.transition = transition
      live.style.transition = transition
      x = target
      paint()
      settle = setTimeout(() => {
        settle = null
        if (commit) return cleanUp()
        // The calendar is on the other week, out of sight: bring it back, then reveal it.
        if (forward) controller.prev()
        else controller.next()
        settle = setTimeout(() => {
          settle = null
          cleanUp()
        }, 90)
      }, ms + 30)
    }

    const onWheel = (e: WheelEvent) => {
      if (!controller.view?.type.startsWith('timeGrid') || dragging.current || e.ctrlKey) return
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()
      const now = performance.now()
      // While a week is sliding, and for the swipe's trailing momentum, nothing more happens.
      // Momentum only fades, so a jump up in size (or a pause) means a new swipe has started.
      const mag = Math.abs(e.deltaX)
      if (busy) {
        tail = { at: now, mag, since: tail?.since ?? now }
        return
      }
      if (tail) {
        if (
          now - tail.since < TAIL_MAX_MS &&
          now - tail.at < TAIL_GAP_MS &&
          mag <= tail.mag * 1.8 + 8
        ) {
          tail.at = now
          tail.mag = mag
          return
        }
        tail = null
      }
      width = swipe ? width : el.clientWidth
      x = Math.max(-width, Math.min(width, x - e.deltaX))
      if (!swipe) {
        if (Math.abs(x) < SWIPE_START_PX) {
          // Fingers resting or jittering sideways: nothing to show yet.
          if (idle) clearTimeout(idle)
          idle = setTimeout(() => (x = 0), 140)
          return
        }
        begin(x < 0)
      }
      // Back through the start and out the other side: nothing here to carry on from.
      if (swipe && (swipe.forward ? x > 0 : x < 0)) {
        x = 0
        paint()
        finish(false, true)
        return
      }
      schedulePaint()
      if (idle) clearTimeout(idle)
      // All the way across (momentum carried it): nothing left to decide.
      if (Math.abs(x) >= width) return finish(true)
      // Momentum is a long tail of small steps after a big one; a hand coming to rest isn't.
      if (mag > peakStep) {
        peakStep = mag
        lowRun = 0
      } else if (peakStep >= SWIPE_FLICK_STEP && mag <= Math.max(3, peakStep * 0.2)) {
        if (++lowRun >= SWIPE_TAIL_STEPS) flicked = true
      } else {
        lowRun = 0
      }
      // The fingers have stopped: after a flick it goes on to the next week, after a slow drag
      // only if past halfway.
      idle = setTimeout(
        () => {
          const flick = flicked && Math.abs(x) > width * SWIPE_FLICK_MIN
          finish(flick || Math.abs(x) > width * SWIPE_COMMIT)
        },
        flicked ? SWIPE_FLICK_REST_MS : SWIPE_REST_MS
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (idle) clearTimeout(idle)
      if (settle) clearTimeout(settle)
      cancelAnimationFrame(frame)
      cleanUp()
    }
  }, [controller])

  // The scrolling month view: report the week at the top as it scrolls.
  const reportTop = useCallback(() => {
    const el = wrapper.current
    if (!el || !onVisibleDate || controller.view?.type !== 'dayGridMonth') return
    const cells = [...el.querySelectorAll<HTMLElement>('[role=cell][data-date]')]
    const scroller = cells[0] ? findScroller(cells[0]) : null
    const top = (scroller ?? el).getBoundingClientRect().top + 40
    const first = cells.find((c) => c.getBoundingClientRect().bottom > top)
    const date = first?.getAttribute('data-date')
    if (date) onVisibleDate(date.slice(0, 10))
  }, [controller, onVisibleDate])
  useEffect(() => {
    const el = wrapper.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(reportTop)
    }
    el.addEventListener('scroll', onScroll, true)
    return () => {
      el.removeEventListener('scroll', onScroll, true)
      cancelAnimationFrame(frame)
    }
  }, [reportTop])

  const events = useMemo<EventInput[]>(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    const visible = (categoryId: string | null) => !categoryId || !hiddenCategories.has(categoryId)
    const reviewed = new Set(review?.blocks.filter((c) => c.after).map((c) => c.blockId))
    const blockEvents = blocks
      .filter((b) => visible(b.categoryId))
      .map((b): EventInput => {
        const cat = b.categoryId ? byId.get(b.categoryId) : undefined
        const props: EventProps = {
          kind: 'block',
          block: b,
          colour: b.colour ?? cat?.colour,
          label: cat?.shortLabel,
          review: reviewed.has(b.id),
          focus: b.id === focusId,
          selected: selected.has(b.id)
        }
        return {
          id: b.id,
          title: b.title,
          start: b.start,
          end: b.end,
          editable: isUserMovable(b),
          color: 'transparent',
          className: s.fcEvent,
          extendedProps: props
        }
      })
    const deadlineEvents = deadlines
      .filter((d) => visible(d.categoryId))
      .map((d): EventInput => {
        const props: EventProps = {
          kind: 'deadline',
          deadline: d,
          colour: d.categoryId ? byId.get(d.categoryId)?.colour : undefined
        }
        return {
          id: `deadline-${d.id}`,
          title: d.title,
          start: zoned(d.at).toPlainDate().toString(),
          allDay: true,
          editable: false,
          color: 'transparent',
          className: s.fcEvent,
          extendedProps: props
        }
      })
    // Term starts and ends (UCL's dates), as quiet markers in the all-day row.
    const termEvents = UCL_TERMS.flatMap((t): EventInput[] =>
      (
        [
          [t.start, `${t.name} starts`],
          [t.end, `${t.name} ends`]
        ] as const
      ).map(([date, title]) => ({
        id: `term-${date}`,
        title,
        start: date,
        allDay: true,
        editable: false,
        color: 'transparent',
        className: s.fcEvent,
        extendedProps: { kind: 'term', title } satisfies EventProps
      }))
    )
    const colourOf = (id: string) => {
      const b = blocks.find((x) => x.id === id)
      return b?.colour ?? (b?.categoryId ? byId.get(b.categoryId)?.colour : undefined)
    }
    const ghostEvents = (review?.blocks ?? [])
      .filter(
        (c) =>
          c.before && (!c.after || c.after.start !== c.before.start || c.after.end !== c.before.end)
      )
      .map((c): EventInput => ({
        id: `ghost-${c.blockId}`,
        title: c.before!.title,
        start: c.before!.start,
        end: c.before!.end,
        editable: false,
        color: 'transparent',
        className: s.fcEvent,
        extendedProps: { kind: 'ghost', title: c.before!.title, colour: colourOf(c.blockId) }
      }))
    // A linked calendar's toggle in the Calendars list hides its events (the id is the category's).
    // One you've already added to Engram drops off, so what's left is what still needs adding.
    const linkedFcEvents = linkedEvents
      .filter((e) => visible(e.calendarId) && !copiedIntoEngram(e, blocks))
      .map((e): EventInput => {
        const props: EventProps = {
          kind: 'linked',
          id: e.id,
          title: e.title,
          calendar: e.calendar,
          colour: e.colour,
          allDay: e.allDay,
          start: e.start,
          end: e.end
        }
        return {
          id: `linked-${e.id}`,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          editable: false,
          color: 'transparent',
          className: s.fcEvent,
          extendedProps: props
        }
      })
    return [...termEvents, ...linkedFcEvents, ...deadlineEvents, ...blockEvents, ...ghostEvents]
  }, [blocks, deadlines, linkedEvents, categories, hiddenCategories, review, focusId, selected])

  const businessHours = useMemo(
    () => (availability ? toBusinessHours(availability) : false),
    [availability]
  )

  const handleChange = useCallback(
    (info: EventDropInfo | EventResizeDoneInfo) => {
      const ev = info.event
      if (ev.allDay || !ev.endStr) {
        info.revert()
        return
      }
      const before = info.oldEvent
      // Dragging one of several selected blocks moves the rest by the same days and time.
      const others =
        'delta' in info && selected.has(ev.id) && selected.size > 1
          ? selection.filter((b) => b.id !== ev.id && isUserMovable(b))
          : []
      move.mutate(
        { id: ev.id, start: fcToIso(ev.startStr), end: fcToIso(ev.endStr) },
        {
          onSuccess: async () => {
            if (!before.endStr) return
            const props = ev.extendedProps as EventProps
            const name = props.kind === 'block' ? blockName(props.block) : ev.title
            if (!others.length) {
              pushUndo(`${'delta' in info ? 'Moved' : 'Resized'} “${name}”.`, async () => {
                await call('blocks:move', ev.id, fcToIso(before.startStr), fcToIso(before.endStr))
                await qc.invalidateQueries()
              })
              return
            }
            const shift = wallClockShift(fcToIso(before.startStr), fcToIso(ev.startStr))
            const moved: Block[] = []
            for (const b of others) {
              try {
                const next = { start: shift(b.start), end: shift(b.end) }
                await call('blocks:move', b.id, next.start, next.end)
                moved.push(b)
              } catch {
                // One that can't move (e.g. now fixed) stays where it was.
              }
            }
            // Keep the selection's times current for the next move.
            setSelected((prev) => {
              const next = new Map(prev)
              for (const b of moved)
                next.set(b.id, { ...b, start: shift(b.start), end: shift(b.end) })
              return next
            })
            await qc.invalidateQueries()
            const count = moved.length + 1
            pushUndo(`Moved ${count} blocks.`, async () => {
              await call('blocks:move', ev.id, fcToIso(before.startStr), fcToIso(before.endStr))
              for (const b of moved) await call('blocks:move', b.id, b.start, b.end)
              await qc.invalidateQueries()
            })
            toast(`Moved ${count} blocks.`, {
              action: {
                label: 'Undo',
                run: async () => {
                  await call('blocks:move', ev.id, fcToIso(before.startStr), fcToIso(before.endStr))
                  for (const b of moved) await call('blocks:move', b.id, b.start, b.end)
                  await qc.invalidateQueries()
                }
              }
            })
          },
          onError: (e) => {
            info.revert()
            setError(
              e instanceof Error
                ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
                : String(e)
            )
            setTimeout(() => setError(null), 4000)
          }
        }
      )
    },
    [move, qc, selected, selection]
  )

  const handleClick = useCallback(
    (info: EventClickInfo) => {
      const props = info.event.extendedProps as EventProps
      if (props.kind === 'linked') {
        if (info.jsEvent.detail >= 2) onAddLinked?.(props)
        return
      }
      if (props.kind !== 'block') return
      const { block } = props
      const onDot = (info.jsEvent.target as Element | null)?.closest('[data-todo-check]')
      if (onDot && block.linkedType === 'todo' && block.linkedId) {
        setTodoDone.mutate({ id: block.linkedId, done: block.outcome !== 'done' })
        return
      }
      // A click selects or deselects the block; a double click opens it (and leaves the
      // selection as it was before the first click).
      const toggle = () =>
        setSelected((prev) => {
          const next = new Map(prev)
          if (next.has(block.id)) next.delete(block.id)
          else next.set(block.id, block)
          return next
        })
      toggle()
      if (info.jsEvent.detail >= 2) onOpenBlock(block)
    },
    [onOpenBlock, onAddLinked, setTodoDone]
  )

  const handleDrop = useCallback(
    (info: DropInfo) => {
      if (info.allDay || !onExternalDrop || !info.draggedEl) return
      onExternalDrop(info.draggedEl, fcToIso(info.dateStr))
    },
    [onExternalDrop]
  )

  const handleDates = useCallback(
    (info: DatesSetInfo) => {
      onRangeChange({ start: fcToIso(info.startStr), end: fcToIso(info.endStr) })
      // The weeks (or days) either side are loaded already, so a swipe slides onto full days.
      if (info.view.type.startsWith('timeGrid')) {
        const step = info.view.type === 'timeGridDay' ? 1 : 7
        const shift = (iso: string, days: number) => toIso(zoned(iso).add({ days }).toInstant())
        const start = fcToIso(info.startStr)
        const end = fcToIso(info.endStr)
        for (const days of [-step, step]) {
          const a = shift(start, days)
          const b = shift(end, days)
          void qc.prefetchQuery({
            queryKey: ['blocks', a, b],
            queryFn: () => call('blocks:listInRange', a, b)
          })
          void qc.prefetchQuery({
            queryKey: ['deadlines', a, b],
            queryFn: () => call('deadlines:listInRange', a, b)
          })
          void qc.prefetchQuery({
            queryKey: ['linkedEvents', a, b],
            queryFn: () => call('calendars:listEvents', a, b)
          })
        }
      }
      // After the new range has rendered.
      requestAnimationFrame(reportTop)
      if (rememberAs) {
        remember(`${rememberAs}.view`, info.view.type)
        // Once, at the start: back to the hour that was at the top last time.
        if (!scrollRestored.current) {
          scrollRestored.current = true
          const hour = kept?.scroll
          const api = info.view.calendar
          if (hour && info.view.type.startsWith('timeGrid'))
            requestAnimationFrame(() => api.scrollToTime(hour))
        }
      }
    },
    [onRangeChange, reportTop, rememberAs, kept, qc]
  )

  // Drawing a new block takes a press and hold first; this is when the press began.
  const pressedAt = useRef(0)
  /** The day and half-hour row under the pointer, if it's over empty time. */
  const slotAt = (x: number, y: number) => {
    const stack = document.elementsFromPoint(x, y)
    const date = stack.find((el) => el.getAttribute('role') === 'cell')?.getAttribute('data-date')
    const time = stack.find((el) => el.hasAttribute('data-time'))?.getAttribute('data-time')
    return date && time ? toIso(atLocalTime(date, time.slice(0, 5))) : null
  }

  return (
    <div
      className={`planner-calendar ${s.calendar}`}
      ref={wrapper}
      onMouseDownCapture={() => (pressedAt.current = performance.now())}
      onDoubleClick={(e) => {
        // A double click on empty time makes a new block there.
        if (!onSelectTime || (e.target as Element).closest('[data-block-id], [data-linked-id]'))
          return
        if (!controller.view?.type.startsWith('timeGrid')) return
        const start = slotAt(e.clientX, e.clientY)
        if (start)
          onSelectTime({ start, end: toIso(zoned(start).add({ minutes: 30 }).toInstant()) })
      }}
      onClick={(e) => {
        // A click on empty space (not a block) clears the selection.
        if (!(e.target as Element).closest('[data-block-id]') && selected.size)
          setSelected(new Map())
      }}
      onContextMenu={(e) => {
        const id = (e.target as Element).closest('[data-block-id]')?.getAttribute('data-block-id')
        const block = id ? blocks.find((b) => b.id === id) : undefined
        if (block && onBlockMenu) return onBlockMenu(block, e, selectionFor(block))
        const linkedId = (e.target as Element)
          .closest('[data-linked-id]')
          ?.getAttribute('data-linked-id')
        const linked = linkedId ? linkedEvents.find((x) => x.id === linkedId) : undefined
        if (linked && onLinkedMenu) return onLinkedMenu(linked, e)
        if (id || !onSlotMenu) return
        // Empty time: the day column and the half-hour row under the pointer.
        const stack = document.elementsFromPoint(e.clientX, e.clientY)
        const date = stack
          .find((el) => el.getAttribute('role') === 'cell')
          ?.getAttribute('data-date')
        const time = stack.find((el) => el.hasAttribute('data-time'))?.getAttribute('data-time')
        if (date && time) onSlotMenu(toIso(atLocalTime(date, time.slice(0, 5))), e)
      }}
      onKeyDown={(e) => {
        // Keyboard: Enter opens a focused block; Shift+F10 or the menu key opens its menu;
        // Delete (or Backspace) deletes it.
        const el = (e.target as Element).closest('[data-block-id]')
        const block = el ? blocks.find((b) => b.id === el.getAttribute('data-block-id')) : undefined
        if (!el || !block) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenBlock(block)
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && onBlockDelete) {
          e.preventDefault()
          onBlockDelete(block)
        } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
          const r = el.getBoundingClientRect()
          onBlockMenu?.(
            block,
            {
              clientX: r.left + 12,
              clientY: r.top + 12,
              preventDefault: () => e.preventDefault(),
              stopPropagation: () => e.stopPropagation()
            } as unknown as React.MouseEvent,
            selectionFor(block)
          )
        }
      }}
    >
      {edge && (
        <div className={s.edgeHint} data-side={edge} aria-hidden>
          {edge === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
        </div>
      )}
      {error && (
        <div className={s.error} role="alert">
          {error}
        </div>
      )}
      <div className={s.slide} ref={slideEl}>
        <FullCalendar
          plugins={PLUGINS}
          controller={controller}
          initialView={kept?.view ?? 'timeGridWeek'}
          views={VIEWS}
          timeZone={TZ}
          firstDay={1}
          colorScheme="dark"
          height="100%"
          nowIndicator
          navLinks
          allDaySlot
          slotMinTime={DAY_START}
          scrollTime={OPEN_AT}
          slotDuration="00:30:00"
          snapDuration="00:15:00"
          slotHeaderFormat={HOUR_FORMAT}
          eventTimeFormat={HOUR_FORMAT}
          businessHours={businessHours}
          nonBusinessHoursClass={s.unavailable}
          editable
          eventAllow={(span) => !span.allDay}
          events={events}
          eventContent={EventContent}
          eventDrop={handleChange}
          eventDragStart={() => {
            dragging.current = true
          }}
          eventDragStop={(info) => {
            dragging.current = false
            // Let go over a day in the mini month: move it to that day, same time.
            const day = document
              .elementFromPoint(info.jsEvent.clientX, info.jsEvent.clientY)
              ?.closest('[data-mini-date]')
              ?.getAttribute('data-mini-date')
            const block = blocks.find((b) => b.id === info.event.id)
            if (day && block && onDropOnDate) onDropOnDate(block, day)
          }}
          eventResize={handleChange}
          eventClick={handleClick}
          selectable={!!onSelectTime}
          selectMirror
          selectMinDistance={4}
          selectAllow={(span) =>
            !span.allDay && performance.now() - pressedAt.current >= DRAW_HOLD_MS
          }
          select={(info) => {
            info.view.calendar.unselect()
            // With blocks selected, a click on empty time just clears the selection.
            if (selected.size) {
              setSelected(new Map())
              return
            }
            onSelectTime?.({ start: fcToIso(info.startStr), end: fcToIso(info.endStr) })
          }}
          datesSet={handleDates}
          droppable={!!onExternalDrop}
          drop={handleDrop}
        />
      </div>
    </div>
  )
}
