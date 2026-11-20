import { useEffect, useRef, useState } from 'react'
import { Temporal } from 'temporal-polyfill'
import { atLocalTime, formatClock, TZ, toIso } from '@core/time'
import { errorMessage, useAddManualTime, useModule, useModules } from '../lib/queries'
import d from '../shell/Dialog.module.css'
import s from './ManualTimePopover.module.css'
import { DateField } from '../ui/DateField'
import { TimeField } from '../ui/TimeField'

/**
 * Add time spent outside any block (right-click the week total). Optionally tag it to a
 * module or one of its lectures, so it lands in that record.
 */
export function ManualTimePopover({ onClose }: { onClose: () => void }) {
  const now = Temporal.Now.zonedDateTimeISO(TZ)
  const [date, setDate] = useState(now.toPlainDate().toString())
  const [minutes, setMinutes] = useState('60')
  const [time, setTime] = useState(
    formatClock(
      toIso(
        now
          .subtract({ minutes: 60 })
          .round({ smallestUnit: 'minute', roundingIncrement: 15, roundingMode: 'floor' })
      )
    )
  )
  const [moduleId, setModuleId] = useState('')
  const [lectureId, setLectureId] = useState('')
  const [note, setNote] = useState('')
  const { data: modules = [] } = useModules()
  const { data: mod } = useModule(moduleId)
  const add = useAddManualTime()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const save = () => {
    const link = lectureId
      ? { type: 'lecture' as const, id: lectureId }
      : moduleId
        ? { type: 'module' as const, id: moduleId }
        : null
    add.mutate(
      { start: toIso(atLocalTime(date, time)), minutes: Number(minutes), link, note },
      { onSuccess: onClose }
    )
  }

  return (
    <div className={s.popover} ref={ref} role="dialog" aria-label="Add time">
      <div className={s.title}>Add time</div>
      <p className={d.muted}>Time spent outside any block. It counts towards the week.</p>
      <div className={d.row}>
        <label className={d.field}>
          Date
          <DateField value={date} onChange={setDate} ariaLabel="Date" />
        </label>
        <label className={d.field}>
          From
          <TimeField value={time} onChange={setTime} ariaLabel="From" />
        </label>
        <label className={d.field}>
          Minutes
          <input
            className={`${d.input} ${s.minutes}`}
            type="number"
            min={1}
            max={720}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
      </div>
      <label className={d.field}>
        For (optional)
        <select
          className={d.select}
          value={moduleId}
          onChange={(e) => {
            setModuleId(e.target.value)
            setLectureId('')
          }}
        >
          <option value="">Nothing in particular</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.shortLabel} · {m.name}
            </option>
          ))}
        </select>
      </label>
      {moduleId && mod && mod.lectures.length > 0 && (
        <select
          className={d.select}
          value={lectureId}
          onChange={(e) => setLectureId(e.target.value)}
          aria-label="Lecture"
        >
          <option value="">The module in general</option>
          {mod.lectures.map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}
            </option>
          ))}
        </select>
      )}
      <label className={d.field}>
        Note (optional)
        <input
          className={d.input}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {add.error && <p className={d.error}>{errorMessage(add.error)}</p>}
      <div className={d.row}>
        <span className={d.spacer} />
        <button className={d.secondary} onClick={onClose}>
          Cancel
        </button>
        <button className={d.primary} onClick={save} disabled={!Number(minutes) || add.isPending}>
          Add
        </button>
      </div>
    </div>
  )
}
