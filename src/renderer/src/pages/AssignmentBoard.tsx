import { useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  BookOpenText,
  CalendarOff,
  ChevronRight,
  CircleCheck,
  FileQuestion,
  FlaskConical,
  Presentation,
  Sigma,
  Users,
  type LucideIcon
} from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { AssignmentSummary, AssignmentType, GeneralDeadline } from '@shared/types'
import { formatMinutes, zoned } from '@core/time'
import { dueIn, type DueIn } from '@core/due'
import { formatDue, STATUS_LABEL, TYPE_LABEL } from './assignmentFormat'
import b from './AssignmentBoard.module.css'
import { showDeadline } from './DeadlinesSection'

// The Assignments page's list: a timeline of what's due, then a card per assignment.

const TYPE_ICON: Record<AssignmentType, LucideIcon> = {
  essay: BookOpenText,
  'lab-report': FlaskConical,
  'problem-set': Sigma,
  presentation: Presentation,
  other: FileQuestion
}

interface Props {
  assignments: AssignmentSummary[]
  /** Module id → full name. */
  moduleNames: Map<string, string>
  now: Temporal.Instant
  onMenu: (e: React.MouseEvent, x: AssignmentSummary) => void
  /** Other deadlines: on the timeline too. */
  deadlines: GeneralDeadline[]
  /** Shown after the open assignments, before the submitted ones (the Deadlines section). */
  between?: ReactNode
}

