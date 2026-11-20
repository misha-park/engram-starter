import { useState, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ArrowDown,
  CalendarDays,
  ChevronDown,
  CalendarPlus,
  CircleCheck,
  CalendarX,
  ArrowUp,
  ExternalLink,
  FileText,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users
} from 'lucide-react'
import {
  ASSIGNMENT_TYPES,
  type AssignmentDetail,
  type AssignmentType,
  type StageDetail
} from '@shared/types'
import { atLocalTime, formatClock, formatMinutes, toIso, zoned } from '@core/time'
import {
  errorMessage,
  useAddStage,
  useAssignment,
  useMoveStage,
  useRescheduleAssignment,
  useSubmitAssignment,
  useUpdateAssignment,
  useUpdateStage
} from '../lib/queries'
import { useNow } from '../lib/useNow'
import { useSynced } from '../lib/useSynced'
import { call } from '../lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { formatDue, relativeDays, STATUS_LABEL, TYPE_LABEL } from './assignmentFormat'
import s from './Page.module.css'
import a from './Assignments.module.css'
import { DateField } from '../ui/DateField'
import { TimeField } from '../ui/TimeField'
import { useAssistantScreen } from '../assistant/store'
import { Attachments } from '../ui/Attachments'
import { openContextMenu } from '../ui/menuStore'
import { askText } from '../ui/promptStore'
import { toast } from '../ui/toastStore'
import { BriefPlanDialog } from './BriefPlanDialog'
import { deleteAssignment, removeStage, renameAssignment } from './assignmentActions'

const hours = (m: number) => String(Math.round((m / 60) * 4) / 4)

export function AssignmentPage() {
  const { id = '' } = useParams()
  useAssistantScreen({ assignmentId: id || undefined })
  const { data: assignment, isLoading } = useAssignment(id)
  if (isLoading) return null
  if (!assignment) {
    return (
      <div className={s.page}>
        <Link to="/assignments" className={a.back}>
          ← Assignments
        </Link>
        <p className={s.muted}>Assignment not found.</p>
      </div>
    )
  }
  // Keyed on the id only: a refresh while you type (a sync, a running timer) keeps your edits.
  return <AssignmentView key={assignment.id} a={assignment} />
}

