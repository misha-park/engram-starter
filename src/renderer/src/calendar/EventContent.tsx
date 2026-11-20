import type { CSSProperties } from 'react'
import type { EventDisplayInfo } from '@fullcalendar/react'
import {
  CalendarDays,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Flag,
  GraduationCap,
  MessageSquareText,
  Repeat
} from 'lucide-react'
import type { Block, Deadline } from '@shared/types'
import { BLOCK_TYPE_ICON } from '../lib/blockTypes'
import s from './Calendar.module.css'

export type EventProps =
  | {
      kind: 'block'
      block: Block
      colour?: string
      label?: string
      review?: boolean
      /** Just moved here (e.g. to next week): highlighted for a moment. */
      focus?: boolean
      /** Selected with Shift-click (moves with the others). */
      selected?: boolean
    }
  | { kind: 'deadline'; deadline: Deadline; colour?: string }
  /** Where a block was before a change that's waiting for review. */
  | { kind: 'ghost'; title: string; colour?: string }
  /** A term starting or ending (all-day row). */
  | { kind: 'term'; title: string }
  /** An event of a linked calendar (iCloud…): only shown, never planned around. */
  | {
      kind: 'linked'
      /** The linked event's id (for its right-click menu). */
      id: string
      title: string
      calendar: string
      colour?: string
      allDay: boolean
      /** UTC ISO instants, or dates for an all-day event. */
      start: string
      end: string
    }

/** Renders a block (or a deadline in the all-day strip) inside FullCalendar's event element. */
export function EventContent(info: EventDisplayInfo) {
  const raw = info.event.extendedProps as Partial<EventProps>
  // An item being dragged in from outside (e.g. the Backlog) has no block behind it yet.
  if (raw.kind === 'ghost') {
    return (
      <div
        className={`cat ${s.event} ${s.ghost}`}
        style={{ '--cat': raw.colour } as CSSProperties}
        title={`Was here: ${raw.title}`}
      >
        <span className={s.evTitle}>{raw.title}</span>
        <div className={`${s.evTime} num`}>was {info.timeText}</div>
      </div>
    )
  }
  if (raw.kind === 'term') {
    return (
      <div className={s.term} title={raw.title}>
        <GraduationCap size={11} strokeWidth={2} />
        <span className={s.evTitle}>{raw.title}</span>
      </div>
    )
  }
  if (raw.kind === 'linked') {
    const month = info.view.type === 'dayGridMonth'
    const compact = raw.allDay || info.isShort || month
    return (
      <div
        className={`cat ${s.event} ${s.linked}`}
        style={{ '--cat': raw.colour } as CSSProperties}
        data-short={compact || undefined}
        data-month={month || raw.allDay || undefined}
        data-linked-id={raw.id}
        title={`${raw.title}\n${raw.calendar}\nDouble-click to add it to Engram; right-click to delete it from here`}
      >
        <div className={s.evRow}>
          <CalendarDays size={12} strokeWidth={2} className={s.evIcon} />
          <span className={s.evTitle}>{raw.title}</span>
          {compact && !raw.allDay && !month && (
            <span className={`${s.evDetailInline} num`}>{info.timeText}</span>
          )}
        </div>
        {!compact && <div className={`${s.evTime} num`}>{info.timeText}</div>}
      </div>
    )
  }
  if (raw.kind !== 'block' && raw.kind !== 'deadline') {
    return (
      <div className={`cat ${s.event} ${s.preview}`}>
        <span className={s.evTitle}>{info.event.title}</span>
        <div className={`${s.evTime} num`}>{info.timeText}</div>
      </div>
    )
  }
  const props = raw as Exclude<
    EventProps,
    { kind: 'ghost' } | { kind: 'term' } | { kind: 'linked' }
  >
  const style = { '--cat': props.colour } as CSSProperties

  if (props.kind === 'deadline') {
    return (
      <div className={`cat ${s.deadline}`} style={style} title={props.deadline.title}>
        {props.deadline.kind === 'todo' ? (
          <Circle size={11} strokeWidth={2} aria-label="Todo" />
        ) : (
          <Flag size={11} strokeWidth={2} />
        )}
        <span className={s.evTitle}>{props.deadline.title}</span>
      </div>
    )
  }

  const { block } = props
  const Icon = BLOCK_TYPE_ICON[block.type]
  // A todo given time on the calendar: its dot ticks the todo, like in the list.
  const isTodo = block.linkedType === 'todo'
  const todoDone = block.outcome === 'done'
  const month = info.view.type === 'dayGridMonth'
  // Top line: the module (or the block's own name); below it, lighter, the lecture or stage.
  // A short block or the month view has room for one line, so both go on it.
  const heading = block.heading ?? block.title
  const inline = !!block.detail && (info.isShort || month)
  return (
    <div
      className={`cat ${s.event}`}
      style={style}
      data-kind={block.kind}
      data-outcome={block.outcome}
      data-short={info.isShort || month || undefined}
      data-month={month || undefined}
      data-attention={block.attention ? true : undefined}
      data-review={props.review || undefined}
      data-focus={props.focus || undefined}
      data-selected={props.selected || undefined}
      data-block-id={block.id}
      tabIndex={0}
      role="button"
      aria-label={[
        heading,
        block.detail,
        info.timeText,
        block.outcome !== 'none' ? block.outcome : null
      ]
        .filter(Boolean)
        .join(', ')}
      title={[block.heading ?? block.title, block.detail, block.attention]
        .filter(Boolean)
        .join('\n')}
    >
      <div className={s.evRow}>
        {isTodo ? (
          <span
            className={s.todoCheck}
            data-todo-check
            role="checkbox"
            aria-checked={todoDone}
            aria-label={todoDone ? `Untick ${block.title}` : `Tick off ${block.title}`}
            title={todoDone ? 'Untick' : 'Tick off'}
          >
            {todoDone ? (
              <CircleCheck size={13} strokeWidth={2} />
            ) : (
              <Circle size={13} strokeWidth={2} />
            )}
          </span>
        ) : (
          <Icon size={12} strokeWidth={2} className={s.evIcon} />
        )}
        <span className={s.evTitle}>
          {month && block.detail ? (
            // A month cell fits a few words: lead with what this block is.
            <>
              {block.detail}
              <span className={s.evDetailInline}> · {heading}</span>
            </>
          ) : (
            <>
              {heading}
              {inline && <span className={s.evDetailInline}> · {block.detail}</span>}
            </>
          )}
        </span>
        {block.recurrenceId && <Repeat size={10} className={s.evMeta} aria-label="Recurring" />}
        {block.debriefPending && (
          <MessageSquareText size={11} className={s.evMeta} aria-label="Debrief pending" />
        )}
        {!isTodo && <OutcomeIcon outcome={block.outcome} />}
      </div>
      {block.detail && !inline && <div className={s.evDetail}>{block.detail}</div>}
      {!month && <div className={`${s.evTime} num`}>{info.timeText}</div>}
    </div>
  )
}

function OutcomeIcon({ outcome }: { outcome: Block['outcome'] }) {
  if (outcome === 'done') return <CircleCheck size={11} className={s.evMeta} aria-label="Done" />
  if (outcome === 'partial')
    return <CircleDashed size={11} className={s.evMeta} aria-label="Partial" />
  if (outcome === 'skipped')
    return <CircleSlash size={11} className={s.evMeta} aria-label="Skipped" />
  return null
}
