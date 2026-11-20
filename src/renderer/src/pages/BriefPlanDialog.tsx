import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { LoaderCircle, Plus, Trash2, X } from 'lucide-react'
import {
  ASSIGNMENT_TYPES,
  type AssignmentPlanDraft,
  type AssignmentType,
  type Attachment
} from '@shared/types'
import { Temporal } from 'temporal-polyfill'
import { formatMinutes, TZ } from '@core/time'
import { call } from '../lib/api'
import { PLAN_BRIEF_EVENT } from '../lib/files'
import { BriefInput } from '../ui/BriefInput'
import { briefName } from '../ui/briefName'
import { errorMessage, useAssistantStatus, useModules } from '../lib/queries'
import { DateField } from '../ui/DateField'
import { TimeField } from '../ui/TimeField'
import { TYPE_LABEL } from './assignmentFormat'
import d from '../shell/Dialog.module.css'
import b from './BriefPlan.module.css'

/**
 * Plan from brief: drop or choose the brief (or marking criteria); Claude suggests the
 * assignment's details and stages; the user edits them, then saves. For a new assignment, or
 * to re-plan an existing one (stages already started are kept).
 */
export function BriefPlanDialog({
  assignmentId = null,
  attachmentId = null,
  onClose
}: {
  assignmentId?: string | null
  attachmentId?: string | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { data: claude } = useAssistantStatus()
  const { data: modules = [] } = useModules()
  const [file, setFile] = useState<Attachment | null>(null)
  const [draft, setDraft] = useState<AssignmentPlanDraft | null>(null)
  const [working, setWorking] = useState<'reading' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const plan = async (a: Attachment) => {
    setFile(a)
    setError(null)
    setWorking('reading')
    try {
      setDraft(await call('brief:draft', a.id))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWorking(null)
    }
  }
  const add = async (fn: () => Promise<Attachment[] | null>) => {
    setError(null)
    try {
      const added = await fn()
      if (added?.[0]) await plan(added[0])
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  // Opened with a file (from the chat or an attachment): plan from it straight away.
  useEffect(() => {
    if (!attachmentId || started.current) return
    started.current = true
    void call('files:get', [attachmentId]).then(([a]) =>
      a ? plan(a) : setError('That file is no longer in Engram.')
    )
  }, [attachmentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !working && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, working])

  const save = async (planned = true) => {
    if (!draft) return
    setWorking('saving')
    setError(null)
    try {
      const id = await call('brief:apply', draft, {
        assignmentId,
        attachmentId: file?.id ?? null,
        planned
      })
      onClose()
      navigate(`/assignments/${id}`)
    } catch (e) {
      setError(errorMessage(e))
      setWorking(null)
    }
  }

  const patch = (p: Partial<AssignmentPlanDraft>) => setDraft((x) => (x ? { ...x, ...p } : x))
  const missing = draft
    ? [
        !assignmentId && !draft.title?.trim() && 'a title',
        !assignmentId && !draft.moduleId && 'the module',
        !assignmentId && !draft.dueDate && 'the due date',
        !draft.stages.length && 'a stage',
        draft.stages.some((s) => !s.name.trim()) && 'a name for every stage'
      ].filter((x): x is string => !!x)
    : []
  const total = draft?.stages.reduce((sum, s) => sum + s.minutes, 0) ?? 0

  return (
    <div className={d.backdrop}>
      <div className={`${d.dialog} ${b.dialog}`} role="dialog" aria-label="Plan from brief">
        <header className={d.header}>
          <h2 className={d.title}>{assignmentId ? 'Re-plan from the brief' : 'Plan from brief'}</h2>
          <button className={d.close} onClick={onClose} disabled={!!working} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <div className={`${d.body} ${b.body}`}>
          {!file ? (
            <>
              <p className={d.lead}>
                Drop the assignment brief or marking criteria (Word, PDF or text), or paste its
                text. Claude suggests the details and the stages of work; you check them before
                anything is saved. It never writes any of the assignment.
              </p>
              {claude && !claude.hasToken && (
                <p className={d.error}>Add your Claude token in Settings first.</p>
              )}
              <BriefInput
                onPaths={(paths) => void add(() => call('files:add', paths.slice(0, 1), null))}
                onChoose={() => void add(() => call('files:choose', null))}
                onText={(text) =>
                  add(async () => [await call('files:addText', briefName(text), text, null)])
                }
              />
            </>
          ) : working === 'reading' ? (
            <p className={b.reading}>
              <LoaderCircle size={14} className={b.spin} /> Claude is reading “{file.name}”…
            </p>
          ) : draft ? (
            <div className={b.draft}>
              <p className={d.muted}>
                From “{file.name}”, which will be attached to the assignment. Check everything.
                {assignmentId && ' Stages you’ve already started are kept.'}
              </p>
              <label className={d.field}>
                Title
                <input
                  className={d.input}
                  value={draft.title ?? ''}
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </label>
              <div className={d.row}>
                {!assignmentId && (
                  <label className={`${d.field} ${b.grow}`}>
                    Module
                    <select
                      className={d.select}
                      value={draft.moduleId ?? ''}
                      onChange={(e) => patch({ moduleId: e.target.value || null })}
                    >
                      <option value="">Choose…</option>
                      {modules.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.shortLabel} · {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className={d.field}>
                  Type
                  <select
                    className={d.select}
                    value={draft.type}
                    onChange={(e) => patch({ type: e.target.value as AssignmentType })}
                  >
                    {ASSIGNMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={d.row}>
                <div className={d.field}>
                  Due date
                  {draft.dueDate ? (
                    <DateField
                      value={draft.dueDate}
                      onChange={(v) => patch({ dueDate: v })}
                      ariaLabel="Due date"
                    />
                  ) : (
                    <button
                      className={b.missingDate}
                      onClick={() =>
                        patch({
                          dueDate: Temporal.Now.plainDateISO(TZ).add({ weeks: 2 }).toString()
                        })
                      }
                    >
                      Not in the brief: set it
                    </button>
                  )}
                </div>
                <label className={d.field}>
                  Time
                  <TimeField
                    value={draft.dueTime ?? '12:00'}
                    onChange={(v) => patch({ dueTime: v })}
                    ariaLabel="Due time"
                  />
                </label>
                <label className={d.field}>
                  Weighting (%)
                  <input
                    className={`${d.input} ${b.narrow}`}
                    inputMode="numeric"
                    value={draft.weighting ?? ''}
                    onChange={(e) => patch({ weighting: toNumber(e.target.value, 100) })}
                  />
                </label>
                <label className={d.field}>
                  Word limit
                  <input
                    className={`${d.input} ${b.narrow}`}
                    inputMode="numeric"
                    value={draft.wordLimit ?? ''}
                    onChange={(e) => patch({ wordLimit: toNumber(e.target.value, 100_000) })}
                  />
                </label>
              </div>
              <label className={d.field}>
                What it is
                <textarea
                  className={`${d.input} ${d.textarea}`}
                  rows={3}
                  value={draft.summary ?? ''}
                  placeholder="A few sentences on what the brief asks for"
                  onChange={(e) => patch({ summary: e.target.value || null })}
                />
              </label>
              <div className={b.heading}>
                Stages <span className={d.muted}>· {formatMinutes(total)} in all</span>
              </div>
              {draft.stages.map((s, i) => (
                <div key={i} className={b.stage}>
                  <input
                    className={`${d.input} ${b.grow}`}
                    value={s.name}
                    aria-label={`Stage ${i + 1}`}
                    onChange={(e) =>
                      patch({
                        stages: draft.stages.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x
                        )
                      })
                    }
                  />
                  <input
                    className={`${d.input} ${b.hours}`}
                    type="number"
                    min={0.25}
                    step={0.25}
                    value={s.minutes / 60}
                    aria-label={`Hours for stage ${i + 1}`}
                    onChange={(e) =>
                      patch({
                        stages: draft.stages.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                minutes: Math.max(15, Math.round(Number(e.target.value) * 4) * 15)
                              }
                            : x
                        )
                      })
                    }
                  />
                  <span className={d.muted}>h</span>
                  <button
                    className={b.iconButton}
                    aria-label={`Remove stage ${i + 1}`}
                    onClick={() => patch({ stages: draft.stages.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                className={b.addStage}
                onClick={() => patch({ stages: [...draft.stages, { name: '', minutes: 60 }] })}
              >
                <Plus size={13} /> Add a stage
              </button>
            </div>
          ) : null}
          {error && <p className={d.error}>{error}</p>}
        </div>
        <div className={d.actions}>
          {draft && !assignmentId && (
            <button
              className={d.secondary}
              disabled={!!working}
              onClick={() => {
                setDraft(null)
                setFile(null)
              }}
            >
              Use another brief
            </button>
          )}
          <span className={d.spacer} />
          {missing.length > 0 && (
            <span className={b.missing}>Still needed: {missing.join(', ')}</span>
          )}
          <button className={d.secondary} disabled={!!working} onClick={onClose}>
            Cancel
          </button>
          {draft && !assignmentId && (
            <button
              className={d.secondary}
              disabled={!!working || missing.length > 0}
              title="Create it without putting anything on the calendar yet"
              onClick={() => void save(false)}
            >
              Create, plan later
            </button>
          )}
          {draft && (
            <button
              className={d.primary}
              disabled={!!working || missing.length > 0}
              onClick={() => void save()}
            >
              {assignmentId ? 'Save the new plan' : 'Create and plan'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const toNumber = (v: string, max: number) => {
  const n = Number(v.replace(/[^\d]/g, ''))
  return v.trim() === '' || !n ? null : Math.min(max, n)
}

/** Opens the dialog when Claude asks for it (plan_assignment_from_brief in a chat). */
export function BriefPlanHost() {
  const [request, setRequest] = useState<{
    attachmentId: string
    assignmentId: string | null
  } | null>(null)
  useEffect(() => {
    const onRequest = (e: Event) =>
      setRequest((e as CustomEvent<{ attachmentId: string; assignmentId: string | null }>).detail)
    window.addEventListener(PLAN_BRIEF_EVENT, onRequest)
    return () => window.removeEventListener(PLAN_BRIEF_EVENT, onRequest)
  }, [])
  if (!request) return null
  return (
    <BriefPlanDialog
      key={request.attachmentId}
      attachmentId={request.attachmentId}
      assignmentId={request.assignmentId}
      onClose={() => setRequest(null)}
    />
  )
}
