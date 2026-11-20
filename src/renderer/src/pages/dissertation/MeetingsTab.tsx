import { useState } from 'react'
import { CircleCheck, Circle, Pencil, Plus, Trash2 } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { DissertationOverview, Meeting } from '@shared/types'
import { atLocalTime, formatClock, toIso, TZ, zoned } from '@core/time'
import { call } from '../../lib/api'
import { DateField } from '../../ui/DateField'
import { TimeField } from '../../ui/TimeField'
import { useDissAction } from './useDissertation'
import d from './Dissertation.module.css'

/** Supervisor meetings: notes, and action items that become todos (due a week later). */
export function MeetingsTab({ data }: { data: DissertationOverview }) {
  const [editing, setEditing] = useState<Meeting | 'new' | null>(null)
  return (
    <div className={d.stack}>
      <div className={d.toolbar}>
        <span className={d.muted}>Action items become todos, due a week after the meeting.</span>
        <span className={d.spacer} />
        {editing === null && (
          <button className={d.button} onClick={() => setEditing('new')}>
            <Plus size={13} /> New meeting
          </button>
        )}
      </div>
      {editing !== null && (
        <MeetingForm meeting={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      )}
      {data.meetings.length === 0 && editing === null && (
        <p className={d.muted}>No meetings recorded yet.</p>
      )}
      {data.meetings
        .filter((m) => editing === null || editing === 'new' || m.id !== editing.id)
        .map((m) => (
          <article key={m.id} className={d.meeting}>
            <header className={d.meetingHeader}>
              <strong>
                {zoned(m.at)
                  .toPlainDate()
                  .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' })}
                , {formatClock(m.at)}
              </strong>
              <span className={d.spacer} />
              <button
                className={d.iconButton}
                aria-label="Edit meeting"
                onClick={() => setEditing(m)}
              >
                <Pencil size={13} />
              </button>
            </header>
            {m.notes && <p className={d.notes}>{m.notes}</p>}
            {m.actions.length > 0 && (
              <ul className={d.actions}>
                {m.actions.map((a) => (
                  <li key={a.id} data-done={a.done || undefined}>
                    {a.done ? <CircleCheck size={14} /> : <Circle size={14} />}
                    {a.text}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
    </div>
  )
}

function MeetingForm({ meeting, onDone }: { meeting: Meeting | null; onDone: () => void }) {
  const action = useDissAction()
  const start = meeting ? zoned(meeting.at) : Temporal.Now.zonedDateTimeISO(TZ)
  const [date, setDate] = useState(start.toPlainDate().toString())
  const [time, setTime] = useState(
    meeting ? formatClock(meeting.at) : `${String(start.hour).padStart(2, '0')}:00`
  )
  const [notes, setNotes] = useState(meeting?.notes ?? '')
  const [actions, setActions] = useState(meeting?.actions.map((a) => a.text).join('\n') ?? '')

  const save = async () => {
    const id = await action.run(() =>
      call('diss:saveMeeting', {
        id: meeting?.id,
        at: toIso(atLocalTime(date, time)),
        notes,
        actions: actions.split('\n')
      })
    )
    if (id) onDone()
  }

  return (
    <div className={d.meetingForm}>
      <div className={d.formRow}>
        <DateField value={date} onChange={setDate} ariaLabel="Meeting date" />
        <TimeField value={time} onChange={setTime} ariaLabel="Meeting time" />
      </div>
      <label className={d.field}>
        Notes
        <textarea
          className={d.textarea}
          value={notes}
          rows={4}
          placeholder="What was discussed and agreed"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <label className={d.field}>
        Action items <span className={d.muted}>(one per line; each becomes a todo)</span>
        <textarea
          className={d.textarea}
          value={actions}
          rows={3}
          placeholder="Send the search strategy to my supervisor"
          onChange={(e) => setActions(e.target.value)}
        />
      </label>
      {action.error && <p className={d.error}>{action.error}</p>}
      <div className={d.formRow}>
        {meeting && (
          <button
            className={d.button}
            onClick={() =>
              window.confirm('Delete this meeting? Its todos stay.') &&
              void action.run(() => call('diss:removeMeeting', meeting.id)).then(onDone)
            }
          >
            <Trash2 size={13} /> Delete
          </button>
        )}
        <span className={d.spacer} />
        <button className={d.button} onClick={onDone}>
          Cancel
        </button>
        <button className={d.primary} disabled={action.busy} onClick={() => void save()}>
          Save meeting
        </button>
      </div>
    </div>
  )
}
