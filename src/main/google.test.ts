import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as cal from './calendar'
import * as t from './db/schema'
import { GoogleAuth, parseClient, type GoogleCredentials } from './google/auth'
import { FileCalendar, GoogleCalendar, googleBody } from './google/calendar'
import { getGoogleSettings, pushOnce, wantedEvents } from './google/sync'
import type { EncryptedJson } from './secrets'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-g-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  const target = new FileCalendar(ctx.profile.googleDemoFile)
  const events = () =>
    Object.values(
      (JSON.parse(readFileSync(ctx.profile.googleDemoFile, 'utf8')) as { events: object }).events
    ) as { key: string; summary: string }[]
  return { db: ctx.db, target, events }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

describe('pushing the calendar (demo file)', () => {
  it('pushes every block and deadline in the window once, then nothing until a change', async () => {
    const { db, target, events } = open()
    const wanted = wantedEvents(db, NOW).events
    expect(wanted.length).toBeGreaterThan(50)
    const first = await pushOnce(db, target, NOW, true, null)
    expect(first.inserted).toBe(wanted.length)
    expect(events()).toHaveLength(wanted.length)
    expect(getGoogleSettings(db, true).calendarId).toBe(first.calendarId)
    const again = await pushOnce(db, target, NOW, true, first.calendarId)
    expect(again).toMatchObject({ inserted: 0, updated: 0, removed: 0 })
  })

  it('updates a moved block and removes a skipped one', async () => {
    const { db, target, events } = open()
    const { calendarId } = await pushOnce(db, target, NOW, true, null)
    const block = db
      .select()
      .from(t.blocks)
      .all()
      .find((b) => b.kind === 'flexible' && b.outcome === 'none' && b.start > NOW.toString())!
    const start = Temporal.Instant.from(block.start).add({ hours: 24 })
    const end = Temporal.Instant.from(block.end).add({ hours: 24 })
    cal.moveBlock(db, block.id, start.toString(), end.toString(), 'user')
    expect(await pushOnce(db, target, NOW, true, calendarId)).toMatchObject({
      updated: 1,
      inserted: 0
    })
    db.update(t.blocks).set({ outcome: 'skipped' }).where(eq(t.blocks.id, block.id)).run()
    expect(await pushOnce(db, target, NOW, true, calendarId)).toMatchObject({ removed: 1 })
    expect(events().some((e) => e.key === `block:${block.id}`)).toBe(false)
  })

  it('picks up its own events instead of duplicating them when the record is lost', async () => {
    const { db, target, events } = open()
    const { calendarId } = await pushOnce(db, target, NOW, true, null)
    const count = events().length
    db.delete(t.gcalEvents).run()
    const r = await pushOnce(db, target, NOW, true, calendarId)
    expect(r.inserted).toBe(0)
    expect(events()).toHaveLength(count)
  })

  it('starts a new calendar when the old one is gone', async () => {
    const { db, target } = open()
    const { calendarId } = await pushOnce(db, target, NOW, true, null)
    await target.deleteCalendar()
    const r = await pushOnce(db, target, NOW, true, null)
    expect(r.calendarId).not.toBe(calendarId)
    expect(r.inserted).toBeGreaterThan(50)
  })
})

/** A fake fetch: records requests and answers from a function. */
function fakeFetch(
  answer: (url: string, init: RequestInit) => { status?: number; body?: unknown }
) {
  const calls: { url: string; method: string; body: string | null }[] = []
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? String(init.body) : null
    })
    const a = answer(String(url), init)
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status ?? 200
    })
  }) as unknown as typeof fetch
  return { f, calls }
}

class MemoryStore {
  value: GoogleCredentials | null = null
  has = () => this.value !== null
  get = async () => this.value
  set = async (v: GoogleCredentials) => {
    this.value = v
  }
  clear = () => {
    this.value = null
  }
}

