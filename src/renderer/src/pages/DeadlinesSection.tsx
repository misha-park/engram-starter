import { useState, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Check, Pencil, Plus, StickyNote, Trash2, Undo2 } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { GeneralDeadline, ModuleWithDetails } from '@shared/types'
import { atLocalTime, formatClock, toIso, TZ, zoned } from '@core/time'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import { DateField } from '../ui/DateField'
import { TimeField } from '../ui/TimeField'
import { openContextMenu } from '../ui/menuStore'
import { toast } from '../ui/toastStore'
import { formatDue } from './assignmentFormat'
import { dueIn, type DueIn } from '@core/due'
import x from './DeadlinesSection.module.css'

// The Assignments page's Deadlines: anything else with a due date (a form, an application,
// a fee). A name and a time, optionally a module; nothing is planned for them.

interface Draft {
  title: string
  date: string
  time: string
  moduleId: string
  notes: string
}

const emptyDraft = (): Draft => ({
  title: '',
  date: Temporal.Now.plainDateISO(TZ).add({ days: 7 }).toString(),
  time: '17:00',
  moduleId: '',
  notes: ''
})

/** Scroll a deadline's row into view and flash it (from the timeline or the sidebar). */
export function showDeadline(id: string): boolean {
  const row = document.getElementById(`deadline-${id}`)
  if (!row) return false
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.dataset.flash = ''
  window.setTimeout(() => delete row.dataset.flash, 1600)
  return true
}

const toDue = (d: Draft) => toIso(atLocalTime(Temporal.PlainDate.from(d.date), d.time))

export function DeadlinesSection({
  deadlines,
  modules,
  now
}: {
  deadlines: GeneralDeadline[]
  modules: ModuleWithDetails[]
  now: Temporal.Instant
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await qc.invalidateQueries()
      setError(null)
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    }
  }

  const add = async () => {
    if (!draft.title.trim()) return
    const ok = await run(() =>
      call('deadlines:create', {
        title: draft.title,
        due: toDue(draft),
        moduleId: draft.moduleId || null
      })
    )
    if (ok) setDraft({ ...emptyDraft(), date: draft.date, time: draft.time })
  }

  const open = deadlines.filter((d) => !d.doneAt)
  const done = deadlines.filter((d) => d.doneAt).sort((p, q) => q.due.localeCompare(p.due))

  const menu = (e: React.MouseEvent, d: GeneralDeadline) =>
    openContextMenu(e, [
      { heading: d.title },
      { label: 'Edit…', icon: Pencil, onSelect: () => setEditing(d.id) },
      d.doneAt
        ? {
            label: 'Not done after all',
            icon: Undo2,
            onSelect: () => run(() => call('deadlines:setDone', d.id, false))
          }
        : {
            label: 'Mark done',
            icon: Check,
            onSelect: () => run(() => call('deadlines:setDone', d.id, true))
          },
      'separator',
      {
        label: 'Delete…',
        icon: Trash2,
        danger: true,
        confirm: `Delete “${d.title}”?`,
        onSelect: async () => {
          await call('deadlines:delete', d.id)
          await qc.invalidateQueries()
          toast('Deleted.', {
            action: {
              label: 'Undo',
              run: async () => {
                await call('deadlines:restore', d)
                await qc.invalidateQueries()
              }
            }
          })
        }
      }
    ])

  return (
    <section className={x.section} aria-label="Deadlines">
      <h2 className={x.title}>
        <CalendarClock size={15} /> Deadlines{' '}
        <span className={`${x.count} num`}>{open.length}</span>
      </h2>
      <p className={x.hint}>
        Anything else with a due date: a form, an application, a fee. They show on the calendar and
        in the sidebar’s countdown.
      </p>

      <div className={x.list}>
        <form
          className={x.addRow}
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <Plus size={14} className={x.addIcon} />
          <input
            className={x.titleInput}
            value={draft.title}
            placeholder="Add a deadline, e.g. Summer school application"
            aria-label="New deadline"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <Fields draft={draft} setDraft={setDraft} modules={modules} />
          <button className={x.addButton} type="submit" disabled={!draft.title.trim()}>
            Add
          </button>
        </form>
        {error && <p className={x.error}>{error}</p>}

        {[...open, ...done].map((d) =>
          editing === d.id ? (
            <EditRow
              key={d.id}
              d={d}
              modules={modules}
              onCancel={() => setEditing(null)}
              onSave={async (next) => {
                const ok = await run(() =>
                  call('deadlines:update', d.id, {
                    title: next.title,
                    due: toDue(next),
                    moduleId: next.moduleId || null,
                    notes: next.notes || null
                  })
                )
                if (ok) setEditing(null)
              }}
            />
          ) : (
            <Row
              key={d.id}
              d={d}
              due={dueIn(d.due, now)}
              onToggle={() => run(() => call('deadlines:setDone', d.id, !d.doneAt))}
              onEdit={() => setEditing(d.id)}
              onMenu={(e) => menu(e, d)}
            />
          )
        )}
      </div>
    </section>
  )
}

