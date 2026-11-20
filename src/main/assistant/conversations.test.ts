import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from '../app-context'
import * as conv from './conversations'

const migrations = resolve(__dirname, '../../../drizzle')
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-conv-')), migrations, {
    clock: () => Temporal.Instant.from('2026-11-19T10:00:00Z')
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))
const at = (s: string) => Temporal.Instant.from(s)

describe('kept conversations', () => {
  it('are saved, listed latest first with a preview, closed, reopened and deleted', () => {
    const db = open()
    const chat = { kind: 'chat' } as const
    conv.saveConversation(
      db,
      {
        id: 'chat-a',
        title: 'Move my write-up',
        mode: chat,
        messages: [{ role: 'user', text: 'Move my L7 write-up' }],
        open: true
      },
      at('2026-11-19T10:00:00Z')
    )
    conv.saveConversation(
      db,
      {
        id: 'chat-b',
        title: 'Plan the week',
        mode: chat,
        messages: [
          { role: 'user', text: 'Plan my week' },
          { role: 'assistant', text: 'Here’s a\\nplan.' }
        ],
        open: true
      },
      at('2026-11-19T11:00:00Z')
    )
    const list = conv.listConversations(db)
    expect(list.map((c) => c.id)).toEqual(['chat-b', 'chat-a'])
    expect(list[0]).toMatchObject({ messageCount: 2, open: true })
    expect(list[0].preview).toContain('plan')

    conv.setConversationOpen(db, 'chat-a', false)
    expect(conv.getConversation(db, 'chat-a')!.open).toBe(false)
    conv.deleteConversation(db, 'chat-a')
    expect(conv.getConversation(db, 'chat-a')).toBeNull()
  })

  it('keep the Claude session across saves, even one saved before the panel saved it', () => {
    const db = open()
    const now = at('2026-11-19T10:00:00Z')
    conv.setSessionId(db, 'chat-c', { kind: 'chat' }, 'session-1', now)
    conv.saveConversation(
      db,
      { id: 'chat-c', title: 'Hi', mode: { kind: 'chat' }, messages: [{ text: 'hi' }], open: true },
      now
    )
    expect(conv.getSessionId(db, 'chat-c')).toBe('session-1')
    conv.setSessionId(db, 'chat-c', { kind: 'chat' }, null, now)
    expect(conv.getSessionId(db, 'chat-c')).toBeNull()
  })
})
