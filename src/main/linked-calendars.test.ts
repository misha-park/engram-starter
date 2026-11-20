import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as t from './db/schema'
import {
  LinkedCalendars,
  normaliseCalendarUrl,
  type CalendarSecret,
  type SecretStore
} from './linked-calendars'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const URL_A = 'https://p01-caldav.icloud.com/published/2/SECRET-KEY-A'
const WEEK = ['2026-11-23T00:00:00Z', '2026-11-30T00:00:00Z'] as const

const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const ics = (name: string, ...events: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iCloud Calendar//EN',
    `X-WR-CALNAME:${name}`,
    ...events.map((e) => `BEGIN:VEVENT\nDTSTAMP:20261101T000000Z\n${e}\nEND:VEVENT`),
    'END:VCALENDAR'
  ].join('\n')

const DENTIST = 'UID:d\nDTSTART:20261124T140000Z\nDTEND:20261124T150000Z\nSUMMARY:Dentist'
const BDAY = 'UID:b\nDTSTART;VALUE=DATE:20261125\nDTEND;VALUE=DATE:20261126\nSUMMARY:Sam’s birthday'

function setup(feeds: Record<string, string | Error>, real = true) {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'planner-cal-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  let saved: CalendarSecret | null = null
  const store: SecretStore<CalendarSecret> = {
    has: () => saved !== null,
    get: async () => saved,
    set: async (v) => {
      saved = v
    },
    clear: () => {
      saved = null
    }
  }
  let changes = 0
  const calendars = new LinkedCalendars({
    store,
    db: () => ctx.db,
    now: () => NOW,
    isReal: () => real,
    changed: () => changes++,
    fetchText: async (url) => {
      const feed = feeds[url]
      if (feed === undefined) throw new Error('The calendar didn’t accept that link.')
      if (feed instanceof Error) throw feed
      return feed
    }
  })
  return { ctx, db: ctx.db, calendars, feeds, store: () => saved, changes: () => changes }
}

describe('normaliseCalendarUrl', () => {
  it('turns webcal into https and refuses anything else', () => {
    expect(normaliseCalendarUrl(' webcal://p01.icloud.com/published/2/KEY ')).toBe(
      'https://p01.icloud.com/published/2/KEY'
    )
    expect(() => normaliseCalendarUrl('http://example.com/a.ics')).toThrow(/https/)
    expect(() => normaliseCalendarUrl('not a link')).toThrow(/link/)
    expect(() => normaliseCalendarUrl('  ')).toThrow(/Paste/)
  })
})