function Row({
  d,
  due,
  onToggle,
  onEdit,
  onMenu
}: {
  d: GeneralDeadline
  due: DueIn
  onToggle: () => void
  onEdit: () => void
  onMenu: (e: React.MouseEvent) => void
}) {
  const done = !!d.doneAt
  return (
    <div
      id={`deadline-${d.id}`}
      className={`cat ${x.row}`}
      data-done={done || undefined}
      style={{ '--cat': d.colour ?? 'var(--text-3)' } as CSSProperties}
      onContextMenu={onMenu}
    >
      <input
        type="checkbox"
        className={x.check}
        checked={done}
        aria-label={done ? `${d.title}: done` : `Mark ${d.title} done`}
        onChange={onToggle}
      />
      <button className={x.name} title="Edit" onClick={onEdit}>
        <span className={x.rowTitle}>{d.title}</span>
        {d.moduleName && (
          <span className={x.module}>
            <span className={x.dot} />
            {d.moduleName}
          </span>
        )}
        {d.notes && (
          <span className={x.notes} title={d.notes}>
            <StickyNote size={11} />
            <span className={x.notesText}>{d.notes.split('\n')[0]}</span>
          </span>
        )}
      </button>
      <span className={`${x.due} num`}>{formatDue(d.due)}</span>
      <span className={`${x.days} num`} data-urgency={done ? 'done' : due.urgency}>
        {done ? 'Done' : due.label}
      </span>
    </div>
  )
}

function EditRow({
  d,
  modules,
  onCancel,
  onSave
}: {
  d: GeneralDeadline
  modules: ModuleWithDetails[]
  onCancel: () => void
  onSave: (draft: Draft) => void
}) {
  const [draft, setDraft] = useState<Draft>({
    title: d.title,
    date: zoned(d.due).toPlainDate().toString(),
    time: formatClock(d.due),
    moduleId: d.moduleId ?? '',
    notes: d.notes ?? ''
  })
  return (
    <form
      className={`${x.row} ${x.editing}`}
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft)
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <input
        className={x.titleInput}
        value={draft.title}
        autoFocus
        aria-label="Deadline name"
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      <Fields draft={draft} setDraft={setDraft} modules={modules} />
      <button type="button" className={x.cancel} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className={x.addButton} disabled={!draft.title.trim()}>
        Save
      </button>
      <textarea
        className={x.notesInput}
        value={draft.notes}
        rows={2}
        placeholder="Notes: a link, a reference number, what it needs…"
        aria-label="Notes"
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        onKeyDown={(e) => {
          // ⌘↩ saves from the notes; a plain Return is a new line.
          if (e.key === 'Enter' && e.metaKey) {
            e.preventDefault()
            onSave(draft)
          }
        }}
      />
    </form>
  )
}

/** Date, time and module: shared by the add row and editing. */
function Fields({
  draft,
  setDraft,
  modules
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  modules: ModuleWithDetails[]
}) {
  return (
    <>
      <DateField
        value={draft.date}
        ariaLabel="Due date"
        onChange={(date) => setDraft({ ...draft, date })}
      />
      <TimeField
        value={draft.time}
        ariaLabel="Due time"
        onChange={(time) => setDraft({ ...draft, time })}
      />
      <select
        className={x.select}
        value={draft.moduleId}
        aria-label="Module (optional)"
        onChange={(e) => setDraft({ ...draft, moduleId: e.target.value })}
      >
        <option value="">No module</option>
        {modules.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </>
  )
}