function AssignmentView({ a: x }: { a: AssignmentDetail }) {
  const now = useNow()
  const navigate = useNavigate()
  const submit = useSubmitAssignment()
  const qc = useQueryClient()
  const replan = useRescheduleAssignment()
  const [planning, setPlanning] = useState(false)
  const submitted = x.status === 'submitted'
  const openStages = x.stages.filter((st) => !st.done)
  const pickStage = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { heading: 'Add a block of…' },
      ...openStages.map((st) => ({ label: st.name, onSelect: () => addBlock(qc, st, navigate) }))
    ])
  const pct = x.estimateMinutes ? Math.min(100, (x.loggedMinutes / x.estimateMinutes) * 100) : 0
  const plannedAhead = x.stages
    .flatMap((st) => st.blocks)
    .filter((b) => b.start > toIso(now) && b.outcome === 'none')
    .reduce((sum, b) => sum + (Date.parse(b.end) - Date.parse(b.start)) / 60000, 0)

  return (
    <div className={`cat ${s.page}`} style={{ '--cat': x.colour } as CSSProperties}>
      <Link to="/assignments" className={a.back}>
        ← Assignments
      </Link>
      <header className={s.header}>
        <span className={a.swatch} />
        <h1
          className={s.title}
          onDoubleClick={() => void renameAssignment(qc, x)}
          title="Double-click to rename"
        >
          {x.title}
        </h1>
        <button
          className={a.iconButton}
          title="Rename assignment"
          aria-label="Rename assignment"
          onClick={() => void renameAssignment(qc, x)}
        >
          <Pencil size={13} />
        </button>
        <span className={s.subtitle}>{x.moduleLabel}</span>
        {x.isGroup && <Users size={14} className={s.muted} aria-label="Group work" />}
        <span className={a.status} data-status={x.status}>
          {STATUS_LABEL[x.status]}
        </span>
        <span className={s.grow} />
        {!submitted && (
          <button
            className={`${s.button} ${a.withIcon}`}
            title="Re-plan the stages from the brief"
            onClick={() => setPlanning(true)}
          >
            <FileText size={14} /> Plan from brief
          </button>
        )}
        {!submitted && openStages.length > 0 && (
          <span className={a.splitButton}>
            <button
              className={`${s.button} ${a.withIcon}`}
              title="Put one block of work on the calendar (e.g. just 3 hours)"
              onClick={() => void addBlock(qc, openStages[0], navigate, x.title)}
              onContextMenu={pickStage}
            >
              <Plus size={14} /> Add a block
            </button>
            <button
              className={s.button}
              title="Add a block for a particular stage"
              aria-label="Add a block for a particular stage"
              onClick={pickStage}
            >
              <ChevronDown size={14} />
            </button>
          </span>
        )}
        {!submitted && <PlanToggle a={x} />}
        <button
          className={`${s.button} ${a.withIcon}`}
          onClick={() => submit.mutate({ id: x.id, submitted: !submitted })}
          disabled={submit.isPending}
        >
          <CircleCheck size={14} /> {submitted ? 'Mark not submitted' : 'Mark submitted'}
        </button>
        <button
          className={s.button}
          title="Delete assignment"
          onClick={(e) =>
            openContextMenu(e, [
              {
                label: 'Delete assignment…',
                icon: Trash2,
                danger: true,
                confirm: `Delete “${x.title}”? Its planned blocks go too; finished work stays.`,
                onSelect: async () => {
                  await deleteAssignment(qc, x)
                  navigate('/assignments')
                }
              }
            ])
          }
        >
          <Trash2 size={14} />
        </button>
      </header>

      <section className={s.section}>
        <div className={a.stats}>
          <span>
            Due{' '}
            <strong className="num">
              {formatDue(x.due)} ({relativeDays(x.due, now)})
            </strong>
          </span>
          <span>
            <strong className="num">
              {x.stagesDone}/{x.stagesTotal}
            </strong>{' '}
            stages done
          </span>
          <span>
            <strong className="num">{formatMinutes(x.loggedMinutes)}</strong> of{' '}
            {formatMinutes(x.estimateMinutes)} logged
          </span>
          {!submitted && (
            <span>
              <strong className="num">{formatMinutes(plannedAhead)}</strong> planned ahead
            </span>
          )}
        </div>
        <div
          className={a.bigBar}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={a.fill} style={{ width: `${pct}%` }} />
        </div>
        {!submitted && !x.planned && (
          <p className={a.note}>
            <Info size={13} /> Not on the calendar yet. Plan on calendar puts its stages in,
            backwards from the deadline, or Add a block puts in one block at a time.
          </p>
        )}
        {!submitted && x.unplacedMinutes > 0 && (
          <p className={a.note}>
            <Info size={13} /> {formatMinutes(x.unplacedMinutes)} didn’t fit before the deadline.
          </p>
        )}
      </section>

      <div className={a.columns}>
        <div className={a.mainColumn}>
          {submitted && <Result a={x} />}
          <BriefSummary a={x} />
          <Stages a={x} />
          {!submitted && (
            <p className={a.note}>
              Stage blocks are planned backwards from the deadline, aiming to finish 2 days early.
              Blocks you’ve moved or finished stay put.
              <button
                className={`${s.button} ${a.withIcon}`}
                onClick={() => replan.mutate(x.id)}
                disabled={replan.isPending}
              >
                <RefreshCw size={13} /> Replan now
              </button>
            </p>
          )}
        </div>
        <aside className={a.sideColumn}>
          <section className={s.section}>
            <h2 className={s.sectionTitle}>Files</h2>
            <Attachments
              target={{ type: 'assignment', id: x.id }}
              hint="Drop the brief, marking criteria or data here."
              pasteLabel="Paste the brief…"
            />
          </section>
          <Notes a={x} />
          <Details a={x} />
        </aside>
      </div>

      {planning && <BriefPlanDialog assignmentId={x.id} onClose={() => setPlanning(false)} />}
      {(submit.error || replan.error) && (
        <p className={s.errorText}>{errorMessage(submit.error ?? replan.error)}</p>
      )}
    </div>
  )
}

