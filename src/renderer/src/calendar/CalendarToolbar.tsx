import type { CalendarController } from '@fullcalendar/react'
import { useState, useSyncExternalStore } from 'react'
import { ChevronLeft, ChevronRight, Plus, Undo2 } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { TZ } from '@core/time'
import { latestUndo, runUndo, subscribeUndo } from '../ui/undoStore'
import { toast } from '../ui/toastStore'
import { errorMessage } from '../lib/queries'
import s from './Calendar.module.css'

const VIEW_BUTTONS = [
  { id: 'timeGridDay', label: 'Day' },
  { id: 'timeGridWeek', label: 'Week' },
  { id: 'dayGridMonth', label: 'Month' }
] as const

/** Our own toolbar, driven by FullCalendar's controller (v7 has no default header). */
export function CalendarToolbar({
  controller,
  onNewEvent,
  title
}: {
  controller: CalendarController
  /** Shows the New event button (the main calendar). */
  onNewEvent?: () => void
  /** Instead of the view's own title (the scrolling month view names the month at the top). */
  title?: string
}) {
  const view = controller.view
  // The month view scrolls through half a year: start it a week back so this week is near
  // the top.
  const weekBack = () => Temporal.Now.plainDateISO(TZ).subtract({ weeks: 1 }).toString()
  const today = () =>
    view?.type === 'dayGridMonth' ? controller.gotoDate(weekBack()) : controller.today()
  return (
    <div className={s.toolbar}>
      <button className={s.textButton} onClick={today}>
        Today
      </button>
      <button className={s.iconButton} onClick={() => controller.prev()} title="Previous">
        <ChevronLeft size={16} />
      </button>
      <button className={s.iconButton} onClick={() => controller.next()} title="Next">
        <ChevronRight size={16} />
      </button>
      <span className={s.toolbarTitle}>{title ?? view?.title}</span>
      <span className={s.spacer} />
      {onNewEvent && <UndoButton />}
      {onNewEvent && (
        <button
          className={s.newEvent}
          onClick={onNewEvent}
          title="Add an event (or drag over empty time)"
        >
          <Plus size={14} /> New event
        </button>
      )}
      <div className={s.segmented} role="group" aria-label="View">
        {VIEW_BUTTONS.map((v) => (
          <button
            key={v.id}
            aria-pressed={view?.type === v.id}
            onClick={() => {
              const entering = v.id === 'dayGridMonth' && view?.type !== 'dayGridMonth'
              controller.changeView(v.id)
              if (entering) controller.gotoDate(weekBack())
            }}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Takes back the latest change that has an Undo (moves, drags, new events…). */
function UndoButton() {
  const last = useSyncExternalStore(subscribeUndo, latestUndo)
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={s.iconButton}
      disabled={!last || busy}
      title={last ? `Undo: ${last.label.replace(/\.$/, '')}` : 'Nothing to undo'}
      aria-label={last ? `Undo: ${last.label}` : 'Nothing to undo'}
      onClick={async () => {
        if (!last) return
        setBusy(true)
        try {
          await runUndo(last.id)
          toast(`Undone: ${last.label.replace(/\.$/, '')}.`)
        } catch (e) {
          toast(errorMessage(e), { tone: 'error' })
        } finally {
          setBusy(false)
        }
      }}
    >
      <Undo2 size={16} />
    </button>
  )
}
