import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import { useCalendarController } from '@fullcalendar/react'
import { Draggable } from '@fullcalendar/react/interaction'
import {
  CalendarDays,
  CalendarPlus,
  CircleCheck,
  ExternalLink,
  GripVertical,
  Inbox,
  Sparkles,
  Wind
} from 'lucide-react'
import type { BacklogItem, BacklogKind, Block } from '@shared/types'
import { formatMinutes, toIso, weekRange, zoned } from '@core/time'
import { call } from '../lib/api'
import {
  errorMessage,
  useBacklog,
  useBlocks,
  useCategories,
  useDeadlines,
  useDismissBacklogItem,
  useAssistantPending,
  useScheduleBacklogItem,
  useSetTodoDone,
  useSubmitAssignment
} from '../lib/queries'
import { useNow } from '../lib/useNow'
import { useAssistant, useAssistantScreen } from '../assistant/store'
import { ReviewBar } from '../assistant/ReviewBar'
import { BlockDialog } from '../calendar/BlockDialog'
import { CalendarToolbar } from '../calendar/CalendarToolbar'
import { PlannerCalendar } from '../calendar/PlannerCalendar'
import { useBlockMenu } from '../calendar/useBlockMenu'
import { openContextMenu } from '../ui/menuStore'
import { OutcomeDialog } from '../timer/OutcomeDialog'
import s from './Backlog.module.css'

const NO_HIDDEN = new Set<string>()

const GROUPS: { kind: BacklogKind; title: string; hint: string }[] = [
  {
    kind: 'unmarked',
    title: 'Not marked',
    hint: 'Past blocks with no outcome. Mark them, or move them to a new time.'
  },
  {
    kind: 'partial',
    title: 'Partly done',
    hint: 'Schedule a follow-up for what’s left, or let it go.'
  },
  { kind: 'skipped', title: 'Skipped', hint: 'Find a new time, or let it go.' },
  {
    kind: 'unscheduled-write-up',
    title: 'Write-ups with no slot',
    hint: 'No free time was found within 3 working days of the lecture.'
  },
  { kind: 'overdue-assignment', title: 'Assignments past due', hint: 'Not marked submitted.' },
  {
    kind: 'overdue-todo',
    title: 'Overdue todos',
    hint: 'Tick them, or give them time on the calendar.'
  }
]

/**
 * Everything that slipped, across the app. Drag an item onto the calendar to schedule it there,
 * or ask Claude to fit them into free time.
 */
export function BacklogPage() {
  const now = useNow()
  const { data: items = [] } = useBacklog()
  const schedule = useScheduleBacklogItem()
  const listRef = useRef<HTMLDivElement>(null)
  const assistant = useAssistant()
  const { data: pending } = useAssistantPending()
  const [marking, setMarking] = useState<Block | null>(null)

  // Calendar to drop onto.
  const controller = useCalendarController()
  const [range, setRange] = useState(() => {
    const w = weekRange(now)
    return { start: toIso(w.start), end: toIso(w.end) }
  })
  const [openBlock, setOpenBlock] = useState<{ block: Block; edit?: boolean } | null>(null)
  const { onBlockMenu, onBlockDelete, focusId, setFocus } = useBlockMenu(
    controller,
    (block, mode) => setOpenBlock({ block, edit: mode === 'edit' })
  )
  const { data: blocks = [] } = useBlocks(range.start, range.end)
  const { data: deadlines = [] } = useDeadlines(range.start, range.end)
  const { data: categories = [] } = useCategories()
  const onRangeChange = useCallback(
    (r: { start: string; end: string }) =>
      setRange((p) => (p.start === r.start && p.end === r.end ? p : r)),
    []
  )
  useAssistantScreen({ visibleRange: range })

  // Make schedulable items draggable onto the calendar.
  useEffect(() => {
    if (!listRef.current) return
    const draggable = new Draggable(listRef.current, {
      itemSelector: '[data-backlog-key]',
      eventData: (el) => ({
        title: el.dataset.title,
        duration: { minutes: Number(el.dataset.minutes) || 60 },
        create: false
      })
    })
    return () => draggable.destroy()
  }, [])

  const onDrop = useCallback(
    (el: HTMLElement, start: string) => {
      const key = el.dataset.backlogKey
      if (key) schedule.mutate({ key, start })
    },
    [schedule]
  )

  const openForMarking = async (blockId: string) => {
    const block = await call('blocks:get', blockId)
    if (block) setMarking(block)
  }

  return (
    <div className={s.layout}>
      <section className={s.listPane}>
        <header className={s.header}>
          <h1>Backlog</h1>
          <span className={s.count}>{items.length}</span>
          <span className={s.spacer} />
          {items.some((i) => i.minutes) && (
            <button
              className={`${s.action} ${s.withIcon}`}
              disabled={assistant.state.busyId !== null}
              onClick={() =>
                assistant.ask(
                  'Fit the Backlog items that can be scheduled into free time, soonest first, within their limits. Leave anything that doesn’t fit and tell me why.'
                )
              }
            >
              <Sparkles size={13} /> Ask Claude to schedule
            </button>
          )}
        </header>
        <p className={s.intro}>Drag an item onto the calendar to give it a time.</p>
        {schedule.error && <p className={s.error}>{errorMessage(schedule.error)}</p>}
        <div ref={listRef} className={s.groups}>
          {items.length === 0 && (
            <div className={s.empty}>
              <Inbox size={26} strokeWidth={1.25} />
              <p>Nothing has slipped.</p>
            </div>
          )}
          {GROUPS.map((g) => {
            const group = items.filter((i) => i.kind === g.kind)
            if (!group.length) return null
            return (
              <div key={g.kind} className={s.group}>
                <div className={s.groupTitle}>
                  {g.title} <span className={s.count}>{group.length}</span>
                </div>
                <div className={s.groupHint}>{g.hint}</div>
                {group.map((item) => (
                  <ItemCard key={item.key} item={item} onMark={openForMarking} />
                ))}
              </div>
            )
          })}
        </div>
      </section>
      <section className={s.calendarPane}>
        {pending && <ReviewBar batch={pending} />}
        <CalendarToolbar controller={controller} />
        <PlannerCalendar
          controller={controller}
          blocks={blocks}
          deadlines={deadlines}
          categories={categories}
          hiddenCategories={NO_HIDDEN}
          onRangeChange={onRangeChange}
          onOpenBlock={(block) => setOpenBlock({ block })}
          onExternalDrop={onDrop}
          review={pending}
          onBlockMenu={onBlockMenu}
          onBlockDelete={onBlockDelete}
          focusId={focusId}
        />
      </section>
      {marking && (
        <OutcomeDialog
          mode={{ kind: 'block', block: marking }}
          categoryName={categories.find((c) => c.id === marking.categoryId)?.name}
          onClose={() => setMarking(null)}
        />
      )}
      {openBlock && (
        <BlockDialog
          block={openBlock.block}
          startEditing={openBlock.edit}
          category={categories.find((c) => c.id === openBlock.block.categoryId)}
          onClose={() => setOpenBlock(null)}
          onShowBlock={(b) => {
            controller.gotoDate(zoned(b.start).toPlainDate().toString())
            setFocus(b.id)
          }}
        />
      )}
    </div>
  )
}