function Stages({ a: x }: { a: AssignmentDetail }) {
  const add = useAddStage()
  const [name, setName] = useState('')
  const [estimate, setEstimate] = useState('2')
  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Stages</h2>
      <div className={s.card}>
        {x.stages.map((stage, i) => (
          <StageRow key={stage.id} stage={stage} first={i === 0} last={i === x.stages.length - 1} />
        ))}
        <div className={a.addStage}>
          <input
            className={`${s.input} ${s.grow}`}
            placeholder="Add a stage"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={`${s.input} ${a.hoursInput}`}
            type="number"
            min={0.25}
            step={0.5}
            value={estimate}
            aria-label="Estimate in hours"
            onChange={(e) => setEstimate(e.target.value)}
          />
          <span className={s.muted}>h</span>
          <button
            className={`${s.button} ${a.withIcon}`}
            disabled={!name.trim() || !Number(estimate) || add.isPending}
            onClick={() =>
              add.mutate(
                {
                  assignmentId: x.id,
                  name,
                  estimateMinutes: Math.round(Number(estimate) * 4) * 15
                },
                { onSuccess: () => setName('') }
              )
            }
          >
            <Plus size={13} /> Add
          </button>
        </div>
      </div>
      {add.error && <p className={s.errorText}>{errorMessage(add.error)}</p>}
    </section>
  )
}

/** Ask how long, then put one block of the stage in the next free slot. */
async function addBlock(
  qc: ReturnType<typeof useQueryClient>,
  stage: StageDetail,
  navigate: ReturnType<typeof useNavigate>,
  /** Without picking a stage: the block goes to the next one not done. */
  assignmentTitle?: string
) {
  const answer = await askText({
    title: assignmentTitle
      ? `Add a block of “${assignmentTitle}”`
      : `Add a block of “${stage.name}”`,
    initial: '2',
    placeholder: 'Hours, e.g. 3 or 1.5',
    okLabel: 'Add',
    note: assignmentTitle
      ? `It goes in the next free slot and counts towards the next stage, “${stage.name}”.`
      : 'It goes in the next free slot; move it on the calendar if you like.'
  })
  if (answer === null) return
  const minutes = Math.round(Number(answer.replace(',', '.').replace(/h$/i, '')) * 4) * 15
  try {
    const block = await call('stages:addBlock', stage.id, minutes)
    await qc.invalidateQueries()
    const when = zoned(block.start)
      .toPlainDate()
      .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    toast(
      `Added ${formatMinutes(minutes)} of “${stage.name}”, ${when} ${formatClock(block.start)}.`,
      {
        action: { label: 'Show', run: () => navigate(`/?block=${block.id}`) }
      }
    )
  } catch (e) {
    toast(errorMessage(e), { tone: 'error' })
  }
}

