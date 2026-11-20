import { eq } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import { minutesBetween } from '../core/time'
import { updateStage } from './assignments'
import { getBlock, logChange, removeOccurrence } from './calendar'
import type { Db } from './db/client'
import * as t from './db/schema'
import { setNoWriteUp } from './timetable'

// Deleting any block from the calendar (right-click → Delete, the Delete key, Claude). What
// else changes depends on the block, so it doesn't simply come back at the next replan:
//   your own event         gone
//   one of a series        just that occurrence (the series keeps going)
//   a lecture's write-up   gone, and the lecture gets none again (Plan a write-up undoes it)
//   assignment work        gone, and its stage's estimate drops by that much (ticked done
//                          when nothing would be left)
//   anything else Engram   gone (a review stays due on the Revision page)
// Timetabled events are hidden instead (Settings → Timetable brings them back).

/** Delete a block; returns a sentence about what else changed, if anything did. */
export function removeBlock(
  db: Db,
  id: string,
  now: Temporal.Instant,
  actor: 'user' | 'claude' = 'user'
): string | null {
  const block = getBlock(db, id)
  if (!block) return null
  if (block.source === 'timetable') {
    throw new Error('Timetabled events come from the feed: hide them instead.')
  }
  if (block.recurrenceId) {
    removeOccurrence(db, id, actor)
    return 'Just this one: the rest of the series stays.'
  }

  if (block.type === 'write-up' && block.linkedType === 'lecture' && block.linkedId) {
    const lecture = db.select().from(t.lectures).where(eq(t.lectures.id, block.linkedId)).get()
    if (lecture?.writeUpBlockId === id) {
      setNoWriteUp(db, lecture.id, true, now, actor)
      return 'That lecture won’t get another write-up (Modules → right-click it → Plan a write-up).'
    }
  }

  if (block.linkedType === 'assignment-stage' && block.linkedId) {
    const stage = db
      .select()
      .from(t.assignmentStages)
      .where(eq(t.assignmentStages.id, block.linkedId))
      .get()
    deleteRow(db, block, actor)
    if (stage && !stage.doneAt && block.outcome === 'none') {
      const left = stage.estimateMinutes - minutesBetween(block.start, block.end)
      if (left >= 15) {
        updateStage(db, stage.id, { estimateMinutes: left }, now)
        return `“${stage.name}” now needs ${formatHours(left)}.`
      }
      updateStage(db, stage.id, { done: true }, now)
      return `“${stage.name}” had no time left, so it’s ticked done.`
    }
    return null
  }

  deleteRow(db, block, actor)
  return null
}

function deleteRow(
  db: Db,
  block: NonNullable<ReturnType<typeof getBlock>>,
  actor: 'user' | 'claude'
) {
  db.transaction((tx) => {
    tx.delete(t.blocks).where(eq(t.blocks.id, block.id)).run()
    logChange(tx, {
      actor,
      action: 'block.delete',
      entityType: 'block',
      entityId: block.id,
      before: block
    })
  })
}

const formatHours = (m: number) =>
  m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
