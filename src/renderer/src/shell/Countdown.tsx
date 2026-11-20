import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import { GraduationCap } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { atLocalTime, toIso, zoned } from '@core/time'
import { dueIn, dueOn, type DueIn } from '@core/due'
import { useNow } from '../lib/useNow'
import { useAssignments, useCategories, useDeadlines, useGeneralDeadlines } from '../lib/queries'
import { useDissertation } from '../pages/dissertation/useDissertation'
import s from './Sidebar.module.css'

// Days to go: each assignment not handed in yet, timetabled assessments still to come, other
// deadlines not ticked off, and the dissertation's next milestone.

function DaysLeft({ due }: { due: DueIn }) {
  return (
    <span
      className={`${s.daysLeft} num`}
      data-soon={due.urgency === 'soon' || undefined}
      data-late={due.late || undefined}
    >
      {due.label.toLowerCase()}
    </span>
  )
}

export function Countdown({ today }: { today: Temporal.PlainDate }) {
  const navigate = useNavigate()
  const now = useNow()
  const { data: assignments = [] } = useAssignments()
  const { data: diss } = useDissertation()
  const { data: others = [] } = useGeneralDeadlines()
  const { data: categories = [] } = useCategories()
  // Timetabled assessments (exams, tests) from today until the end of the academic year.
  const { data: timetabled = [] } = useDeadlines(
    toIso(atLocalTime(today, '00:00')),
    toIso(atLocalTime(today.add({ months: 9 }), '00:00'))
  )
  const colourOf = (categoryId: string | null) =>
    categories.find((c) => c.id === categoryId)?.colour ?? 'var(--text-3)'

  // Assignments not handed in, assessments to come and other deadlines, soonest first.
  const upcoming = [
    ...assignments
      .filter((a) => a.status !== 'submitted')
      .map((a) => ({
        id: a.id,
        title: a.title,
        due: a.due,
        colour: a.colour,
        where: a.moduleLabel,
        to: `/assignments/${a.id}`
      })),
    ...others
      .filter((d) => !d.doneAt)
      .map((d) => ({
        id: d.id,
        title: d.title,
        due: d.due,
        colour: d.colour ?? 'var(--text-3)',
        where: d.moduleName ?? 'Deadline',
        to: `/assignments#deadline-${d.id}`
      })),
    ...timetabled
      .filter((d) => d.kind === 'assessment')
      .map((d) => ({
        id: d.id,
        title: d.title,
        due: d.at,
        colour: colourOf(d.categoryId),
        where: 'from the timetable',
        to: `/?block=${d.id}`
      }))
  ]
    .map((a) => ({ ...a, left: dueIn(a.due, now) }))
    .filter((a) => a.left.days >= -7)
    .sort((a, b) => a.due.localeCompare(b.due))

  const milestone = diss?.milestones
    .filter((m) => !m.doneAt && m.due >= today.toString())
    .sort((a, b) => a.due.localeCompare(b.due))[0]
  // With no milestone left, the hand-in itself is the next one.
  const next = milestone
    ? { title: milestone.title, date: Temporal.PlainDate.from(milestone.due) }
    : diss?.settings.submissionDue && diss.settings.submissionDue > today.toString()
      ? { title: 'Submission', date: zoned(diss.settings.submissionDue).toPlainDate() }
      : null

  if (upcoming.length === 0 && !next) return null
  return (
    <section className={s.section} aria-label="Deadlines">
      <div className={s.sectionHeaderStatic}>Deadlines</div>
      <ul className={s.list}>
        {upcoming.map((a) => (
          <li key={a.id}>
            <button
              className={s.deadline}
              style={{ '--cat': a.colour } as CSSProperties}
              title={`${a.title} (${a.where}) · due ${zoned(a.due).toLocaleString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
              })}`}
              onClick={() => navigate(a.to)}
            >
              <span className={s.deadlineDot} />
              <span className={s.deadlineTitle}>{a.title}</span>
              <DaysLeft due={a.left} />
            </button>
          </li>
        ))}
        {next && (
          <li>
            <button
              className={s.deadline}
              title={`Dissertation: ${next.title} · ${next.date.toLocaleString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short'
              })}`}
              onClick={() => navigate('/dissertation')}
            >
              <GraduationCap size={13} className={s.deadlineIcon} />
              <span className={s.deadlineTitle}>
                <span className={s.deadlineKind}>Dissertation · </span>
                {next.title}
              </span>
              <DaysLeft due={dueOn(next.date, today)} />
            </button>
          </li>
        )}
      </ul>
    </section>
  )
}