function StageRow({ stage, first, last }: { stage: StageDetail; first: boolean; last: boolean }) {
  const update = useUpdateStage()
  const qc = useQueryClient()
  const move = useMoveStage()
  const now = useNow()
  const [name, setName] = useSynced(stage.name)
  const [estimate, setEstimate] = useSynced(hours(stage.estimateMinutes))
  const next = stage.blocks.find((b) => b.start > toIso(now) && b.outcome === 'none')
  const ahead = stage.blocks.filter((b) => b.start > toIso(now) && b.outcome === 'none').length
  const navigate = useNavigate()
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { heading: stage.name },
      {
        label: stage.done ? 'Not done after all' : 'Mark done',
        icon: CircleCheck,
        onSelect: () => update.mutateAsync({ id: stage.id, patch: { done: !stage.done } })
      },
      !stage.done && {
        label: 'Add a block…',
        icon: CalendarPlus,
        onSelect: () => addBlock(qc, stage, navigate)
      },
      next && {
        label: 'Show its next block',
        icon: CalendarDays,
        onSelect: () => navigate(`/?block=${next.id}`)
      },
      'separator',
      !first && {
        label: 'Move up',
        icon: ArrowUp,
        onSelect: () => move.mutateAsync({ id: stage.id, direction: -1 })
      },
      !last && {
        label: 'Move down',
        icon: ArrowDown,
        onSelect: () => move.mutateAsync({ id: stage.id, direction: 1 })
      },
      'separator',
      {
        label: 'Remove stage…',
        icon: Trash2,
        danger: true,
        confirm: `Remove “${stage.name}” and its planned blocks?`,
        onSelect: () => removeStage(qc, stage)
      }
    ])

  return (
    <div className={a.stageRow} data-done={stage.done || undefined} onContextMenu={menu}>
      <input
        type="checkbox"
        className={a.check}
        checked={stage.done}
        aria-label={`${stage.name} done`}
        onChange={(e) => update.mutate({ id: stage.id, patch: { done: e.target.checked } })}
      />
      <input
        className={a.stageName}
        value={name}
        aria-label="Stage name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() =>
          name.trim() && name !== stage.name && update.mutate({ id: stage.id, patch: { name } })
        }
      />
      <span className={a.stageMeta}>
        <input
          className={`${s.input} ${a.hoursInput}`}
          type="number"
          min={0.25}
          step={0.5}
          value={estimate}
          aria-label="Estimate in hours"
          onChange={(e) => setEstimate(e.target.value)}
          onBlur={() => {
            const minutes = Math.round(Number(estimate) * 4) * 15
            if (minutes && minutes !== stage.estimateMinutes) {
              update.mutate({ id: stage.id, patch: { estimateMinutes: minutes } })
            }
          }}
        />{' '}
        h
      </span>
      <span className={`${a.stageMeta} num`}>
        {formatMinutes(stage.loggedMinutes)} logged
        <br />
        {stage.done ? (
          'Done'
        ) : next ? (
          <>
            {ahead} block{ahead === 1 ? '' : 's'} ·{' '}
            <button
              className={a.nextLink}
              title="Show it on the calendar"
              onClick={() => navigate(`/?block=${next.id}`)}
            >
              next{' '}
              {zoned(next.start)
                .toPlainDate()
                .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}{' '}
              {formatClock(next.start)}
            </button>
          </>
        ) : (
          'Nothing planned'
        )}
      </span>
      <span className={a.stageButtons}>
        {!stage.done && (
          <button
            className={a.iconButton}
            title="Add a block of this stage to the calendar"
            onClick={() => void addBlock(qc, stage, navigate)}
          >
            <CalendarPlus size={13} />
          </button>
        )}
        <button
          className={a.iconButton}
          disabled={first}
          title="Move up"
          onClick={() => move.mutate({ id: stage.id, direction: -1 })}
        >
          <ArrowUp size={13} />
        </button>
        <button
          className={a.iconButton}
          disabled={last}
          title="Move down"
          onClick={() => move.mutate({ id: stage.id, direction: 1 })}
        >
          <ArrowDown size={13} />
        </button>
        <button
          className={a.iconButton}
          title="Remove stage"
          onClick={(e) =>
            openContextMenu(e, [
              {
                label: 'Remove stage…',
                icon: Trash2,
                danger: true,
                confirm: `Remove “${stage.name}” and its planned blocks?`,
                onSelect: () => removeStage(qc, stage)
              }
            ])
          }
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )
}