describe('linked calendars', () => {
  it('links a calendar: its own name, a free colour, a toggle, its events, no link shown', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST, BDAY) })
    const blocksBefore = x.db.select().from(t.blocks).all().length
    const added = await x.calendars.add(URL_A)
    expect(added).toMatchObject({ name: 'Personal', events: 2, lastError: null })

    // A category of its own: that's its toggle in the Calendars list.
    const cat = x.db.select().from(t.categories).where(eq(t.categories.id, added.id)).get()!
    expect(cat).toMatchObject({ kind: 'calendar', name: 'Personal', colour: added.colour })
    const others = x.db
      .select()
      .from(t.categories)
      .all()
      .filter((c) => c.id !== cat.id)
    expect(others.some((c) => c.colour.toLowerCase() === cat.colour.toLowerCase())).toBe(false)

    // Shown on the calendar for reference (timed and all-day), nothing else changes.
    const events = x.calendars.listEvents(...WEEK)
    expect(events.map((e) => [e.title, e.allDay, e.calendar, e.colour])).toEqual([
      ['Dentist', false, 'Personal', cat.colour],
      ['Sam’s birthday', true, 'Personal', cat.colour]
    ])
    expect(events.every((e) => e.calendarId === cat.id)).toBe(true)
    expect(x.calendars.listEvents('2026-12-14T00:00:00Z', '2026-12-21T00:00:00Z')).toEqual([])

    // Never blocks: nothing is planned around them, and Claude/Google never see them.
    expect(x.db.select().from(t.blocks).all()).toHaveLength(blocksBefore)

    // The link is kept encrypted (the store) and appears nowhere else.
    expect(x.store()?.calendars).toEqual([{ id: cat.id, url: URL_A }])
    expect(JSON.stringify(x.calendars.list())).not.toContain('SECRET-KEY')
    expect(JSON.stringify(x.db.select().from(t.settings).all())).not.toContain('SECRET-KEY')
    expect(x.changes()).toBeGreaterThan(0)
  })

  it('refuses the same link twice, and bad or unreachable links, linking nothing', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST), 'https://x.test/junk': 'hello' })
    await x.calendars.add(URL_A)
    await expect(x.calendars.add(URL_A)).rejects.toThrow(/already linked/)
    await expect(x.calendars.add('https://x.test/junk')).rejects.toThrow(
      /doesn’t lead to a calendar/
    )
    await expect(x.calendars.add('https://x.test/gone')).rejects.toThrow(/didn’t accept/)
    expect(x.calendars.list()).toHaveLength(1)
    expect(x.store()?.calendars).toHaveLength(1)
  })

  it('is only for real data', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST) }, false)
    await expect(x.calendars.add(URL_A)).rejects.toThrow(/real data/)
    expect(x.calendars.list()).toEqual([])
  })

  it('re-reads on a check: new, changed and removed events follow the calendar', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST, BDAY) })
    await x.calendars.add(URL_A)
    x.feeds[URL_A] = ics(
      'Personal',
      'UID:d\nDTSTART:20261124T160000Z\nDTEND:20261124T170000Z\nSUMMARY:Dentist (moved)',
      'UID:n\nDTSTART:20261126T100000Z\nDTEND:20261126T110000Z\nSUMMARY:New thing'
    )
    await x.calendars.syncNow()
    expect(x.calendars.listEvents(...WEEK).map((e) => [e.title, e.start])).toEqual([
      ['Dentist (moved)', '2026-11-24T16:00:00Z'],
      ['New thing', '2026-11-26T10:00:00Z']
    ])
    expect(x.calendars.list()[0]).toMatchObject({ events: 2, lastError: null })
  })

  it('keeps the events it has when a check fails, and says so without the link', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST) })
    await x.calendars.add(URL_A)
    x.feeds[URL_A] = new Error('Couldn’t reach the calendar. Check your internet connection.')
    await x.calendars.syncNow()
    expect(x.calendars.listEvents(...WEEK)).toHaveLength(1)
    const [c] = x.calendars.list()
    expect(c.lastError).toMatch(/Couldn’t reach/)
    expect(JSON.stringify(c)).not.toContain('SECRET-KEY')
  })

  it('deletes one event from the view, for good, and can bring it back; the rest stay', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST, BDAY) })
    const { id } = await x.calendars.add(URL_A)
    const titles = () => x.calendars.listEvents(...WEEK).map((e) => e.title)
    expect(x.calendars.listEvents(...WEEK)[0].uid).toBe('d')

    x.calendars.hideEvent(id, 'd')
    expect(titles()).toEqual(['Sam’s birthday'])
    // Still gone after the calendar is read again (even if it changed).
    x.feeds[URL_A] = ics(
      'Personal',
      'UID:d\nDTSTART:20261124T160000Z\nDTEND:20261124T170000Z\nSUMMARY:Dentist (moved)',
      BDAY
    )
    await x.calendars.syncNow()
    expect(titles()).toEqual(['Sam’s birthday'])

    x.calendars.restoreEvent(id, 'd')
    expect(titles()).toEqual(['Dentist (moved)', 'Sam’s birthday'])
    expect(() => x.calendars.hideEvent('nope', 'd')).toThrow(/not found/)
  })

  it('stops remembering a deleted event once it is off the calendar, and when unlinked', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST, BDAY) })
    const { id } = await x.calendars.add(URL_A)
    const hidden = () =>
      JSON.stringify(
        x.db.select().from(t.settings).where(eq(t.settings.key, 'linkedCalendarHidden')).all()
      )
    x.calendars.hideEvent(id, 'd')
    expect(hidden()).toContain('"d"')
    x.feeds[URL_A] = ics('Personal', BDAY)
    await x.calendars.syncNow()
    expect(hidden()).not.toContain('"d"')
    x.calendars.hideEvent(id, 'b')
    await x.calendars.remove(id)
    expect(hidden()).not.toContain(id)
  })

  it('renames, recolours, and refuses a bad colour or an empty name', async () => {
    const x = setup({ [URL_A]: ics('Personal', DENTIST) })
    const { id } = await x.calendars.add(URL_A)
    x.calendars.update(id, { name: '  Home ', colour: '#112233' })
    expect(x.calendars.list()[0]).toMatchObject({ name: 'Home', colour: '#112233' })
    expect(x.calendars.listEvents(...WEEK)[0]).toMatchObject({
      calendar: 'Home',
      colour: '#112233'
    })
    expect(() => x.calendars.update(id, { colour: 'red' })).toThrow(/colour/)
    expect(() => x.calendars.update(id, { name: ' ' })).toThrow(/name/)
    expect(() => x.calendars.update('nope', { name: 'x' })).toThrow(/not found/)
  })

  it('keeps two calendars apart, and unlinking one removes only its events', async () => {
    const URL_B = 'https://p02-caldav.icloud.com/published/2/SECRET-KEY-B'
    const x = setup({
      [URL_A]: ics('Personal', DENTIST),
      [URL_B]: ics(
        'Personal',
        'UID:g\nDTSTART:20261124T180000Z\nDTEND:20261124T190000Z\nSUMMARY:Gym'
      )
    })
    const a = await x.calendars.add(URL_A)
    const b = await x.calendars.add(URL_B)
    // The same name is made unique, so each has its own toggle.
    expect(new Set([a.name, b.name]).size).toBe(2)
    expect(x.calendars.listEvents(...WEEK)).toHaveLength(2)

    await x.calendars.remove(a.id)
    expect(x.calendars.list().map((c) => c.id)).toEqual([b.id])
    expect(x.calendars.listEvents(...WEEK).map((e) => e.title)).toEqual(['Gym'])
    expect(x.db.select().from(t.categories).where(eq(t.categories.id, a.id)).all()).toEqual([])
    expect(x.store()?.calendars).toEqual([{ id: b.id, url: URL_B }])

    await x.calendars.remove(b.id)
    expect(x.store()).toBeNull()
    expect(x.calendars.listEvents(...WEEK)).toEqual([])
    expect(JSON.stringify(x.db.select().from(t.settings).all())).not.toContain(b.id)
  })
})
