import { useEffect, useState, type CSSProperties } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  CalendarCheck,
  CalendarOff,
  CircleCheck,
  ExternalLink,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { ASSIGNMENT_TYPES, type AssignmentType } from '@shared/types'
import { DEFAULT_ESTIMATE_MINUTES } from '@core/assignments'
import { atLocalTime, TZ, toIso } from '@core/time'
import { TYPE_LABEL } from './assignmentFormat'
import {
  errorMessage,
  useAssignments,
  useCreateAssignment,
  useGeneralDeadlines,
  useModules
} from '../lib/queries'
import { useNow } from '../lib/useNow'
import d from '../shell/Dialog.module.css'
import s from './Page.module.css'
import a from './Assignments.module.css'
import b from './AssignmentBoard.module.css'
import { DateField } from '../ui/DateField'
import { TimeField } from '../ui/TimeField'
import { BriefPlanDialog } from './BriefPlanDialog'
import { deleteAssignment, renameAssignment } from './assignmentActions'
import { AssignmentBoard } from './AssignmentBoard'
import { DeadlinesSection, showDeadline } from './DeadlinesSection'
import { call } from '../lib/api'
import { useFileDrop } from '../lib/files'
import { openContextMenu } from '../ui/menuStore'
import { toast } from '../ui/toastStore'
import type { AssignmentSummary } from '@shared/types'

