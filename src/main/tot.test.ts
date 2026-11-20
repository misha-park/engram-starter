import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import * as t from './db/schema'
import { FileTot, getTotSettings, RealTot, syncOnce, TotSync, type TotSource } from './tot'
import * as todos from './todos'

const migrations = resolve(__dirname, '../../drizzle')
const NOW = Temporal.Instant.from('2026-11-18T14:00:00Z')
const contexts: AppContext[] = []
function open() {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-tot-')), migrations, {
    clock: () => NOW
  })
  contexts.push(ctx)
  ctx.open()
  const file = ctx.profile.totDemoFile
  return {
    ctx,
    db: ctx.db,
    file,
    source: new FileTot(file),
    read: () => readFileSync(file, 'utf8')
  }
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

const open_ = (db: ReturnType<typeof open>['db']) =>
  db
    .select()
    .from(t.todos)
    .all()
    .filter((r) => !r.done && !r.archived)
    .map((r) => r.title)

describe('Tot sync against the demo file', () => {
  it('merges the seeded dot with the seeded todos on the first sync', async () => {
    const { db, source, read } = open()
    const before = open_(db)
    await syncOnce(db, source, NOW, true)
    const text = read()
    // The new open line became a todo; the matching ones didn't duplicate.
    expect(open_(db)).toContain('Collect hoodie from the SU')
    expect(open_(db).filter((x) => x === 'Return library books')).toHaveLength(1)
    // Every open app todo is now a line, once.
    for (const title of before) expect(text.split(`○ ${title}`).length - 1).toBe(1)
    expect(
      text.startsWith(
        'UNI:\n○ Return library books\n○ Print PHAR practical handout\n● Buy lab coat\n○ Collect hoodie from the SU\n'
      )
    ).toBe(true)
    // Nothing more on a second sync.
    expect(await syncOnce(db, source, NOW, true)).toEqual({ appChanges: 0, wroteTot: false })
  })

  it('round-trips ticks, new lines and deletions', async () => {
    const { db, file, source, read } = open()
    await syncOnce(db, source, NOW, true)
    const hoodie = db
      .select()
      .from(t.todos)
      .where(eq(t.todos.title, 'Collect hoodie from the SU'))
      .get()!

    // Ticked in Tot → done in the app; a new line → a new todo (source "tot").
    writeFileSync(file, read().replace('○ Collect hoodie', '● Collect hoodie') + '○ Pay lab fee\n')
    await syncOnce(db, source, NOW, true)
    expect(todos.getTodo(db, hoodie.id)!.done).toBe(true)
    const fee = db.select().from(t.todos).where(eq(t.todos.title, 'Pay lab fee')).get()!
    expect(fee.source).toBe('tot')

    // Ticked in the app → ticked in Tot; created in the app → appended.
    todos.setTodoDone(db, fee.id, true, NOW)
    const id = todos.createTodo(db, { title: 'Ask about the field trip' })
    await syncOnce(db, source, NOW, true)
    expect(read()).toContain('● Pay lab fee')
    expect(read()).toContain('○ Ask about the field trip')

    // Deleted in Tot: the ticked one stays done, the open one is archived.
    writeFileSync(
      file,
      read().replace('● Pay lab fee\n', '').replace('○ Ask about the field trip\n', '')
    )
    await syncOnce(db, source, NOW, true)
    expect(todos.getTodo(db, fee.id)).toMatchObject({ done: true, archived: false })
    expect(todos.getTodo(db, id)).toMatchObject({ done: false, archived: true })
  })

  it('appends the next instance when a recurring todo is ticked in Tot', async () => {
    const { db, file, source, read } = open()
    await syncOnce(db, source, NOW, true)
    writeFileSync(
      file,
      read().replace('○ Check lab notebook is up to date', '● Check lab notebook is up to date')
    )
    await syncOnce(db, source, NOW, true)
    await syncOnce(db, source, NOW, true)
    expect(read()).toContain('● Check lab notebook is up to date')
    expect(read()).toContain('○ Check lab notebook is up to date')
  })

  it('records an error instead of throwing, and does nothing while off', async () => {
    const { ctx, db, file } = open()
    let changed = 0
    const sync = new TotSync({
      db: () => db,
      now: () => NOW,
      source: () => new FileTot(file),
      defaultEnabled: () => true,
      changed: () => changed++
    })
    writeFileSync(file, 'Groceries\n○ milk')
    await sync.sync()
    expect(sync.status().lastError).toMatch(/UNI/)
    sync.setEnabled(false)
    writeFileSync(file, 'UNI\n○ Something new')
    await sync.sync()
    expect(open_(db)).not.toContain('Something new')
    await sync.sync(true)
    expect(open_(db)).toContain('Something new')
    expect(sync.status()).toMatchObject({ enabled: false, lastError: null, source: 'file', dot: 1 })
    expect(changed).toBe(1)
    void ctx
  })

  it('runs one sync at a time and queues one more', async () => {
    const { db, file } = open()
    let reads = 0
    const source = new FileTot(file)
    const counting = Object.assign(Object.create(source), {
      read: () => {
        reads++
        return source.read()
      }
    })
    const sync = new TotSync({
      db: () => db,
      now: () => NOW,
      source: () => counting,
      defaultEnabled: () => true,
      changed: () => {}
    })
    await Promise.all([sync.sync(), sync.sync(), sync.sync(), sync.sync()])
    // Two runs: the first writes (so reads back), the queued one finds nothing to do.
    expect(reads).toBe(3)
  })

  it('never writes to a read-only source (real Tot), and takes its changes', async () => {
    const { db, file, read } = open()
    const file_ = new FileTot(file)
    let writes = 0
    const readOnly: TotSource = {
      kind: 'tot',
      canWrite: false,
      read: () => file_.read(),
      write: async () => {
        writes++
      }
    }
    const before = read()
    todos.createTodo(db, { title: 'Made in Engram' })
    await syncOnce(db, readOnly, NOW, true)
    expect(writes).toBe(0)
    expect(read()).toBe(before)
    expect(open_(db)).toContain('Collect hoodie from the SU')
    writeFileSync(file, read().replace('○ Collect hoodie', '● Collect hoodie'))
    await syncOnce(db, readOnly, NOW, true)
    expect(open_(db)).not.toContain('Collect hoodie from the SU')
    expect(writes).toBe(0)
  })

  it('turns writing off when Tot doesn’t end up with what was written', async () => {
    const { db, file, read } = open()
    const fileTot = new FileTot(file)
    // Two-way on; a "shortcut" that silently does nothing.
    db.insert(t.settings)
      .values({ key: 'tot', value: { twoWay: true } })
      .onConflictDoUpdate({ target: t.settings.key, set: { value: { twoWay: true } } })
      .run()
    const broken: TotSource = {
      kind: 'tot',
      canWrite: true,
      read: () => fileTot.read(),
      write: async () => {}
    }
    const before = read()
    await expect(syncOnce(db, broken, NOW, true)).rejects.toThrow(/stopped writing/)
    expect(getTotSettings(db, true).twoWay).toBe(false)
    expect(read()).toBe(before)
  })
})

describe('writing to the real Tot through a shortcut', () => {
  it('only writes to the dot the shortcut is set to, passing the text as a file', async () => {
    const runs: { name: string; text: string }[] = []
    const tot = new RealTot(
      () => ({ shortcut: 'Engram Tot Write', dot: 1 }),
      async (name, file) => {
        runs.push({ name, text: readFileSync(file, 'utf8') })
      }
    )
    expect(tot.canWrite).toBe(true)
    await tot.write(1, 'UNI:\n○ a')
    expect(runs).toEqual([{ name: 'Engram Tot Write', text: 'UNI:\n○ a' }])
    await expect(tot.write(3, 'UNI:\n○ a')).rejects.toThrow(/dot 3.*writes to dot 1/)
    expect(runs).toHaveLength(1)
  })

  it('is read-only until writing back is turned on', async () => {
    const tot = new RealTot(
      () => null,
      async () => {
        throw new Error('should not run')
      }
    )
    expect(tot.canWrite).toBe(false)
    await expect(tot.write(1, 'x')).rejects.toThrow(/off/)
  })
})
