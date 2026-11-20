import type { QueryClient } from '@tanstack/react-query'
import {
  ArrowUpToLine,
  CalendarArrowUp,
  Layers,
  CalendarClock,
  CalendarX,
  CircleCheck,
  Copy,
  CircleSlash,
  EyeOff,
  FileText,
  Pencil,
  Play,
  SquareArrowOutUpRight,
  Trash2
} from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { Block, RunningTimer } from '@shared/types'
import { isUserMovable } from '@core/blocks'
import { toIso, zoned } from '@core/time'
import { call } from '../lib/api'
import type { MenuEntry } from '../ui/menuStore'
import { askText } from '../ui/promptStore'
import { toast } from '../ui/toastStore'
import { canDelete, deleteBlock, deleteQuestion, hideTimetabled } from './deleteBlock'

/** Same wall-clock time, `days` later (right across clock changes). */
export function shiftDays(block: Pick<Block, 'start' | 'end'>, days: number) {
  return {
    start: toIso(zoned(block.start).add({ days })),
    end: toIso(zoned(block.end).add({ days }))
  }
}

interface Ctx {
  qc: QueryClient
  navigate: (to: string) => void
  timer: RunningTimer | null | undefined
  open: (block: Block, mode?: 'view' | 'edit') => void
  /** Offer Duplicate… (a new event filled in from this one). */
  duplicate?: (block: Block) => void
  /** Show a date and highlight a block there (after moving it). */
  reveal: (blockId: string, date: string) => void
}

/** The right-click menu for a block on the calendar. */
export function blockMenu(block: Block, ctx: Ctx): MenuEntry[] {
  const refresh = () => ctx.qc.invalidateQueries()
  const started =
    Temporal.Instant.compare(Temporal.Instant.from(block.start), Temporal.Now.instant()) <= 0
  const movable = isUserMovable(block)
  const work = block.kind === 'flexible'
  const ownEvent = !block.recurrenceId && (block.source === 'user' || block.source === 'claude')

  const undoMove = (before: { start: string; end: string }) => ({
    label: 'Undo',
    run: async () => {
      await call('blocks:move', block.id, before.start, before.end)
      await refresh()
      ctx.reveal(block.id, zoned(before.start).toPlainDate().toString())
    }
  })

  const moveToTomorrow = async () => {
    const before = { start: block.start, end: block.end }
    const next = shiftDays(block, 1)
    await call('blocks:move', block.id, next.start, next.end)
    await refresh()
    ctx.reveal(block.id, zoned(next.start).toPlainDate().toString())
    // Say if it landed on something, so it's clear it needs dragging somewhere free.
    const there = await call('blocks:listInRange', next.start, next.end)
    const clash = there.find((b) => b.id !== block.id)
    const clashName = clash
      ? clash.detail
        ? `${clash.heading} · ${clash.detail}`
        : (clash.heading ?? clash.title)
      : null
    toast(
      clashName
        ? `Moved to tomorrow, but it overlaps ${clashName}. Drag it to a free slot.`
        : 'Moved to tomorrow.',
      { action: undoMove(before) }
    )
  }

  // Same time next week if that's free, otherwise the first free slot that week.
  const moveToNextWeek = async () => {
    const before = { start: block.start, end: block.end }
    const result = await call('blocks:moveToNextWeek', block.id)
    if (!result.moved) {
      toast(`Not moved. ${result.reason}`)
      return
    }
    await refresh()
    const start = zoned(result.block.start)
    ctx.reveal(block.id, start.toPlainDate().toString())
    const when = `${start.toPlainDate().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${start.toPlainTime().toString({ smallestUnit: 'minute' })}`
    toast(
      result.sameTime
        ? `Moved to ${when}, same time.`
        : result.withinAvailability
          ? `Moved to ${when}, first free slot.`
          : `Moved to ${when}, first free slot (outside your working hours).`,
      { action: undoMove(before) }
    )
  }

  const nextWeekHint = zoned(block.start)
    .add({ days: 7 })
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

  return [
    {
      heading: block.heading
        ? `${block.heading}${block.detail ? ` · ${block.detail}` : ''}`
        : block.title
    },
    { label: 'Open', icon: SquareArrowOutUpRight, onSelect: () => ctx.open(block) },
    ownEvent && { label: 'Edit…', icon: Pencil, onSelect: () => ctx.open(block, 'edit') },
    ctx.duplicate &&
      block.source !== 'timetable' &&
      !block.linkedType?.startsWith('assignment') &&
      block.type !== 'write-up' && {
        label: 'Duplicate…',
        icon: Copy,
        onSelect: () => ctx.duplicate!(block)
      },
    'separator',
    work &&
      block.outcome === 'none' &&
      ctx.timer?.blockId !== block.id && {
        label: 'Start timer',
        icon: Play,
        disabled: !!ctx.timer,
        hint: ctx.timer ? 'one is running' : undefined,
        onSelect: async () => {
          await call('timer:start', block.id)
          await refresh()
        }
      },
    work &&
      started &&
      block.outcome === 'none' && {
        label: 'Mark done',
        icon: CircleCheck,
        onSelect: async () => {
          await call('blocks:markOutcome', block.id, { outcome: 'done' })
          await refresh()
          toast(`Marked done.`)
        }
      },
    work &&
      started &&
      block.outcome === 'none' && {
        label: 'Partly done…',
        icon: CircleCheck,
        onSelect: () => ctx.open(block)
      },
    work &&
      started &&
      block.outcome === 'none' && {
        label: 'Mark skipped',
        icon: CircleSlash,
        onSelect: async () => {
          await call('blocks:markOutcome', block.id, { outcome: 'skipped' })
          await refresh()
          toast('Marked skipped. It’s in the Backlog to reschedule.')
        }
      },
    'separator',
    movable && {
      label: 'Move to tomorrow',
      icon: CalendarClock,
      hint: 'same time',
      onSelect: moveToTomorrow
    },
    movable && {
      label: 'Move to next week',
      icon: CalendarArrowUp,
      hint: `${nextWeekHint} if free`,
      onSelect: moveToNextWeek
    },
    'separator',
    block.lecture && {
      label: block.lecture.title ? 'Rename lecture…' : 'Name lecture…',
      icon: Pencil,
      onSelect: async () => {
        const name = await askText({
          title: block.lecture!.title ? 'Rename lecture' : 'Name lecture',
          initial: block.lecture!.title ?? '',
          placeholder: 'e.g. Ion channels',
          note: 'Leave it empty to let Claude name it from the module’s files.',
          allowEmpty: true
        })
        if (name === null) return
        await call('lectures:rename', block.lecture!.id, name || null)
        await refresh()
      }
    },
    block.lecture &&
      block.type === 'lecture' && {
        label: 'Same lecture as the one before',
        icon: ArrowUpToLine,
        hint: 'merge',
        onSelect: async () => {
          await call('lectures:mergeWithPrevious', block.lecture!.id)
          await refresh()
          toast('Merged: one lecture, with one write-up after its last session.', {
            action: {
              label: 'Undo',
              run: async () => {
                await call('lectures:separate', block.lecture!.id)
                await refresh()
              }
            }
          })
        }
      },
    block.lecture && {
      label: 'Show in Modules',
      icon: Layers,
      onSelect: () => ctx.navigate(`/modules/${block.lecture!.moduleId}`)
    },
    'separator',
    {
      label: 'Open record',
      icon: FileText,
      onSelect: () => call('records:open', block.id)
    },
    'separator',
    canDelete(block) && {
      label: 'Delete…',
      icon: Trash2,
      hint: 'Delete key',
      danger: true,
      confirm: deleteQuestion(block),
      onSelect: () => deleteBlock(block, ctx.qc)
    },
    !!block.recurrenceId && {
      label: 'Remove this occurrence…',
      icon: Trash2,
      danger: true,
      confirm: 'Remove just this one? The rest of the series stays.',
      onSelect: async () => {
        await call('blocks:removeOccurrence', block.id)
        await refresh()
      }
    },
    !!block.recurrenceId && {
      label: 'Stop repeating after this one…',
      icon: CalendarX,
      danger: true,
      confirm: 'Make this the last one? Later occurrences you haven’t changed go.',
      onSelect: async () => {
        await call('blocks:endSeriesAfter', block.id)
        await refresh()
        toast('The series stops after this one.')
      }
    },
    block.source === 'timetable' && {
      label: 'Hide from calendar…',
      icon: EyeOff,
      danger: true,
      confirm: 'Hide this timetabled event? Settings → Timetable brings it back.',
      onSelect: async () => {
        await hideTimetabled(block, ctx.qc)
      }
    }
  ]
}

