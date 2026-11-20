import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCalendarController } from '@fullcalendar/react'
import type { Block, LinkedEventView } from '@shared/types'
import { atLocalTime, formatClock, toIso, weekRange, zoned } from '@core/time'
import { CalendarPlus, MousePointerClick, Trash2 } from 'lucide-react'
import { openContextMenu } from '../ui/menuStore'
import { toast } from '../ui/toastStore'
import { shiftDays } from '../calendar/blockMenu'
import { isUserMovable } from '@core/blocks'
import { Temporal } from 'temporal-polyfill'
import { BlockDialog } from '../calendar/BlockDialog'
import { CalendarToolbar } from '../calendar/CalendarToolbar'
import { EventDialog } from '../calendar/EventDialog'
import { nextHourSlot } from '../calendar/dates'
import { PlannerCalendar } from '../calendar/PlannerCalendar'
import { Sidebar } from '../shell/Sidebar'
import { call } from '../lib/api'
import {
  useAssistantPending,
  useBlocks,
  useCategories,
  useDeadlines,
  useLinkedEvents,
  errorMessage,
  useProfile
} from '../lib/queries'
import { useBlockMenu } from '../calendar/useBlockMenu'
import { useAssistantScreen } from '../assistant/store'
import { ReviewBar } from '../assistant/ReviewBar'
import { useHiddenCategories } from '../lib/useHiddenCategories'
import { useNow } from '../lib/useNow'
import s from './CalendarPage.module.css'

// Home screen: sidebar + FullCalendar (week by default; day and month views).