function Details({ a: x }: { a: AssignmentDetail }) {
  const update = useUpdateAssignment()
  const due = zoned(x.due)
  const [date, setDate] = useSynced(due.toPlainDate().toString())
  const [time, setTime] = useSynced(formatClock(x.due))
  const [weighting, setWeighting] = useSynced(x.weighting?.toString() ?? '')
  const [wordLimit, setWordLimit] = useSynced(x.wordLimit?.toString() ?? '')
  const [briefLink, setBriefLink] = useSynced(x.briefLink ?? '')
  const [total, setTotal] = useSynced(String(x.estimateMinutes / 60))
  const [totalError, setTotalError] = useState<string | null>(null)
  const qc = useQueryClient()
  const save = (patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: x.id, patch })
  const saveTotal = async () => {
    const minutes = Math.round(Number(total) * 4) * 15
    if (!minutes || minutes === x.estimateMinutes) return
    setTotalError(null)
    try {
      await call('assignments:setTotal', x.id, minutes)
      await qc.invalidateQueries()
    } catch (e) {
      setTotalError(errorMessage(e))
      setTotal(String(x.estimateMinutes / 60))
    }
  }
  const saveDue = (d: string, t: string) => {
    if (!d || !t) return
    const iso = toIso(atLocalTime(d, t))
    if (iso !== x.due) save({ due: iso })
  }

  return (
    <details className={`${s.section} ${a.collapsible}`} open>
      <summary className={s.sectionTitle}>Details</summary>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Due</div>
            <div className={s.muted}>Changing it replans the stage blocks to match.</div>
          </div>
          <DateField
            value={date}
            ariaLabel="Due date"
            onChange={(v) => {
              setDate(v)
              saveDue(v, time)
            }}
          />
          <TimeField
            value={time}
            ariaLabel="Due time"
            onChange={(v) => {
              setTime(v)
              saveDue(date, v)
            }}
          />
        </div>
        <div className={s.row}>
          <div className={s.grow}>Type</div>
          <select
            className={s.input}
            value={x.type}
            onChange={(e) => save({ type: e.target.value as AssignmentType })}
          >
            {ASSIGNMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Total time</div>
            <div className={s.muted}>
              Changing it rescales the stages not done yet, and re-plans them.
            </div>
            {totalError && <div className={s.errorText}>{totalError}</div>}
          </div>
          <input
            className={`${s.input} ${a.hoursInput}`}
            type="number"
            min={0.25}
            step={0.5}
            aria-label="Total time in hours"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            onBlur={() => void saveTotal()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <span className={s.muted}>h</span>
        </div>
        <div className={s.row}>
          <div className={s.grow}>Weighting</div>
          <input
            className={`${s.input} ${a.hoursInput}`}
            type="number"
            min={0}
            max={100}
            value={weighting}
            onChange={(e) => setWeighting(e.target.value)}
            onBlur={() => save({ weighting: weighting === '' ? null : Number(weighting) })}
          />
          <span className={s.muted}>%</span>
        </div>
        <div className={s.row}>
          <div className={s.grow}>Word limit</div>
          <input
            className={`${s.input} ${a.narrow}`}
            type="number"
            min={0}
            step={100}
            value={wordLimit}
            onChange={(e) => setWordLimit(e.target.value)}
            onBlur={() => save({ wordLimit: wordLimit === '' ? null : Number(wordLimit) })}
          />
        </div>
        <div className={s.row}>
          <div className={s.grow}>Group work</div>
          <input
            type="checkbox"
            className={a.check}
            checked={x.isGroup}
            onChange={(e) => save({ isGroup: e.target.checked })}
          />
        </div>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Brief</div>
            <input
              className={`${s.input} ${a.briefInput}`}
              value={briefLink}
              placeholder="https://…"
              onChange={(e) => setBriefLink(e.target.value)}
              onBlur={() =>
                briefLink !== (x.briefLink ?? '') && save({ briefLink: briefLink || null })
              }
            />
          </div>
          {x.briefLink?.startsWith('https://') && (
            <a
              className={`${s.button} ${a.withIcon}`}
              href={x.briefLink}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={13} /> Open
            </a>
          )}
        </div>
      </div>
      {update.error && <p className={s.errorText}>{errorMessage(update.error)}</p>}
    </details>
  )
}

/** Once it's handed in: the mark it got and the feedback (saved when you click away). */
function Result({ a: x }: { a: AssignmentDetail }) {
  const update = useUpdateAssignment()
  const [mark, setMark] = useSynced(x.mark?.toString() ?? '')
  const [feedback, setFeedback] = useSynced(x.feedback ?? '')
  const saveMark = () => {
    const value = mark.trim() === '' ? null : Number(mark)
    if (value !== x.mark && (value === null || Number.isFinite(value))) {
      update.mutate({ id: x.id, patch: { mark: value } })
    }
  }
  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Result</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Mark</div>
            <div className={s.muted}>Once it’s back. It shows on the Assignments page.</div>
          </div>
          <input
            className={`${s.input} ${a.hoursInput}`}
            type="number"
            min={0}
            max={100}
            step={0.5}
            aria-label="Mark in percent"
            value={mark}
            onChange={(e) => setMark(e.target.value)}
            onBlur={saveMark}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <span className={s.muted}>%</span>
        </div>
        <div className={a.feedbackRow}>
          <textarea
            className={`${a.textarea} ${a.notesBox}`}
            value={feedback}
            placeholder="Feedback: paste it or note the main points, for next time"
            aria-label="Feedback"
            onChange={(e) => setFeedback(e.target.value)}
            onBlur={() =>
              feedback !== (x.feedback ?? '') &&
              update.mutate({ id: x.id, patch: { feedback: feedback || null } })
            }
          />
        </div>
      </div>
      {update.error && <p className={s.errorText}>{errorMessage(update.error)}</p>}
    </section>
  )
}

