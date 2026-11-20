import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as t from './db/schema'
import { normaliseFeedUrl, TimetableFeed, type FeedSecret } from './feed'
import { buildDemoTimetableIcs } from './seed/demo-timetable'
import { EncryptedJson } from './secrets'
import * as setup from './setup'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

/** A fresh real profile (empty, as before setup). */
function real() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-setup-'))
  const ctx = new AppContext(dir, migrations, { clock: () => NOW, profile: 'real' })
  contexts.push(ctx)
  ctx.open()
  return { ctx, dir }
}

// Stands in for safeStorage (tests only).
const plain = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s: string) => Buffer.from(s),
  decryptStringAsync: async (b: Buffer) => ({ result: b.toString() })
}

const SECRET_LINK = 'https://timetable.example/ical/personal-key-123'

function feedFor(ctx: AppContext, dir: string, fetchText: (url: string) => Promise<string>) {
  const store = new EncryptedJson<FeedSecret>(dir, 'timetable', plain)
  const feed = new TimetableFeed({
    store,
    db: () => ctx.db,
    now: () => NOW,
    isReal: () => ctx.profile.name === 'real',
    changed: () => {},
    fetchText
  })
  return { feed, store }
}

describe('the timetable link', () => {
  it('accepts https and webcal links, and nothing else', () => {
    expect(normaliseFeedUrl(' webcal://timetable.example/a.ics ')).toBe(
      'https://timetable.example/a.ics'
    )
    expect(normaliseFeedUrl(SECRET_LINK)).toBe(SECRET_LINK)
    expect(() => normaliseFeedUrl('http://timetable.example/a.ics')).toThrow(/https/)
    expect(() => normaliseFeedUrl('not a link')).toThrow(/isn’t a link/)
    expect(() => normaliseFeedUrl('')).toThrow(/Paste/)
  })

  it('imports from the link and keeps it only if that worked', async () => {
    const { ctx, dir } = real()
    const { feed, store } = feedFor(ctx, dir, async () => buildDemoTimetableIcs(NOW))
    expect(feed.status().connected).toBe(false)
    const summary = await feed.connect(SECRET_LINK)
    expect(summary.events).toBeGreaterThan(0)
    expect(summary.unmappedNames.length).toBeGreaterThan(0) // modules are mapped in setup next
    expect(await store.get()).toEqual({ url: SECRET_LINK })
    expect(feed.status()).toMatchObject({ connected: true, lastError: null })
    // The link is never written into the database.
    const everything = JSON.stringify(ctx.db.select().from(t.settings).all())
    expect(everything).not.toContain('personal-key')
    // A later import works from the stored link.
    expect((await feed.importNow())?.added).toBe(0)
  })

  it('refuses a link that isn’t a calendar, without keeping it or showing it', async () => {
    const { ctx, dir } = real()
    const { feed, store } = feedFor(ctx, dir, async () => '<html>Sign in</html>')
    await expect(feed.connect(SECRET_LINK)).rejects.toThrow(/doesn’t lead to a calendar/)
    expect(store.has()).toBe(false)
    const failing = feedFor(ctx, dir, async () => {
      throw new Error('The timetable didn’t accept that link.')
    })
    await expect(failing.feed.connect(SECRET_LINK)).rejects.not.toThrow(/personal-key/)
  })

  it('records a failed poll without the link', async () => {
    const { ctx, dir } = real()
    let ok = true
    const { feed } = feedFor(ctx, dir, async () => {
      if (ok) return buildDemoTimetableIcs(NOW)
      throw new Error('Couldn’t reach the timetable. Check your internet connection.')
    })
    await feed.connect(SECRET_LINK)
    ok = false
    await expect(feed.importNow()).rejects.toThrow(/Couldn’t reach/)
    expect(feed.status().lastError).toMatch(/Couldn’t reach/)
    expect(JSON.stringify(feed.status())).not.toContain('personal-key')
  })
})

describe('setup', () => {
  it('keeps the weekly target and marks setup finished', () => {
    const { ctx } = real()
    expect(setup.getSetupState(ctx.db)).toMatchObject({
      startDate: null,
      weeklyTargetMinutes: null,
      completedAt: null
    })
    setup.setWeeklyTarget(ctx.db, 20 * 60)
    expect(() => setup.setWeeklyTarget(ctx.db, 5)).toThrow(/between 1 and 100/)
    setup.completeSetup(ctx.db, NOW)
    expect(setup.getSetupState(ctx.db)).toMatchObject({
      weeklyTargetMinutes: 1200,
      completedAt: NOW.toString()
    })
    setup.setWeeklyTarget(ctx.db, null)
    expect(setup.getSetupState(ctx.db).weeklyTargetMinutes).toBeNull()
  })

  it('adds a weekly commitment (creating its category) and ends it', () => {
    const { ctx } = real()
    const pub = setup.addCommitment(
      ctx.db,
      { title: 'Pub shift', kind: 'work', byWeekday: [6], startTime: '17:00', endTime: '00:00' },
      NOW
    )
    expect(pub).toMatchObject({ title: 'Pub shift', kind: 'work', byWeekday: [6] })
    expect(
      ctx.db
        .select()
        .from(t.categories)
        .all()
        .map((c) => c.kind)
    ).toEqual(['work'])
    const occurrences = () =>
      ctx.db.select().from(t.blocks).where(eq(t.blocks.recurrenceId, pub.id)).all()
    const first = occurrences().sort((a, b) => a.start.localeCompare(b.start))[0]
    // Saturday 21 Nov, 17:00 to midnight (London = UTC in November).
    expect([first.start, first.end]).toEqual(['2026-11-21T17:00:00Z', '2026-11-22T00:00:00Z'])
    expect(occurrences().length).toBeGreaterThan(8)
    expect(() =>
      setup.addCommitment(
        ctx.db,
        { title: '', kind: 'work', byWeekday: [6], startTime: '17:00', endTime: '00:00' },
        NOW
      )
    ).toThrow(/name/)

    setup.endCommitment(ctx.db, pub.id, NOW)
    expect(occurrences()).toHaveLength(0)
    expect(setup.listCommitments(ctx.db)).toEqual([])
  })
})
