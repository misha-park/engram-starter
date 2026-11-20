import { randomUUID } from 'crypto'
import type { Temporal } from 'temporal-polyfill'
import { toIso } from '../../core/time'
import type { AssistantMemory } from '../../shared/types'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { getSetting } from '../repo'

// Things the user asked Claude to remember about how they like to work ("no write-ups after
// 21:00"). Kept in one setting, shown in every conversation's prompt, and listed in
// Settings → Claude where the user can add or remove them. Changes Claude makes are tracked
// (changes.ts), so they can be undone like any other change.

export const MEMORY_KEY = 'assistantMemory'
export const MEMORY_MAX = 30
export const MEMORY_TEXT_MAX = 200

export function listMemories(db: Db): AssistantMemory[] {
  return getSetting<AssistantMemory[]>(db, MEMORY_KEY) ?? []
}

function save(db: Db, value: AssistantMemory[]): void {
  db.insert(t.settings)
    .values({ key: MEMORY_KEY, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

export function addMemory(db: Db, text: string, now: Temporal.Instant): AssistantMemory {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('Nothing to remember.')
  if (clean.length > MEMORY_TEXT_MAX) {
    throw new Error(`Keep it under ${MEMORY_TEXT_MAX} characters.`)
  }
  const all = listMemories(db)
  const same = all.find((m) => m.text.toLowerCase() === clean.toLowerCase())
  if (same) return same
  if (all.length >= MEMORY_MAX) {
    throw new Error(`There are already ${MEMORY_MAX} notes. Remove one first.`)
  }
  const memory = { id: `mem-${randomUUID().slice(0, 8)}`, text: clean, createdAt: toIso(now) }
  save(db, [...all, memory])
  return memory
}

export function removeMemory(db: Db, id: string): AssistantMemory {
  const all = listMemories(db)
  const gone = all.find((m) => m.id === id)
  if (!gone) throw new Error('No note with that id.')
  save(
    db,
    all.filter((m) => m.id !== id)
  )
  return gone
}

/** The notes as prompt lines, or null when there are none. */
export function memoryPrompt(db: Db): string | null {
  const all = listMemories(db)
  if (!all.length) return null
  return `What the user asked you to remember (follow these when planning; the placement rules still come first; ids are for forget):\n${all
    .map((m) => `- ${m.text} (${m.id})`)
    .join('\n')}`
}
