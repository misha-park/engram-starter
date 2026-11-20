import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { parseTimeInput as parseTime } from '@core/time'
import f from './fields.module.css'

interface Props {
  /** Local time, HH:MM (24h) */
  value: string
  /** Called with a valid HH:MM when the user picks or finishes typing a time. */
  onChange: (value: string) => void
  ariaLabel?: string
  className?: string
  /** Minutes between suggestions in the list (default 15). */
  step?: number
}

/** A typeable 24-hour time field with a list of times in the app's own style. */
export function TimeField({ value, onChange, ariaLabel = 'Time', className, step = 15 }: Props) {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const [lastValue, setLastValue] = useState(value)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  if (lastValue !== value) {
    setLastValue(value)
    setText(value)
  }

  const times = Array.from({ length: (24 * 60) / step }, (_, i) => {
    const mins = i * step
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) =>
      root.current && !root.current.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', onDown)
    // Scroll the current (or nearest earlier) time into view.
    const nearest = [...times].reverse().find((t) => t <= value) ?? times[0]
    list.current?.querySelector(`[data-time="${nearest}"]`)?.scrollIntoView({ block: 'center' })
    return () => window.removeEventListener('mousedown', onDown)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (raw: string) => {
    const parsed = parseTime(raw)
    if (parsed) {
      setText(parsed)
      if (parsed !== value) onChange(parsed)
    } else {
      setText(value)
    }
  }

  return (
    <div className={`${f.root} ${className ?? ''}`} ref={root}>
      <div className={f.field} data-focus={open || undefined}>
        <input
          className={`${f.timeInput} num`}
          value={text}
          aria-label={ariaLabel}
          inputMode="numeric"
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => {
            e.target.select()
            setOpen(true)
          }}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit(text)
              setOpen(false)
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setText(value)
              setOpen(false)
            }
          }}
        />
        <Clock size={14} className={f.icon} />
      </div>
      {open && (
        <div
          className={`${f.popover} ${f.timeList}`}
          ref={list}
          role="listbox"
          aria-label={ariaLabel}
        >
          {times.map((t) => (
            <button
              type="button"
              key={t}
              data-time={t}
              role="option"
              aria-selected={t === value}
              className={`${f.time} num`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(t)
                if (t !== value) onChange(t)
                setOpen(false)
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