/** The right-click menu for several blocks selected with Shift-click. */
export function selectionMenu(selection: Block[], ctx: Ctx): MenuEntry[] {
  const movable = selection.filter(isUserMovable)
  const moveAll = async (days: number, label: string) => {
    const moved: Block[] = []
    for (const b of movable) {
      const next = shiftDays(b, days)
      try {
        await call('blocks:move', b.id, next.start, next.end)
        moved.push(b)
      } catch {
        // One that can't move stays where it was.
      }
    }
    await ctx.qc.invalidateQueries()
    if (moved[0])
      ctx.reveal(moved[0].id, zoned(shiftDays(moved[0], days).start).toPlainDate().toString())
    toast(`Moved ${moved.length} blocks to ${label}, same times.`, {
      action: {
        label: 'Undo',
        run: async () => {
          for (const b of moved) await call('blocks:move', b.id, b.start, b.end)
          await ctx.qc.invalidateQueries()
        }
      }
    })
  }
  const deletable = selection.filter(canDelete)
  return [
    { heading: `${selection.length} blocks selected · Esc to clear` },
    {
      label: 'Move all to tomorrow',
      icon: CalendarClock,
      hint: 'same times',
      disabled: !movable.length,
      onSelect: () => moveAll(1, 'tomorrow')
    },
    {
      label: 'Move all to next week',
      icon: CalendarArrowUp,
      hint: 'same times',
      disabled: !movable.length,
      onSelect: () => moveAll(7, 'next week')
    },
    'separator',
    deletable.length > 0 && {
      label: `Delete ${deletable.length === selection.length ? 'all' : deletable.length}…`,
      icon: Trash2,
      danger: true,
      confirm: `Delete ${deletable.length} blocks? Write-ups deleted this way aren’t placed again; work sessions lower their stage’s estimate.`,
      onSelect: async () => {
        for (const b of deletable) await deleteBlock(b, ctx.qc)
        toast(`Deleted ${deletable.length} blocks. Undo each from the toolbar’s Undo.`)
      }
    }
  ]
}