export function AssignmentBoard({
  assignments,
  moduleNames,
  now,
  onMenu,
  deadlines,
  between
}: Props) {
  const today = zoned(now).toPlainDate()
  const open = assignments
    .filter((x) => x.status !== 'submitted')
    .sort((p, q) => p.due.localeCompare(q.due))
  const submitted = assignments
    .filter((x) => x.status === 'submitted')
    .sort((p, q) => q.due.localeCompare(p.due))
  const marked = submitted.filter((x) => x.mark != null)
  const average = marked.length ? marked.reduce((sum, x) => sum + x.mark!, 0) / marked.length : null
  // Handed-in work folds away once there's a fair amount of it.
  const [showSubmitted, setShowSubmitted] = useState<boolean | null>(null)
  const submittedOpen = showSubmitted ?? submitted.length <= 4

  const marks: Mark[] = [
    ...open.map((x) => ({
      id: x.id,
      due: x.due,
      colour: x.colour,
      label: x.moduleLabel,
      title: x.title,
      to: `/assignments/${x.id}`,
      shape: 'dot' as const
    })),
    ...deadlines
      .filter((d) => !d.doneAt)
      .map((d) => ({
        id: d.id,
        due: d.due,
        colour: d.colour,
        label: d.title.length > 16 ? `${d.title.slice(0, 15)}…` : d.title,
        title: d.title,
        to: `#deadline-${d.id}`,
        shape: 'diamond' as const
      }))
  ].sort((p, q) => p.due.localeCompare(q.due))
  return (
    <>
      {marks.length > 0 && <Timeline items={marks} today={today} />}
      {assignments.length === 0 && <p className={b.empty}>No assignments here yet.</p>}
      <div className={b.grid}>
        {open.map((x) => (
          <AssignmentCard
            key={x.id}
            x={x}
            moduleName={moduleNames.get(x.moduleId) ?? x.moduleLabel}
            due={dueIn(x.due, now)}
            onMenu={onMenu}
          />
        ))}
      </div>
      {between}
      {submitted.length > 0 && (
        <>
          <h2 className={b.groupTitle}>
            <button
              className={b.fold}
              aria-expanded={submittedOpen}
              onClick={() => setShowSubmitted(!submittedOpen)}
            >
              <ChevronRight size={14} className={b.foldIcon} />
              Submitted <span className="num">{submitted.length}</span>
            </button>
            {average != null && (
              <span
                className={`${b.average} num`}
                title={`Average of the ${marked.length} marked so far (not weighted)`}
              >
                average {Math.round(average * 10) / 10}%
              </span>
            )}
          </h2>
          {submittedOpen && (
            <div className={b.grid}>
              {submitted.map((x) => (
                <AssignmentCard
                  key={x.id}
                  x={x}
                  moduleName={moduleNames.get(x.moduleId) ?? x.moduleLabel}
                  due={dueIn(x.due, now)}
                  onMenu={onMenu}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

function AssignmentCard({
  x,
  moduleName,
  due,
  onMenu
}: {
  x: AssignmentSummary
  moduleName: string
  due: DueIn
  onMenu: Props['onMenu']
}) {
  const done = x.status === 'submitted'
  const Icon = TYPE_ICON[x.type]
  // One segment per stage (a plain bar when there are lots).
  const segments = x.stagesTotal > 0 && x.stagesTotal <= 12
  const pct = x.stagesTotal ? (x.stagesDone / x.stagesTotal) * 100 : 0
  return (
    <Link
      to={`/assignments/${x.id}`}
      className={`cat ${b.card}`}
      style={{ '--cat': x.colour } as CSSProperties}
      data-submitted={done || undefined}
      onContextMenu={(e) => onMenu(e, x)}
    >
      <div className={b.top}>
        <div className={b.heading}>
          <div className={b.module}>
            <span className={b.dot} />
            <span className={b.moduleName}>{moduleName}</span>
          </div>
          <h3 className={b.title}>{x.title}</h3>
        </div>
        {done && x.mark != null ? (
          <div className={`${b.countdown} num`} data-urgency="done" aria-label={`Mark ${x.mark}%`}>
            <span className={b.countNumber}>{x.mark}%</span>
            <span className={b.countLabel}>mark</span>
          </div>
        ) : done ? (
          <div className={b.countdown} data-urgency="done">
            <CircleCheck size={20} />
            <span className={b.countLabel}>Submitted</span>
          </div>
        ) : (
          <div className={`${b.countdown} num`} data-urgency={due.urgency} aria-label={due.label}>
            {due.days === 0 ? (
              <>
                <span className={b.countNumber}>{due.late ? 'Late' : 'Today'}</span>
                {due.late && <span className={b.countLabel}>due today</span>}
              </>
            ) : (
              <>
                <span className={b.countNumber}>{Math.abs(due.days)}</span>
                <span className={b.countLabel}>
                  {due.days < 0 ? 'days late' : due.days === 1 ? 'day left' : 'days left'}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <div className={b.meta}>
        <span className={b.type}>
          <Icon size={13} /> {TYPE_LABEL[x.type]}
        </span>
        {x.weighting != null && <span className={`${b.pill} num`}>{x.weighting}%</span>}
        {x.isGroup && (
          <span className={b.pill} title="Group work">
            <Users size={11} /> Group
          </span>
        )}
        <span className={`${b.due} num`}>Due {formatDue(x.due)}</span>
      </div>

      <div className={b.progress}>
        {segments ? (
          <div className={b.segments}>
            {Array.from({ length: x.stagesTotal }, (_, i) => (
              <span key={i} className={b.segment} data-done={i < x.stagesDone || undefined} />
            ))}
          </div>
        ) : (
          <div className={b.bar}>
            <div className={b.fill} style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className={b.footer}>
          <span className={`${b.muted} num`}>
            {x.stagesDone}/{x.stagesTotal} stages · {formatMinutes(x.loggedMinutes)} of{' '}
            {formatMinutes(x.estimateMinutes)}
          </span>
          <span className={b.grow} />
          {!x.planned && !done && (
            <span className={b.off} title="Its work isn’t on the calendar yet">
              <CalendarOff size={11} /> Off the calendar
            </span>
          )}
          {!done && (
            <span className={b.status} data-status={x.status}>
              {STATUS_LABEL[x.status]}
            </span>
          )}
        </div>
      </div>
    </Link>
  )
}

/** One thing on the timeline: an assignment (a dot) or another deadline (a diamond). */
interface Mark {
  id: string
  due: string
  colour: string | null
  label: string
  title: string
  /** A route, or "#id" to scroll to it on this page. */
  to: string
  shape: 'dot' | 'diamond'
}

/** What's due across the coming weeks, with today at the left. */
function Timeline({ items, today }: { items: Mark[]; today: Temporal.PlainDate }) {
  const monday = today.subtract({ days: today.dayOfWeek - 1 })
  const lastDue = zoned(items.at(-1)!.due).toPlainDate()
  // At least 6 weeks, at most 16, always ending on a week boundary.
  const weeks = Math.min(16, Math.max(6, Math.ceil(monday.until(lastDue).days / 7) + 1))
  const span = weeks * 7
  const at = (d: Temporal.PlainDate) => (monday.until(d).days / span) * 100
  // Anything due before this week sits at the left edge, marked late; anything past the end is
  // counted at the right, so nothing open goes missing.
  const shown = items.filter((x) => at(zoned(x.due).toPlainDate()) <= 100)
  const later = items.filter((x) => at(zoned(x.due).toPlainDate()) > 100)
  return (
    <div className={b.timeline} aria-label="Deadlines over the coming weeks">
      <div className={b.track}>
        {Array.from({ length: weeks + 1 }, (_, i) => {
          const d = monday.add({ weeks: i })
          return (
            <span key={i} className={b.tick} style={{ left: `${(i / weeks) * 100}%` }}>
              {i < weeks && (
                <span className={b.tickLabel}>
                  {d.toLocaleString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              )}
            </span>
          )
        })}
        <span className={b.today} style={{ left: `${at(today)}%` }} title="Today" />
        {shown.map((x, i) => {
          const pos = at(zoned(x.due).toPlainDate())
          const style = {
            '--cat': x.colour ?? 'var(--text-2)',
            left: `${Math.max(0, pos)}%`
          } as CSSProperties
          const late = pos < 0 || undefined
          const label = <span className={b.markerLabel}>{x.label}</span>
          const title = `${x.title} · due ${formatDue(x.due)}${late ? ' (late)' : ''}`
          return x.to.startsWith('#') ? (
            <a
              key={x.id}
              href={x.to}
              className={`cat ${b.marker}`}
              data-row={i % 2}
              data-shape={x.shape}
              data-late={late}
              style={style}
              title={title}
              onClick={(e) => {
                e.preventDefault()
                showDeadline(x.to.slice('#deadline-'.length))
              }}
            >
              {label}
            </a>
          ) : (
            <Link
              key={x.id}
              to={x.to}
              className={`cat ${b.marker}`}
              data-row={i % 2}
              data-shape={x.shape}
              data-late={late}
              style={style}
              title={title}
            >
              {label}
            </Link>
          )
        })}
        {later.length > 0 && (
          <span
            className={b.later}
            title={later.map((x) => `${x.title} · due ${formatDue(x.due)}`).join('\n')}
          >
            +{later.length} later
          </span>
        )}
      </div>
    </div>
  )
}
