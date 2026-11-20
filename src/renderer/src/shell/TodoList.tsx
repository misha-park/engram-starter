import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Circle,
  CircleCheck,
  Pencil,
  Plus,
  Repeat,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { Todo } from '@shared/types'
import {
  errorMessage,
  useArchiveTodo,
  useCreateTodo,
  useModules,
  useScheduleTodo,
  useSetTodoDone,
  useTodos,
  useUpdateTodo
} from '../lib/queries'
import { call } from '../lib/api'
import { parseQuickTodo } from '@core/todos'
import { useSynced } from '../lib/useSynced'
import { DateField } from '../ui/DateField'
import { openContextMenu } from '../ui/menuStore'
import { askText } from '../ui/promptStore'
import { toast } from '../ui/toastStore'
import s from './Sidebar.module.css'

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** A ticked todo stays put this long before it's saved and moves, so a mis-tick is easy to undo. */
const TICK_DELAY_MS = 2500

/**
 * Small todos (no time slot). Click a todo to edit it: due date, repeat, module, or give it
 * time on the calendar (anything with an estimate becomes a block).
 */
export function TodoList({ today }: { today: Temporal.PlainDate }) {
  const { data: todos = [] } = useTodos()
  const create = useCreateTodo()
  const setDone = useSetTodoDone()
  const archive = useArchiveTodo()
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const open = todos.filter((t) => !t.done)
  const done = todos.filter((t) => t.done)

  // Ticks waiting out the delay: shown as ticked, but not saved or moved yet.
  const qc = useQueryClient()
  const [pending, setPending] = useState<Set<string>>(new Set())
  const timers = useRef(new Map<string, number>())
  const drop = (id: string) =>
    setPending((p) => {
      const next = new Set(p)
      next.delete(id)
      return next
    })
  const toggle = (t: Todo) => {
    if (t.done) {
      setDone.mutate({ id: t.id, done: false })
      return
    }
    const timer = timers.current.get(t.id)
    if (timer) {
      // Unticked within the delay: nothing was saved.
      clearTimeout(timer)
      timers.current.delete(t.id)
      drop(t.id)
      return
    }
    setPending((p) => new Set(p).add(t.id))
    timers.current.set(
      t.id,
      window.setTimeout(() => {
        timers.current.delete(t.id)
        setDone.mutate({ id: t.id, done: true }, { onSettled: () => drop(t.id) })
      }, TICK_DELAY_MS)
    )
  }
  // Leaving the page doesn't lose a tick: save anything still waiting.
  useEffect(() => {
    const waiting = timers.current
    return () => {
      for (const [id, timer] of waiting) {
        clearTimeout(timer)
        void call('todos:setDone', id, true).then(() => qc.invalidateQueries())
      }
      waiting.clear()
    }
  }, [qc])

  const archiveWithUndo = (t: Todo) =>
    archive.mutate(t.id, {
      onSuccess: () =>
        toast(`Archived “${t.title}”.`, {
          action: {
            label: 'Undo',
            run: async () => {
              await call('todos:unarchive', t.id)
              await qc.invalidateQueries()
            }
          }
        })
    })

  // Keyboard: the list is one Tab stop; arrows move between todos, X ticks, Delete archives.
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const onListKey = (e: React.KeyboardEvent, t: Todo, i: number, count: number) => {
    const focusRow = (n: number) => {
      setCursor(n)
      requestAnimationFrame(() =>
        listRef.current?.querySelectorAll<HTMLButtonElement>('[data-todo-title]')[n]?.focus()
      )
    }
    if (e.key === 'ArrowDown' && i < count - 1) {
      e.preventDefault()
      focusRow(i + 1)
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault()
      focusRow(i - 1)
    } else if (e.key.toLowerCase() === 'x') {
      e.preventDefault()
      toggle(t)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      archiveWithUndo(t)
    }
  }

  // Right-click: the common edits without opening the editor.
  const menu = (e: React.MouseEvent, t: Todo) => {
    const due = (days: number) => today.add({ days }).toString()
    const setDue = (dueDate: string | null) =>
      call('todos:update', t.id, { dueDate }).then(() => qc.invalidateQueries())
    openContextMenu(e, [
      { heading: t.title },
      {
        label: t.done || pending.has(t.id) ? 'Untick' : 'Tick off',
        icon: CircleCheck,
        onSelect: () => toggle(t)
      },
      {
        label: 'Rename…',
        icon: Pencil,
        onSelect: async () => {
          const title = await askText({ title: 'Rename todo', initial: t.title })
          if (title) await call('todos:update', t.id, { title })
          await qc.invalidateQueries()
        }
      },
      { label: 'Edit…', icon: SlidersHorizontal, onSelect: () => setEditing(t.id) },
      'separator',
      { label: 'Due today', icon: CalendarClock, onSelect: () => setDue(due(0)) },
      { label: 'Due tomorrow', icon: CalendarClock, onSelect: () => setDue(due(1)) },
      {
        label: 'Due next week',
        icon: CalendarClock,
        hint: today.add({ days: 8 - today.dayOfWeek }).toLocaleString('en-GB', {
          weekday: 'short',
          day: 'numeric'
        }),
        onSelect: () => setDue(due(8 - today.dayOfWeek))
      },
      t.dueDate && { label: 'No due date', icon: CalendarX, onSelect: () => setDue(null) },
      'separator',
      !t.done && {
        label: 'Give it 30 min on the calendar',
        icon: CalendarPlus,
        onSelect: async () => {
          await call('todos:schedule', t.id, { minutes: 30 })
          await qc.invalidateQueries()
          toast('Added to the calendar at the next free slot.')
        }
      },
      'separator',
      {
        label: 'Archive',
        icon: Archive,
        hint: 'also from Tot',
        onSelect: () => archiveWithUndo(t)
      }
    ])
  }

  // "Return books tomorrow" → due tomorrow (shown under the box as you type).
  const quick = parseQuickTodo(adding, today)
  const add = () => {
    if (!quick.title.trim()) return
    create.mutate(
      { title: quick.title, dueDate: quick.dueDate },
      { onSuccess: () => setAdding('') }
    )
  }

  return (
    <section className={`${s.section} ${s.todos}`}>
      <div className={s.sectionHeaderStatic}>
        Todos <span className={`${s.count} num`}>{open.length - pending.size}</span>
      </div>
      <ul className={s.list} ref={listRef}>
        {[...open, ...done].map((t, i, all) => {
          const ticked = t.done || pending.has(t.id)
          const overdue = !ticked && t.dueDate !== null && t.dueDate < today.toString()
          return (
            <li key={t.id}>
              <div
                className={s.todo}
                onContextMenu={(e) => menu(e, t)}
                data-done={ticked || undefined}
                data-editing={editing === t.id || undefined}
              >
                <button
                  className={s.todoCheck}
                  tabIndex={-1}
                  aria-label={ticked ? `Untick ${t.title}` : `Tick ${t.title}`}
                  aria-pressed={ticked}
                  onClick={() => toggle(t)}
                >
                  {ticked ? <CircleCheck size={14} /> : <Circle size={14} />}
                </button>
                <button
                  className={s.todoTitle}
                  data-todo-title
                  tabIndex={i === Math.min(cursor, all.length - 1) ? 0 : -1}
                  aria-keyshortcuts="ArrowUp ArrowDown X Delete"
                  title={t.title}
                  onFocus={() => setCursor(i)}
                  onKeyDown={(e) => onListKey(e, t, i, all.length)}
                  onClick={() => setEditing(editing === t.id ? null : t.id)}
                >
                  {t.title}
                </button>
                {t.recurrence && <Repeat size={12} className={s.meta} aria-label="Repeats" />}
                {t.dueDate && !ticked && (
                  <span className={`${s.due} num`} data-overdue={overdue || undefined}>
                    {formatDue(t.dueDate, today)}
                  </span>
                )}
                <button
                  className={s.todoArchive}
                  tabIndex={-1}
                  title="Archive (also removes it from Tot)"
                  aria-label={`Archive ${t.title}`}
                  onClick={() => {
                    const timer = timers.current.get(t.id)
                    if (timer) {
                      clearTimeout(timer)
                      timers.current.delete(t.id)
                      drop(t.id)
                    }
                    if (editing === t.id) setEditing(null)
                    archiveWithUndo(t)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
              {editing === t.id && (
                <TodoEditor key={t.id} todo={t} today={today} onClose={() => setEditing(null)} />
              )}
            </li>
          )
        })}
      </ul>
      <div className={s.addTodo}>
        <Plus size={14} className={s.meta} />
        <input
          value={adding}
          placeholder="Add a todo, e.g. Pay rent fri"
          aria-label="Add a todo"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
      </div>
      {quick.dueDate && (
        <p className={s.quickDue}>
          Due {formatDue(quick.dueDate, today)} · “{quick.title}”
        </p>
      )}
      {(create.error || archive.error) && (
        <p className={s.error}>{errorMessage(create.error ?? archive.error)}</p>
      )}
    </section>
  )
}

function TodoEditor({
  todo,
  today,
  onClose
}: {
  todo: Todo
  today: Temporal.PlainDate
  onClose: () => void
}) {
  const update = useUpdateTodo()
  const archive = useArchiveTodo()
  const schedule = useScheduleTodo()
  const { data: modules = [] } = useModules()
  const [title, setTitle] = useSynced(todo.title)
  const [minutes, setMinutes] = useState('30')
  const save = (patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: todo.id, patch })
  const repeat = todo.recurrence?.freq ?? 'never'
  const weekdays = todo.recurrence?.byWeekday ?? []
  const error = update.error ?? archive.error ?? schedule.error

  return (
    <div className={s.todoEditor}>
      <input
        className={s.editorTitle}
        value={title}
        aria-label="Title"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== todo.title && save({ title })}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      <div className={s.editorRow}>
        <span className={s.editorLabel}>Due</span>
        {todo.dueDate ? (
          <>
            <DateField
              value={todo.dueDate}
              onChange={(v) => save({ dueDate: v })}
              ariaLabel="Due date"
            />
            <button
              className={s.iconMini}
              title="No due date"
              onClick={() => save({ dueDate: null })}
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <button className={s.textMini} onClick={() => save({ dueDate: today.toString() })}>
            Add a date
          </button>
        )}
      </div>
      <div className={s.editorRow}>
        <span className={s.editorLabel}>Repeat</span>
        <select
          className={s.editorSelect}
          value={repeat}
          onChange={(e) => {
            const v = e.target.value
            save({
              recurrence:
                v === 'never'
                  ? null
                  : v === 'daily'
                    ? { freq: 'daily' }
                    : { freq: 'weekly', byWeekday: [today.dayOfWeek] }
            })
          }}
        >
          <option value="never">Never</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      {repeat === 'weekly' && (
        <div className={s.weekdayToggles} role="group" aria-label="Repeat on">
          {DAYS.map((d, i) => (
            <button
              key={i}
              aria-pressed={weekdays.includes(i + 1)}
              onClick={() => {
                const next = weekdays.includes(i + 1)
                  ? weekdays.filter((x) => x !== i + 1)
                  : [...weekdays, i + 1]
                if (next.length) save({ recurrence: { freq: 'weekly', byWeekday: next.sort() } })
              }}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      <div className={s.editorRow}>
        <span className={s.editorLabel}>For</span>
        <select
          className={s.editorSelect}
          value={todo.linkedType === 'module' ? (todo.linkedId ?? '') : ''}
          onChange={(e) =>
            save({ link: e.target.value ? { type: 'module', id: e.target.value } : null })
          }
        >
          <option value="">Nothing in particular</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.shortLabel}
            </option>
          ))}
        </select>
      </div>
      <div className={s.editorRow}>
        <span className={s.editorLabel}>Needs</span>
        <input
          className={s.editorMinutes}
          type="number"
          min={15}
          step={15}
          value={minutes}
          aria-label="Minutes"
          onChange={(e) => setMinutes(e.target.value)}
        />
        <span className={s.meta}>min</span>
      </div>
      <div className={s.editorRow}>
        <button
          className={`${s.textMini} ${s.withIcon}`}
          title="Put it in the next free slot on the calendar"
          disabled={!Number(minutes) || schedule.isPending}
          onClick={() =>
            schedule.mutate({ id: todo.id, minutes: Number(minutes) }, { onSuccess: onClose })
          }
        >
          <CalendarPlus size={12} /> Schedule
        </button>
        <button
          className={s.textMini}
          onClick={() => archive.mutate(todo.id, { onSuccess: onClose })}
        >
          Archive
        </button>
        <span className={s.grow} />
        <button className={s.textMini} onClick={onClose}>
          Close
        </button>
      </div>
      {error && <p className={s.error}>{errorMessage(error)}</p>}
    </div>
  )
}

function formatDue(iso: string, today: Temporal.PlainDate): string {
  const date = Temporal.PlainDate.from(iso)
  const days = today.until(date).days
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short' })
}
