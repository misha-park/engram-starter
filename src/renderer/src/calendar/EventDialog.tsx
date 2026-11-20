import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { Block, BlockLink } from '@shared/types'
import { atLocalTime, formatClock, toIso, zoned } from '@core/time'
import { call } from '../lib/api'
import { pushUndo } from '../ui/undoStore'
import { errorMessage, useAssignments, useGeneralDeadlines, useModules } from '../lib/queries'
import { useQueryClient } from '@tanstack/react-query'
import { DateField } from '../ui/DateField'
import { TimeField } from '../ui/TimeField'
import d from '../shell/Dialog.module.css'
import n from './EventDialog.module.css'

/**
 * Add an event (the toolbar's New event button, or dragging over empty time, which fills in
 * the times), or edit one added by hand. Fixed events never move; study time can be moved by
 * Engram's planning and by Claude.
 */
export function EventDialog({
  block,
  start,
  end,
  copyOf,
  title: initialTitle,
  onClose
}: {
  /** Edit this block; otherwise add a new one from `start` to `end`. */
  block?: Block
  start?: string
  end?: string
  /** A new event filled in from this one (Duplicate). */
  copyOf?: Block
  /** A title for a new event (e.g. one copied from a linked calendar). */
  title?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data: modules = [] } = useModules()
  const { data: assignments = [] } = useAssignments()
  const { data: deadlines = [] } = useGeneralDeadlines()
  const from0 = block?.start ?? start!
  const to0 = block?.end ?? end!
  const source = block ?? copyOf
  const [title, setTitle] = useState(source?.title ?? initialTitle ?? '')
  const [date, setDate] = useState(zoned(from0).toPlainDate().toString())
  const [from, setFrom] = useState(formatClock(from0))
  const [to, setTo] = useState(formatClock(to0))
  // What it's for, as "type:id" ('' = nothing in particular). An event already linked to a
  // stage keeps that stage.
  const [forValue, setForValue] = useState(() => {
    const type = source?.linkedType
    return source?.linkedId &&
      (type === 'module' || type === 'assignment-stage' || type === 'deadline')
      ? `${type}:${source.linkedId}`
      : ''
  })
  const link: BlockLink | null = forValue
    ? {
        type: forValue.slice(0, forValue.indexOf(':')) as BlockLink['type'],
        id: forValue.slice(forValue.indexOf(':') + 1)
      }
    : null
  const linkName = link
    ? link.type === 'module'
      ? modules.find((m) => m.id === link.id)?.name
      : link.type === 'assignment'
        ? assignments.find((x) => x.id === link.id)?.title
        : link.type === 'deadline'
          ? deadlines.find((x) => x.id === link.id)?.title
          : source?.heading
    : undefined
  const openAssignments = assignments.filter((x) => x.status !== 'submitted')
  const openDeadlines = deadlines.filter((x) => !x.doneAt)
  const [kind, setKind] = useState<Block['kind']>(source?.kind ?? 'fixed')
  const [notes, setNotes] = useState(source?.notes ?? '')
  // Repeat (new events only): never, weekly on its day, weekdays, or chosen days; until a date.
  const [repeat, setRepeat] = useState<'none' | 'weekly' | 'weekdays' | 'custom'>('none')
  const [days, setDays] = useState<number[]>([])
  const [until, setUntil] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // An end at or before the start runs past midnight (e.g. 17:00–00:00).
  const startAt = atLocalTime(date, from)
  let endAt = atLocalTime(date, to)
  if (Temporal.ZonedDateTime.compare(endAt, startAt) <= 0) endAt = endAt.add({ days: 1 })
  const overnight = endAt.toPlainDate().toString() !== date

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const input = {
        title,
        start: toIso(startAt),
        end: toIso(endAt),
        kind,
        moduleId: link?.type === 'module' ? link.id : null,
        link,
        notes: notes || null,
        repeat:
          repeat === 'none'
            ? null
            : {
                byWeekday:
                  repeat === 'weekdays'
                    ? [1, 2, 3, 4, 5]
                    : repeat === 'custom' && days.length
                      ? days
                      : [startAt.dayOfWeek],
                until
              }
      }
      if (block) await call('blocks:update', block.id, input)
      else {
        const created = await call('blocks:create', input)
        // A single new event can be taken back with the calendar's Undo (a series can't).
        if (!input.repeat) {
          pushUndo(`Added “${created.title}”.`, async () => {
            await call('blocks:delete', created.id)
            await qc.invalidateQueries()
          })
        }
      }
      await qc.invalidateQueries()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!block || !window.confirm(`Delete “${block.title}”?`)) return
    setBusy(true)
    setError(null)
    try {
      await call('blocks:delete', block.id)
      await qc.invalidateQueries()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const heading = block ? 'Edit event' : copyOf ? 'Duplicate event' : 'New event'
  return (
    <div className={d.backdrop}>
      <div className={d.dialog} role="dialog" aria-label={heading}>
        <header className={d.header}>
          <h2 className={d.title}>{heading}</h2>
          <button className={d.close} onClick={onClose} disabled={busy} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <div className={d.body}>
          <label className={d.field}>
            Title
            <input
              className={d.input}
              value={title}
              autoFocus
              placeholder={linkName ?? 'e.g. Dentist, Lab meeting, Revise PHAR L4'}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (title.trim() || link) && void save()}
            />
          </label>
          <div className={d.row}>
            <label className={d.field}>
              Date
              <DateField value={date} onChange={setDate} ariaLabel="Date" />
            </label>
            <label className={d.field}>
              From
              <TimeField value={from} onChange={setFrom} ariaLabel="Start time" />
            </label>
            <label className={d.field}>
              To
              <TimeField value={to} onChange={setTo} ariaLabel="End time" />
            </label>
          </div>
          {overnight && <p className={d.muted}>Ends the next day.</p>}
          {!block && (
            <div className={d.row}>
              <label className={d.field}>
                Repeat
                <select
                  className={d.select}
                  value={repeat}
                  onChange={(e) => {
                    const next = e.target.value as typeof repeat
                    setRepeat(next)
                    if (next === 'custom' && !days.length) setDays([startAt.dayOfWeek])
                  }}
                >
                  <option value="none">Doesn’t repeat</option>
                  <option value="weekly">
                    Every {startAt.toPlainDate().toLocaleString('en-GB', { weekday: 'long' })}
                  </option>
                  <option value="weekdays">Every weekday (Mon–Fri)</option>
                  <option value="custom">On days I choose…</option>
                </select>
              </label>
              {repeat !== 'none' && (
                <label className={d.field}>
                  Until
                  <span className={d.row}>
                    {until ? (
                      <>
                        <DateField value={until} onChange={setUntil} ariaLabel="Repeat until" />
                        <button className={n.linkButton} onClick={() => setUntil(null)}>
                          No end
                        </button>
                      </>
                    ) : (
                      <button
                        className={n.linkButton}
                        onClick={() =>
                          setUntil(Temporal.PlainDate.from(date).add({ weeks: 10 }).toString())
                        }
                      >
                        No end · set a date
                      </button>
                    )}
                  </span>
                </label>
              )}
            </div>
          )}
          {!block && repeat === 'custom' && (
            <div className={n.days} role="group" aria-label="Repeat on">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name, i) => (
                <button
                  key={name}
                  className={n.day}
                  aria-pressed={days.includes(i + 1)}
                  onClick={() =>
                    setDays((ds) =>
                      ds.includes(i + 1) ? ds.filter((x) => x !== i + 1) : [...ds, i + 1]
                    )
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <div className={d.row}>
            <label className={`${d.field} ${n.forField}`}>
              For
              <select
                className={d.select}
                value={forValue}
                onChange={(e) => {
                  setForValue(e.target.value)
                  // Module, assignment or deadline work is usually study time Engram may move.
                  if (e.target.value) setKind('flexible')
                }}
              >
                <option value="">Nothing in particular</option>
                {link?.type === 'assignment-stage' && (
                  <option value={forValue}>{source?.heading ?? 'Its assignment stage'}</option>
                )}
                {modules.length > 0 && (
                  <optgroup label="Modules">
                    {modules.map((m) => (
                      <option key={m.id} value={`module:${m.id}`}>
                        {m.shortLabel} · {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {openAssignments.length > 0 && (
                  <optgroup label="Assignments">
                    {openAssignments.map((x) => (
                      <option key={x.id} value={`assignment:${x.id}`}>
                        {x.title}
                      </option>
                    ))}
                  </optgroup>
                )}
                {openDeadlines.length > 0 && (
                  <optgroup label="Deadlines">
                    {openDeadlines.map((x) => (
                      <option key={x.id} value={`deadline:${x.id}`}>
                        {x.title}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          </div>
          <div className={n.kinds} role="radiogroup" aria-label="Can it move?">
            <button
              className={n.kind}
              role="radio"
              aria-checked={kind === 'fixed'}
              onClick={() => setKind('fixed')}
            >
              <strong>Fixed</strong>
              <span>An appointment or plan. Engram plans around it and never moves it.</span>
            </button>
            <button
              className={n.kind}
              role="radio"
              aria-checked={kind === 'flexible'}
              onClick={() => setKind('flexible')}
            >
              <strong>Study time</strong>
              <span>Work with a timer and an outcome. You or Claude can move it later.</span>
            </button>
          </div>
          <label className={d.field}>
            Notes (optional)
            <input className={d.input} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          {error && <p className={d.error}>{error}</p>}
        </div>
        <div className={d.actions}>
          {block && (
            <button
              className={`${d.secondary} ${n.delete}`}
              onClick={() => void remove()}
              disabled={busy}
            >
              Delete event
            </button>
          )}
          <span className={d.spacer} />
          <button className={d.secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={d.primary}
            disabled={busy || (!title.trim() && !link)}
            onClick={() => void save()}
          >
            {block ? 'Save' : 'Add event'}
          </button>
        </div>
      </div>
    </div>
  )
}
