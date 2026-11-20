import { desc, eq } from 'drizzle-orm'
import type { Temporal } from 'temporal-polyfill'
import type { ConversationMode, ConversationSummary, StoredConversation } from '../../shared/types'
import { toIso } from '../../core/time'
import type { Db } from '../db/client'
import * as t from '../db/schema'

// Claude conversations, kept in the profile's database: the panel's tabs come back after a
// restart, old chats can be reopened from History, and a new message resumes the same
// Agent SDK session (so Claude remembers what was said).

const MAX_MESSAGES = 400

const textOf = (m: unknown) =>
  m && typeof m === 'object' && 'text' in m && typeof m.text === 'string' ? m.text : ''

/** Every kept conversation, latest first. */
export function listConversations(db: Db): ConversationSummary[] {
  return db
    .select()
    .from(t.conversations)
    .orderBy(desc(t.conversations.updatedAt))
    .all()
    .map((r) => {
      const last = [...r.messages].reverse().find((m) => textOf(m).trim())
      return {
        id: r.id,
        title: r.title,
        mode: r.mode,
        open: r.open,
        updatedAt: r.updatedAt,
        messageCount: r.messages.length,
        preview: textOf(last).replace(/\s+/g, ' ').slice(0, 140)
      }
    })
}

export function getConversation(db: Db, id: string): StoredConversation | null {
  const r = db.select().from(t.conversations).where(eq(t.conversations.id, id)).get()
  return r
    ? {
        id: r.id,
        title: r.title,
        mode: r.mode,
        messages: r.messages,
        open: r.open,
        updatedAt: r.updatedAt
      }
    : null
}

/** Save what the panel shows (the Claude session it resumes is kept as it was). */
export function saveConversation(
  db: Db,
  c: { id: string; title: string; mode: ConversationMode; messages: unknown[]; open: boolean },
  now: Temporal.Instant
): void {
  if (!c.id || c.id.length > 100) throw new Error('Invalid conversation.')
  const values = {
    title: (c.title.trim() || 'Chat').slice(0, 120),
    mode: c.mode,
    messages: c.messages.slice(-MAX_MESSAGES),
    open: !!c.open,
    updatedAt: toIso(now)
  }
  db.insert(t.conversations)
    .values({ id: c.id, ...values })
    .onConflictDoUpdate({ target: t.conversations.id, set: values })
    .run()
}

/** Show a kept conversation as a tab again, or close its tab (it stays in History). */
export function setConversationOpen(db: Db, id: string, open: boolean): void {
  db.update(t.conversations).set({ open }).where(eq(t.conversations.id, id)).run()
}

export function deleteConversation(db: Db, id: string): void {
  db.delete(t.conversations).where(eq(t.conversations.id, id)).run()
}

export function getSessionId(db: Db, id: string): string | null {
  return (
    db
      .select({ s: t.conversations.sessionId })
      .from(t.conversations)
      .where(eq(t.conversations.id, id))
      .get()?.s ?? null
  )
}

/** Remember which Agent SDK session a conversation is (its row is made if need be). */
export function setSessionId(
  db: Db,
  id: string,
  mode: ConversationMode,
  sessionId: string | null,
  now: Temporal.Instant
): void {
  const changed = db
    .update(t.conversations)
    .set({ sessionId })
    .where(eq(t.conversations.id, id))
    .run().changes
  if (!changed && sessionId) {
    db.insert(t.conversations)
      .values({ id, title: 'Chat', mode, messages: [], sessionId, updatedAt: toIso(now) })
      .run()
  }
}
