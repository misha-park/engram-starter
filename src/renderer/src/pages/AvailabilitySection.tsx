import { useState } from 'react'
import type { AvailabilitySettings, DayHours } from '@shared/types'
import { validateAvailability, WEEKDAY_NAMES } from '@core/availability'
import { useAvailability, useSetAvailability } from '../lib/queries'
import s from './Page.module.css'
import { TimeField } from '../ui/TimeField'

const DEFAULT_HOURS: DayHours = { start: '09:00', end: '22:00' }
const FULL_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Availability: the hours automatic placement may use, set per weekday. */
export function AvailabilitySection() {
  const { data } = useAvailability()
  // Owned here (not in the form) so "Saved." survives the form re-mounting after a save.
  const save = useSetAvailability()
  if (!data) return null
  // Re-mount the form when the saved value changes so it starts from the stored settings.
  return <AvailabilityForm key={JSON.stringify(data)} saved={data} save={save} />
}

function AvailabilityForm({
  saved,
  save
}: {
  saved: AvailabilitySettings
  save: ReturnType<typeof useSetAvailability>
}) {
  const [draft, setDraft] = useState(saved)
  const error = validateAvailability(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const setDay = (i: number, day: DayHours | null) =>
    setDraft((d) => ({ days: d.days.map((x, j) => (j === i ? day : x)) }))
  /** Copy one day's hours to the other weekdays (Mon–Fri) or to every day. */
  const copyFrom = (i: number, to: 'weekdays' | 'all') =>
    setDraft((d) => ({
      days: d.days.map((x, j) =>
        to === 'all' || j < 5 ? (d.days[i] ? { ...d.days[i]! } : null) : x
      )
    }))

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Availability</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Working hours</div>
            <div className={s.muted}>
              Automatic placement (and Claude) only uses these hours. You can still drag blocks
              anywhere.
            </div>
          </div>
          <button className={s.button} onClick={() => copyFrom(0, 'weekdays')}>
            Copy Monday to weekdays
          </button>
        </div>
        {WEEKDAY_NAMES.map((label, i) => {
          const day = draft.days[i]
          return (
            <div key={label} className={s.row}>
              <label className={`${s.switch} ${s.dayName}`}>
                <input
                  type="checkbox"
                  checked={!!day}
                  aria-label={`Work on ${label}`}
                  onChange={(e) =>
                    setDay(i, e.target.checked ? (saved.days[i] ?? { ...DEFAULT_HOURS }) : null)
                  }
                />
                {label}
              </label>
              {day ? (
                <>
                  <TimeField
                    value={day.start}
                    onChange={(v) => setDay(i, { ...day, start: v })}
                    ariaLabel={`${label} start`}
                  />
                  <span className={s.muted}>to</span>
                  <TimeField
                    value={day.end}
                    onChange={(v) => setDay(i, { ...day, end: v })}
                    ariaLabel={`${label} end`}
                  />
                </>
              ) : (
                <span className={s.muted}>Day off: nothing is placed on {FULL_NAMES[i]}s.</span>
              )}
            </div>
          )
        })}
        <div className={s.row}>
          <div className={`${s.grow} ${error ? s.errorText : s.muted}`}>
            {error ?? (save.isSuccess && !dirty ? 'Saved.' : '')}
          </div>
          <button className={s.button} disabled={!dirty} onClick={() => setDraft(saved)}>
            Revert
          </button>
          <button
            className={s.button}
            disabled={!dirty || !!error || save.isPending}
            onClick={() => save.mutate(draft)}
          >
            Save
          </button>
        </div>
      </div>
    </section>
  )
}