function ItemCard({ item, onMark }: { item: BacklogItem; onMark: (blockId: string) => void }) {
  const navigate = useNavigate()
  const schedule = useScheduleBacklogItem()
  const dismiss = useDismissBacklogItem()
  const done = useSetTodoDone()
  const submit = useSubmitAssignment()
  const schedulable = item.minutes !== null
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { heading: item.title },
      schedulable && {
        label: 'Next free slot',
        icon: CalendarPlus,
        onSelect: () => schedule.mutateAsync({ key: item.key })
      },
      item.blockId && {
        label: 'Show where it was planned',
        icon: CalendarDays,
        onSelect: () => navigate(`/?block=${item.blockId}`)
      },
      item.kind === 'unmarked' &&
        item.blockId && {
          label: 'Mark…',
          icon: CircleCheck,
          onSelect: () => onMark(item.blockId!)
        },
      (item.kind === 'partial' || item.kind === 'skipped') && {
        label: 'Let go',
        icon: Wind,
        onSelect: () => dismiss.mutateAsync(item.key)
      },
      item.assignmentId && {
        label: 'Open assignment',
        icon: ExternalLink,
        onSelect: () => navigate(`/assignments/${item.assignmentId}`)
      },
      item.kind === 'overdue-assignment' &&
        item.assignmentId && {
          label: 'Mark submitted',
          icon: CircleCheck,
          onSelect: () => submit.mutateAsync({ id: item.assignmentId!, submitted: true })
        },
      item.kind === 'overdue-todo' &&
        item.todoId && {
          label: 'Done',
          icon: CircleCheck,
          onSelect: () => done.mutateAsync({ id: item.todoId!, done: true })
        }
    ])
  return (
    <div
      onContextMenu={menu}
      className={`cat ${s.item}`}
      style={{ '--cat': item.colour ?? undefined } as CSSProperties}
      data-backlog-key={schedulable ? item.key : undefined}
      data-title={item.title}
      data-minutes={item.minutes ?? undefined}
      title={schedulable ? 'Drag onto the calendar to schedule' : undefined}
    >
      {schedulable && <GripVertical size={14} className={s.grip} />}
      <div className={s.itemBody}>
        <div className={s.itemTitle}>{item.title}</div>
        <div className={s.itemDetail}>
          {item.detail}
          {item.minutes ? ` · ${formatMinutes(item.minutes)}` : ''}
        </div>
        <div className={s.actions}>
          {schedulable && (
            <button
              className={s.action}
              onClick={() => schedule.mutate({ key: item.key })}
              disabled={schedule.isPending}
            >
              Next free slot
            </button>
          )}
          {item.kind === 'unmarked' && item.blockId && (
            <button className={s.action} onClick={() => onMark(item.blockId!)}>
              Mark…
            </button>
          )}
          {(item.kind === 'partial' || item.kind === 'skipped') && (
            <button className={s.action} onClick={() => dismiss.mutate(item.key)}>
              Let go
            </button>
          )}
          {item.kind === 'overdue-assignment' && item.assignmentId && (
            <>
              <button
                className={s.action}
                onClick={() => navigate(`/assignments/${item.assignmentId}`)}
              >
                Open
              </button>
              <button
                className={s.action}
                onClick={() => submit.mutate({ id: item.assignmentId!, submitted: true })}
              >
                Mark submitted
              </button>
            </>
          )}
          {item.kind === 'overdue-todo' && item.todoId && (
            <button
              className={`${s.action} ${s.withIcon}`}
              onClick={() => done.mutate({ id: item.todoId!, done: true })}
            >
              <CircleCheck size={12} /> Done
            </button>
          )}
        </div>
        {(schedule.error || dismiss.error) && (
          <p className={s.error}>{errorMessage(schedule.error ?? dismiss.error)}</p>
        )}
      </div>
    </div>
  )
}