describe('Google sign-in', () => {
  it('takes the client from its ID and secret or the downloaded JSON', () => {
    expect(parseClient('123-abc.apps.googleusercontent.com', ' s3cret ')).toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 's3cret'
    })
    expect(
      parseClient('{"installed":{"client_id":"x.apps.googleusercontent.com","client_secret":"y"}}')
    ).toEqual({ clientId: 'x.apps.googleusercontent.com', clientSecret: 'y' })
    expect(() => parseClient('{"web":{}}')).toThrow(/Desktop app/)
    expect(() => parseClient('nonsense', 'x')).toThrow(/googleusercontent/)
  })

  it('refreshes the access token, and forgets the sign-in when Google refuses it', async () => {
    const store = new MemoryStore()
    store.value = { clientId: 'c', clientSecret: 's', refreshToken: 'r' }
    let refuse = false
    const { f, calls } = fakeFetch(() =>
      refuse
        ? { status: 400, body: { error: 'invalid_grant' } }
        : { body: { access_token: 'a1', expires_in: 3600 } }
    )
    const auth = new GoogleAuth({
      store: store as unknown as EncryptedJson<GoogleCredentials>,
      openExternal: async () => {},
      fetch: f
    })
    expect(await auth.accessToken()).toBe('a1')
    expect(await auth.accessToken()).toBe('a1') // cached
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toContain('grant_type=refresh_token')

    const auth2 = new GoogleAuth({
      store: store as unknown as EncryptedJson<GoogleCredentials>,
      openExternal: async () => {},
      fetch: f
    })
    refuse = true
    await expect(auth2.accessToken()).rejects.toThrow(/Sign in again/)
    expect(store.value).toEqual({ clientId: 'c', clientSecret: 's' })
    expect((await auth2.state()).signedIn).toBe(false)
  })

  it('signs in through a loopback redirect with PKCE and keeps the refresh token', async () => {
    const store = new MemoryStore()
    store.value = { clientId: 'c.apps.googleusercontent.com', clientSecret: 's' }
    const { f, calls } = fakeFetch(() => ({
      body: { access_token: 'a', expires_in: 3600, refresh_token: 'r1' }
    }))
    let opened = ''
    const auth = new GoogleAuth({
      store: store as unknown as EncryptedJson<GoogleCredentials>,
      openExternal: async (url) => {
        opened = url
        // The browser: Google redirects back with the code and the same state.
        const u = new URL(url)
        const back = new URL(u.searchParams.get('redirect_uri')!)
        back.searchParams.set('code', 'the-code')
        back.searchParams.set('state', u.searchParams.get('state')!)
        setTimeout(() => void fetch(back), 10)
      },
      fetch: f
    })
    await auth.signIn()
    const u = new URL(opened)
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.app.created')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(calls[0].body).toContain('code=the-code')
    expect(calls[0].body).toContain('code_verifier=')
    expect(store.value?.refreshToken).toBe('r1')
  })
})

describe('Google Calendar API calls', () => {
  it('creates its own calendar, and sends events without reminders, keyed for Engram', async () => {
    const { f, calls } = fakeFetch((url, init) =>
      url.endsWith('/calendars/old')
        ? { status: 404 }
        : init.method === 'POST'
          ? { body: { id: 'new-id' } }
          : { body: {} }
    )
    const g = new GoogleCalendar(async () => 'token', f)
    expect(await g.ensureCalendar('old')).toBe('new-id')
    expect(JSON.parse(calls[1].body!)).toMatchObject({
      summary: 'Engram',
      timeZone: 'Europe/London'
    })
    const event = {
      key: 'block:b1',
      summary: 'Write-up',
      description: '',
      start: { date: '2026-11-19' },
      end: { date: '2026-11-20' },
      colorId: null
    }
    expect(await g.insert('new-id', event)).toBe('new-id')
    expect(JSON.parse(calls[2].body!)).toEqual(googleBody(event))
    expect(googleBody(event)).toMatchObject({
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { engram: 'block:b1' } }
    })
  })
})
