import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { DissertationOverview } from '@shared/types'
import { termsBetween } from '@core/terms'
import { TZ, zoned } from '@core/time'
import { call } from '../../lib/api'
import { DateField } from '../../ui/DateField'
import { useDissAction } from './useDissertation'
import d from './Dissertation.module.css'

interface Point {
  key: string
  title: string
  date: Temporal.PlainDate
  kind: 'milestone' | 'submission' | 'viva'
  done?: boolean
}

const fmt = (date: Temporal.PlainDate) =>
  date.toLocaleString('en-GB', { day: 'numeric', month: 'short' })

/**
 * Milestones to submission and the viva on one line, today marked. Shown at the top of every
 * dissertation tab; `emptyHint` is the message when there is nothing to draw (the other tabs
 * leave it out and show nothing).
 */
export function TimelineStrip({
  data,
  emptyHint
}: {
  data: DissertationOverview
  emptyHint?: string
}) {
  const today = Temporal.Now.plainDateISO(TZ)
  const s = data.settings

  const points: Point[] = [
    ...data.milestones.map((m) => ({
      key: m.id,
      title: m.title,
      date: Temporal.PlainDate.from(m.due),
      kind: 'milestone' as const,
      done: !!m.doneAt
    })),
    ...(s.submissionDue
      ? [
          {
            key: 'submission',
            title: 'Submission',
            date: zoned(s.submissionDue).toPlainDate(),
            kind: 'submission' as const
          }
        ]
      : []),
    ...(s.vivaDate
      ? [
          {
            key: 'viva',
            title: 'Viva',
            date: Temporal.PlainDate.from(s.vivaDate),
            kind: 'viva' as const
          }
        ]
      : [])
  ].sort((a, b) => Temporal.PlainDate.compare(a.date, b.date))

  const dates = [...points.map((p) => p.date), today]
  if (s.startedOn) dates.push(Temporal.PlainDate.from(s.startedOn))
  const first = dates.reduce((a, b) => (Temporal.PlainDate.compare(a, b) < 0 ? a : b))
  const lastRaw = dates.reduce((a, b) => (Temporal.PlainDate.compare(a, b) > 0 ? a : b))
  const last = Temporal.PlainDate.compare(lastRaw, first) === 0 ? first.add({ days: 30 }) : lastRaw
  const span = first.until(last).days
  const pct = (date: Temporal.PlainDate) => (first.until(date).days / span) * 94 + 3
  const at = (date: Temporal.PlainDate) => `${pct(date)}%`
  // UCL terms as faint bands, reading weeks as ticks: a sense of where the weeks go.
  const calendar = termsBetween(first, last)

  if (points.length === 0) return emptyHint ? <p className={d.muted}>{emptyHint}</p> : null

  return (
    <div className={d.timeline} aria-label="Timeline">
      <div className={d.line} />
      {calendar.terms.map((t) => (
        <div
          key={t.name}
          className={d.term}
          style={{ left: at(t.from), width: `${pct(t.to) - pct(t.from)}%` }}
          title={`${t.name}: ${fmt(Temporal.PlainDate.from(t.start))} – ${fmt(Temporal.PlainDate.from(t.end))}`}
        >
          <span className={d.termLabel}>
            {t.name} · {fmt(Temporal.PlainDate.from(t.start))} –{' '}
            {fmt(Temporal.PlainDate.from(t.end))}
          </span>
        </div>
      ))}
      {calendar.readingWeeks.map((w) => (
        <div
          key={w.toString()}
          className={d.readingWeek}
          style={{ left: at(w) }}
          title={`Reading week from ${fmt(w)}`}
        />
      ))}
      <div className={d.progress} style={{ width: at(today) }} />
      <div className={d.today} style={{ left: at(today) }}>
        <span>Today</span>
      </div>
      {points.map((p, i) => (
        <div
          key={p.key}
          className={d.point}
          data-kind={p.kind}
          data-done={p.done || undefined}
          data-below={i % 2 === 1 || undefined}
          style={{ left: at(p.date) }}
          title={`${p.title}: ${fmt(p.date)}`}
        >
          <span className={d.marker} />
          <span className={d.pointLabel}>
            <strong>{p.title}</strong>
            <span className="num">{fmt(p.date)}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** The timeline, then the milestone list to edit. */
export function TimelineTab({ data }: { data: DissertationOverview }) {
  const action = useDissAction()
  const today = Temporal.Now.plainDateISO(TZ)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(today.add({ weeks: 2 }).toString())

  return (
    <div className={d.stack}>
      <TimelineStrip
        data={data}
        emptyHint="No milestones yet. Add them below, and set the submission date and your viva in settings."
      />

      <div className={d.table} role="table" aria-label="Milestones">
        {data.milestones.map((m) => {
          const date = Temporal.PlainDate.from(m.due)
          const late = !m.doneAt && Temporal.PlainDate.compare(date, today) < 0
          return (
            <div key={m.id} className={d.milestoneRow} role="row">
              <input
                type="checkbox"
                className={d.check}
                checked={!!m.doneAt}
                aria-label={`${m.title} done`}
                onChange={(e) =>
                  void action.run(() =>
                    call('diss:updateMilestone', m.id, { done: e.target.checked })
                  )
                }
              />
              <span className={m.doneAt ? d.doneText : undefined}>{m.title}</span>
              <span className={late ? d.lateText : d.muted}>
                {late ? 'Overdue · ' : ''}
                {today.until(date).days >= 0
                  ? `in ${today.until(date).days} days`
                  : `${-today.until(date).days} days ago`}
              </span>
              <DateField
                value={m.due}
                ariaLabel={`${m.title} date`}
                onChange={(v) =>
                  void action.run(() => call('diss:updateMilestone', m.id, { due: v }))
                }
              />
              <button
                className={d.iconButton}
                aria-label={`Remove ${m.title}`}
                onClick={() => void action.run(() => call('diss:removeMilestone', m.id))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
        <div className={d.milestoneRow}>
          <span />
          <input
            className={d.input}
            value={title}
            placeholder="New milestone"
            aria-label="New milestone"
            onChange={(e) => setTitle(e.target.value)}
          />
          <span />
          <DateField value={due} onChange={setDue} ariaLabel="New milestone date" />
          <button
            className={d.button}
            disabled={!title.trim()}
            onClick={() =>
              void action.run(() => call('diss:addMilestone', title, due)).then(() => setTitle(''))
            }
          >
            Add
          </button>
        </div>
      </div>
      {action.error && <p className={d.error}>{action.error}</p>}
    </div>
  )
}