export function AssignmentsPage() {
  const { data: assignments = [] } = useAssignments()
  const { data: modules = [] } = useModules()
  const { data: deadlines = [] } = useGeneralDeadlines()
  const [creating, setCreating] = useState(false)
  const [fromBrief, setFromBrief] = useState(false)
  const [replanning, setReplanning] = useState<string | null>(null)
  // One module's assignments and deadlines only (null: everything).
  const [only, setOnly] = useState<string | null>(null)
  const withWork = modules.filter(
    (m) =>
      assignments.some((x) => x.moduleId === m.id) || deadlines.some((d) => d.moduleId === m.id)
  )
  const filter = withWork.some((m) => m.id === only) ? only : null
  const shownAssignments = filter ? assignments.filter((x) => x.moduleId === filter) : assignments
  const shownDeadlines = filter ? deadlines.filter((d) => d.moduleId === filter) : deadlines
  const now = useNow()
  const navigate = useNavigate()
  const qc = useQueryClient()
  // Arriving from the sidebar's countdown (#deadline-<id>): show that deadline once it's drawn.
  const { hash, key } = useLocation()
  const loaded = deadlines.length > 0
  useEffect(() => {
    if (hash.startsWith('#deadline-') && loaded) showDeadline(hash.slice('#deadline-'.length))
  }, [hash, key, loaded])
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    await fn()
    await qc.invalidateQueries()
    if (done) toast(done)
  }
  const menu = (e: React.MouseEvent, x: AssignmentSummary) =>
    openContextMenu(e, [
      { heading: x.title },
      { label: 'Open', icon: ExternalLink, onSelect: () => navigate(`/assignments/${x.id}`) },
      { label: 'Rename…', icon: Pencil, onSelect: () => renameAssignment(qc, x) },
      { label: 'Re-plan from the brief…', icon: FileText, onSelect: () => setReplanning(x.id) },
      'separator',
      x.status !== 'submitted' &&
        x.planned && {
          label: 'Re-plan its work',
          icon: RefreshCw,
          onSelect: () =>
            act(() => call('assignments:reschedule', x.id), 'Its work is planned again.')
        },
      x.status !== 'submitted' &&
        (x.planned
          ? {
              label: 'Take its work off the calendar',
              icon: CalendarOff,
              onSelect: () =>
                act(
                  () => call('assignments:setPlanned', x.id, false),
                  'Off the calendar. Put it back when you’re ready.'
                )
            }
          : {
              label: 'Put its work on the calendar',
              icon: CalendarCheck,
              onSelect: () => act(() => call('assignments:setPlanned', x.id, true))
            }),
      x.status === 'submitted'
        ? {
            label: 'Not submitted after all',
            icon: Undo2,
            onSelect: () => act(() => call('assignments:submit', x.id, false))
          }
        : {
            label: 'Mark submitted',
            icon: CircleCheck,
            onSelect: () =>
              act(() => call('assignments:submit', x.id, true), 'Submitted. Well done.')
          },
      'separator',
      {
        label: 'Delete…',
        icon: Trash2,
        danger: true,
        confirm: `Delete “${x.title}” with its stages and planned work?`,
        onSelect: () => deleteAssignment(qc, x)
      }
    ])

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>Assignments</h1>
        <span className={s.subtitle}>{shownAssignments.length}</span>
        <span className={s.grow} />
        <button className={`${s.button} ${a.withIcon}`} onClick={() => setFromBrief(true)}>
          <FileText size={14} /> Plan from brief
        </button>
        <button className={`${s.button} ${a.withIcon}`} onClick={() => setCreating(true)}>
          <Plus size={14} /> New assignment
        </button>
      </header>
      {fromBrief && <BriefPlanDialog onClose={() => setFromBrief(false)} />}
      {replanning && (
        <BriefPlanDialog assignmentId={replanning} onClose={() => setReplanning(null)} />
      )}

      {withWork.length > 1 && (
        <div className={b.filters} role="group" aria-label="Show one module">
          <button className={b.chip} aria-pressed={!filter} onClick={() => setOnly(null)}>
            All
          </button>
          {withWork.map((m) => (
            <button
              key={m.id}
              className={`cat ${b.chip}`}
              style={{ '--cat': m.colour } as CSSProperties}
              aria-pressed={filter === m.id}
              title={m.name}
              onClick={() => setOnly(filter === m.id ? null : m.id)}
            >
              <span className={b.chipDot} />
              {m.shortLabel}
            </button>
          ))}
        </div>
      )}

      <AssignmentBoard
        assignments={shownAssignments}
        moduleNames={new Map(modules.map((m) => [m.id, m.name]))}
        now={now}
        onMenu={menu}
        deadlines={shownDeadlines}
        between={<DeadlinesSection deadlines={shownDeadlines} modules={modules} now={now} />}
      />

      {creating && <NewAssignmentDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

function NewAssignmentDialog({ onClose }: { onClose: () => void }) {
  const { data: modules = [] } = useModules()
  const create = useCreateAssignment()
  const navigate = useNavigate()
  const inTwoWeeks = Temporal.Now.zonedDateTimeISO(TZ).toPlainDate().add({ weeks: 2 })
  const [moduleId, setModuleId] = useState('')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<AssignmentType>('essay')
  const [date, setDate] = useState(inTwoWeeks.toString())
  const [time, setTime] = useState('12:00')
  const [weighting, setWeighting] = useState('')
  const [wordLimit, setWordLimit] = useState('')
  const [briefLink, setBriefLink] = useState('')
  const [isGroup, setIsGroup] = useState(false)
  // The brief, if you have it: pasted text and/or dropped files, attached once it's created.
  const [briefText, setBriefText] = useState('')
  const [briefFiles, setBriefFiles] = useState<string[]>([])
  const drop = useFileDrop((paths) => setBriefFiles((f) => [...f, ...paths].slice(0, 5)))
  const [hours, setHours] = useState(String(DEFAULT_ESTIMATE_MINUTES.essay / 60))
  const chosenModule = moduleId || modules[0]?.id || ''

  const submit = (planned: boolean) =>
    create.mutate(
      {
        moduleId: chosenModule,
        title,
        type,
        due: toIso(atLocalTime(date, time)),
        weighting: weighting === '' ? null : Number(weighting),
        wordLimit: wordLimit === '' ? null : Number(wordLimit),
        briefLink: briefLink || null,
        isGroup,
        estimateMinutes: Math.round(Number(hours) * 4) * 15,
        planned
      },
      {
        onSuccess: async (id) => {
          const target = { type: 'assignment' as const, id }
          try {
            if (briefFiles.length) await call('files:add', briefFiles, target)
            if (briefText.trim())
              await call('files:addText', `${title.trim()} brief`, briefText, target)
          } catch (e) {
            toast(`Created, but the brief couldn’t be added: ${errorMessage(e)}`, { tone: 'error' })
          }
          navigate(`/assignments/${id}`)
        }
      }
    )

  return (
    <div className={d.backdrop}>
      <div className={d.dialog} role="dialog" aria-label="New assignment">
        <header className={d.header}>
          <h2 className={d.title}>New assignment</h2>
          <button className={d.close} onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </header>
        <div className={d.body}>
          <div className={d.row}>
            <label className={`${d.field} ${a.grow}`}>
              Module
              <select
                className={d.select}
                value={chosenModule}
                onChange={(e) => setModuleId(e.target.value)}
              >
                {modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.shortLabel} · {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={d.field}>
              Type
              <select
                className={d.select}
                value={type}
                onChange={(e) => {
                  const t = e.target.value as AssignmentType
                  setType(t)
                  setHours(String(DEFAULT_ESTIMATE_MINUTES[t] / 60))
                }}
              >
                {ASSIGNMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={d.field}>
            Title
            <input className={d.input} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className={d.row}>
            <label className={d.field}>
              Due date
              <DateField value={date} onChange={setDate} ariaLabel="Due date" />
            </label>
            <label className={d.field}>
              Time
              <TimeField value={time} onChange={setTime} ariaLabel="Due time" />
            </label>
            <label className={d.field}>
              Estimate (hours)
              <input
                className={`${d.input} ${a.narrow}`}
                type="number"
                min={0.25}
                step={0.5}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </label>
          </div>
          <div className={d.row}>
            <label className={d.field}>
              Weighting (%)
              <input
                className={`${d.input} ${a.narrow}`}
                type="number"
                min={0}
                max={100}
                value={weighting}
                onChange={(e) => setWeighting(e.target.value)}
              />
            </label>
            <label className={d.field}>
              Word limit
              <input
                className={`${d.input} ${a.narrow}`}
                type="number"
                min={0}
                step={100}
                value={wordLimit}
                onChange={(e) => setWordLimit(e.target.value)}
              />
            </label>
            <label className={`${d.field} ${a.checkbox}`}>
              <input
                type="checkbox"
                checked={isGroup}
                onChange={(e) => setIsGroup(e.target.checked)}
              />
              Group work
            </label>
          </div>
          <div className={d.field}>
            Brief (optional)
            <div className={a.briefDrop} data-over={drop.over || undefined} {...drop.props}>
              <textarea
                className={d.textarea}
                value={briefText}
                rows={briefText ? 6 : 2}
                placeholder="Paste or type the brief, or drop its file here"
                aria-label="Brief"
                onChange={(e) => setBriefText(e.target.value)}
              />
              {briefFiles.map((p) => (
                <span key={p} className={a.briefFile}>
                  <FileText size={12} /> {p.split('/').pop()}
                  <button
                    className={d.close}
                    aria-label="Don’t attach"
                    onClick={() => setBriefFiles((f) => f.filter((x) => x !== p))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <label className={d.field}>
            Brief link (optional)
            <input
              className={d.input}
              value={briefLink}
              placeholder="https://…"
              onChange={(e) => setBriefLink(e.target.value)}
            />
          </label>
          <p className={d.muted}>
            The estimate is split into the usual stages for this type, which you can edit. Plan it
            now and its stages go on the calendar, backwards from the deadline, aiming to finish 2
            days early; or create it and plan it later from its page.
          </p>
          {create.error && <p className={d.error}>{errorMessage(create.error)}</p>}
        </div>
        <div className={d.actions}>
          <button className={d.secondary} onClick={onClose}>
            Cancel
          </button>
          <span className={d.spacer} />
          <button
            className={d.secondary}
            disabled={!title.trim() || !chosenModule || !Number(hours) || create.isPending}
            onClick={() => submit(false)}
            title="Create it without putting anything on the calendar yet"
          >
            Create, plan later
          </button>
          <button
            className={d.primary}
            disabled={!title.trim() || !chosenModule || !Number(hours) || create.isPending}
            onClick={() => submit(true)}
          >
            Create and plan
          </button>
        </div>
      </div>
    </div>
  )
}
