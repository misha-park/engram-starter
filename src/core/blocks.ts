import { Temporal } from 'temporal-polyfill'
import type { Block } from '../shared/types'

/**
 * Whether the user may drag or resize a block by hand.
 * Timetabled events come from the university feed and stay put; fixed events the user
 * created (pub shift, social plans) and all flexible blocks can be moved.
 */
export function isUserMovable(block: Pick<Block, 'kind' | 'source'>): boolean {
  return block.kind === 'flexible' || block.source !== 'timetable'
}

/** Whether automatic placement (scheduler, assistant) may move a block. Fixed never moves. */
export function isAutoMovable(block: Pick<Block, 'kind'>): boolean {
  return block.kind === 'flexible'
}

/** Validates a proposed new time range; returns an error message or null. */
export function validateRange(startIso: string, endIso: string): string | null {
  let start: Temporal.Instant, end: Temporal.Instant
  try {
    start = Temporal.Instant.from(startIso)
    end = Temporal.Instant.from(endIso)
  } catch {
    return 'Invalid date.'
  }
  if (Temporal.Instant.compare(end, start) <= 0) return 'A block must end after it starts.'
  if (start.until(end).total({ unit: 'hours' }) > 24)
    return 'A block cannot be longer than 24 hours.'
  return null
}