/** Your notes on the assignment (saved when you click away). */
function Notes({ a: x }: { a: AssignmentDetail }) {
  const update = useUpdateAssignment()
  const [notes, setNotes] = useSynced(x.notes ?? '')
  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Notes</h2>
      <textarea
        className={`${a.textarea} ${a.notesBox}`}
        value={notes}
        placeholder="Anything to remember about this assignment"
        aria-label="Notes"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() =>
          notes !== (x.notes ?? '') && update.mutate({ id: x.id, patch: { notes: notes || null } })
        }
      />
    </section>
  )
}

/**
 * What the assignment asks for, summarised from its brief by Claude (editable). Organisation
 * only: the task and what to hand in, never ideas for the work itself.
 */
function BriefSummary({ a: x }: { a: AssignmentDetail }) {
  const qc = useQueryClient()
  const update = useUpdateAssignment()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useSynced(x.summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const summarise = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('assignments:summarise', x.id)
      await qc.invalidateQueries({ queryKey: ['assignment', x.id] })
      await qc.invalidateQueries({ queryKey: ['assignments'] })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    update.mutate({ id: x.id, patch: { summary: text.trim() || null } })
    setEditing(false)
  }
  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>What it is</h2>
      <div className={`${s.card} ${a.summary}`}>
        {editing ? (
          <>
            <textarea
              className={a.summaryInput}
              value={text}
              autoFocus
              aria-label="Summary"
              onChange={(e) => setText(e.target.value)}
            />
            <div className={a.summaryActions}>
              <button className={s.button} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className={s.button} onClick={save}>
                Save
              </button>
            </div>
          </>
        ) : x.summary ? (
          <>
            <p className={a.summaryText}>{x.summary}</p>
            <div className={a.summaryActions}>
              <button
                className={s.button}
                onClick={() => setEditing(true)}
                title="Edit the summary"
              >
                <Pencil size={13} /> Edit
              </button>
              <button
                className={s.button}
                disabled={busy}
                onClick={() => void summarise()}
                title="Summarise the brief again"
              >
                <Sparkles size={13} /> {busy ? 'Reading the brief…' : 'Summarise again'}
              </button>
            </div>
          </>
        ) : (
          <div className={a.summaryEmpty}>
            <span className={s.muted}>
              No summary yet. Claude can summarise what the brief asks for: the task, what to hand
              in and how it’s marked.
            </span>
            <button className={s.button} disabled={busy} onClick={() => void summarise()}>
              <Sparkles size={13} /> {busy ? 'Reading the brief…' : 'Summarise brief'}
            </button>
            <button className={s.button} onClick={() => setEditing(true)}>
              Write one
            </button>
          </div>
        )}
      </div>
      {error && <p className={s.errorText}>{error}</p>}
    </section>
  )
}

/** Take the assignment's planned work off the calendar, or put it (back) on. */
function PlanToggle({ a: x }: { a: AssignmentDetail }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    if (
      x.planned &&
      !window.confirm(
        `Take “${x.title}” off the calendar? Its planned blocks are removed (finished work stays) and nothing is planned until you plan it again.`
      )
    )
      return
    setBusy(true)
    try {
      await call('assignments:setPlanned', x.id, !x.planned)
      await qc.invalidateQueries()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className={`${s.button} ${a.withIcon}`}
      disabled={busy}
      title={
        x.planned
          ? 'Remove all its planned blocks from the calendar'
          : 'Plan its stages on the calendar, backwards from the deadline'
      }
      onClick={() => void toggle()}
    >
      {x.planned ? <CalendarX size={14} /> : <CalendarPlus size={14} />}
      {x.planned ? 'Remove from calendar' : 'Plan on calendar'}
    </button>
  )
}