export function CalendarPage() {
  const now = useNow()
  const controller = useCalendarController()
  const [range, setRange] = useState(() => {
    const w = weekRange(now)
    return { start: toIso(w.start), end: toIso(w.end) }
  })
  const [openBlock, setOpenBlock] = useState<{ block: Block; edit?: boolean } | null>(null)
  const [newEvent, setNewEvent] = useState<{
    start: string
    end: string
    copyOf?: Block
    title?: string
  } | null>(null)
  const { onBlockMenu, onBlockDelete, focusId, setFocus } = useBlockMenu(
    controller,
    (block, mode) => setOpenBlock({ block, edit: mode === 'edit' }),
    (block) => setNewEvent({ start: block.start, end: block.end, copyOf: block })
  )
  const { hidden, toggle } = useHiddenCategories()

  // Open a block from a link (e.g. a notification): /?block=ID
  const [params, setParams] = useSearchParams()
  const linkedBlock = params.get('block')
  useEffect(() => {
    if (!linkedBlock) return
    call('blocks:get', linkedBlock).then((b) => {
      if (b) {
        controller.gotoDate(zoned(b.start).toPlainDate().toString())
        setOpenBlock({ block: b })
      }
      setParams({}, { replace: true })
    })
  }, [linkedBlock, controller, setParams])

  const { data: blocks = [] } = useBlocks(range.start, range.end)
  const { data: deadlines = [] } = useDeadlines(range.start, range.end)
  const { data: linkedEvents = [] } = useLinkedEvents(range.start, range.end)
  const { data: categories = [] } = useCategories()
  const { data: pending } = useAssistantPending()
  // Real data with no timetable yet: say so, rather than show an empty week.
  const { data: profile } = useProfile()
  const { data: feed } = useQuery({
    queryKey: ['feedStatus'],
    queryFn: () => call('feed:status'),
    enabled: profile?.active === 'real'
  })
  const navigate = useNavigate()
  const qc = useQueryClient()
  // A one-time tip: right-click is where the quick edits are.
  const [tip, setTip] = useState(() => {
    try {
      return localStorage.getItem('tip.calendarClicks') !== 'seen'
    } catch {
      return false
    }
  })
  const dismissTip = () => {
    setTip(false)
    try {
      localStorage.setItem('tip.calendarClicks', 'seen')
    } catch {
      // Not essential.
    }
  }
  useAssistantScreen({ visibleRange: range, blockId: openBlock?.block.id })

  const onRangeChange = useCallback((r: { start: string; end: string }) => {
    setRange((prev) => (prev.start === r.start && prev.end === r.end ? prev : r))
  }, [])

  // An event of a linked calendar (iCloud…) copied into Engram by hand: a New event filled in.
  // An all-day event has no time, so it's offered at 09:00–10:00 on its day.
  const addLinked = (e: { title: string; start: string; end: string; allDay: boolean }) =>
    setNewEvent(
      e.allDay
        ? {
            title: e.title,
            start: toIso(atLocalTime(e.start, '09:00')),
            end: toIso(atLocalTime(e.start, '10:00'))
          }
        : { title: e.title, start: e.start, end: e.end }
    )

  // Delete one from this view only (the calendar itself is never touched), with Undo.
  const deleteLinked = async (ev: LinkedEventView) => {
    try {
      await call('calendars:hideEvent', ev.calendarId, ev.uid)
      await qc.invalidateQueries()
      toast(`Deleted “${ev.title}” from here. Your ${ev.calendar} calendar isn’t touched.`, {
        action: {
          label: 'Undo',
          run: async () => {
            await call('calendars:restoreEvent', ev.calendarId, ev.uid)
            await qc.invalidateQueries()
          }
        }
      })
    } catch (e) {
      toast(errorMessage(e), { tone: 'error' })
    }
  }

  // A block dropped on a day in the mini month moves there, same time.
  const moveToDay = async (block: Block, date: string) => {
    if (!isUserMovable(block)) {
      toast('Timetabled events can’t be moved.', { tone: 'error' })
      return
    }
    const days = zoned(block.start).toPlainDate().until(Temporal.PlainDate.from(date)).days
    if (!days) return
    const before = { start: block.start, end: block.end }
    const next = shiftDays(block, days)
    try {
      await call('blocks:move', block.id, next.start, next.end)
      await qc.invalidateQueries()
      controller.gotoDate(date)
      setFocus(block.id)
      toast(
        `Moved to ${Temporal.PlainDate.from(date).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}.`,
        {
          action: {
            label: 'Undo',
            run: async () => {
              await call('blocks:move', block.id, before.start, before.end)
              await qc.invalidateQueries()
            }
          }
        }
      )
    } catch (e) {
      toast(errorMessage(e), { tone: 'error' })
    }
  }

  // The date the calendar is showing drives the mini month. Use the middle of the visible
  // range so a month view (which starts in the previous month) maps to the right month.
  const mid = midpointDate(range.start, range.end)
  // The scrolling month view: the week at the top of the scroll names the month.
  const [topDate, setTopDate] = useState<string | null>(null)
  const monthView = controller.view?.type === 'dayGridMonth'
  const topMonth = monthView && topDate ? Temporal.PlainDate.from(topDate).add({ days: 6 }) : null
  const shown = topMonth ?? mid

  return (
    <div className={s.layout}>
      <Sidebar
        now={now}
        shownDate={shown}
        onPickDate={(d) => controller.gotoDate(d.toString())}
        hiddenCategories={hidden}
        onToggleCategory={toggle}
      />
      <section className={s.main}>
        {pending && <ReviewBar batch={pending} />}
        {profile?.active === 'real' && feed && !feed.connected && (
          <div className={s.hint}>
            <span>Your timetable isn’t connected yet, so Engram has nothing to plan around.</span>
            <button className={s.hintButton} onClick={() => navigate('/settings')}>
              Connect it in Settings
            </button>
          </div>
        )}
        {tip && (
          <div className={s.tip}>
            <MousePointerClick size={14} />
            <span>
              Click blocks to select them (drag one to move them all), double-click to open one.
              Right-click for quick edits: move to tomorrow or next week, rename, mark done.
            </span>
            <button className={s.tipClose} onClick={dismissTip} aria-label="Got it">
              Got it
            </button>
          </div>
        )}
        <CalendarToolbar
          controller={controller}
          onNewEvent={() => setNewEvent(nextHourSlot())}
          title={topMonth?.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}
        />
        <PlannerCalendar
          rememberAs="calendar"
          controller={controller}
          blocks={blocks}
          deadlines={deadlines}
          linkedEvents={linkedEvents}
          onLinkedMenu={(ev, e) =>
            openContextMenu(e, [
              { heading: `${ev.title} · ${ev.calendar}` },
              {
                label: 'Add to Engram…',
                icon: CalendarPlus,
                onSelect: () => addLinked(ev)
              },
              'separator',
              {
                label: 'Delete from here',
                icon: Trash2,
                danger: true,
                onSelect: () => deleteLinked(ev)
              }
            ])
          }
          onAddLinked={addLinked}
          categories={categories}
          hiddenCategories={hidden}
          onRangeChange={onRangeChange}
          onOpenBlock={(block) => setOpenBlock({ block })}
          onSelectTime={setNewEvent}
          review={pending}
          focusId={focusId}
          onBlockMenu={onBlockMenu}
          onBlockDelete={onBlockDelete}
          onVisibleDate={setTopDate}
          onDropOnDate={(block, date) => void moveToDay(block, date)}
          onSlotMenu={(start, e) => {
            const at = zoned(start)
            openContextMenu(e, [
              {
                heading: `${at.toPlainDate().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${formatClock(start)}`
              },
              {
                label: 'New event here…',
                icon: CalendarPlus,
                onSelect: () => setNewEvent({ start, end: toIso(at.add({ hours: 1 })) })
              }
            ])
          }}
        />
      </section>
      {newEvent && (
        <EventDialog
          start={newEvent.start}
          end={newEvent.end}
          copyOf={newEvent.copyOf}
          title={newEvent.title}
          onClose={() => setNewEvent(null)}
        />
      )}
      {openBlock && (
        <BlockDialog
          block={openBlock.block}
          startEditing={openBlock.edit}
          category={categories.find((c) => c.id === openBlock.block.categoryId)}
          onClose={() => setOpenBlock(null)}
          onShowBlock={(b) => {
            controller.gotoDate(zoned(b.start).toPlainDate().toString())
            setFocus(b.id)
          }}
        />
      )}
    </div>
  )
}

function midpointDate(startIso: string, endIso: string) {
  const start = zoned(startIso)
  const days = Math.floor(start.toPlainDate().until(zoned(endIso).toPlainDate()).days / 2)
  return start.toPlainDate().add({ days })
}
