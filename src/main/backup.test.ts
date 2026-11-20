import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { eq } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { AppContext } from './app-context'
import {
  backupNow,
  backupStatus,
  defaultBackupFolder,
  listBackups,
  restoreBackup,
  setBackupSettings
} from './backup'
import * as t from './db/schema'

const migrations = resolve(__dirname, '../../drizzle')
const contexts: AppContext[] = []
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

function open() {
  let now = Temporal.Instant.from('2026-11-18T14:30:00Z')
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-bk-')), migrations, {
    clock: () => now
  })
  contexts.push(ctx)
  ctx.open()
  const folder = mkdtempSync(join(tmpdir(), 'engram-backups-'))
  setBackupSettings(ctx, { folder })
  return { ctx, folder, at: (iso: string) => (now = Temporal.Instant.from(iso)) }
}

describe('backups', () => {
  it('copies the database, records and files into a dated folder per profile', async () => {
    const { ctx, folder } = open()
    const name = await backupNow(ctx, ctx.now())
    expect(name).toBe('2026-11-18 1430')
    const dir = join(folder, 'demo', name)
    expect(readdirSync(dir).sort()).toEqual(['app.db', 'backup.json', 'files', 'records'])
    expect(backupStatus(ctx)).toMatchObject({
      lastBackupAt: '2026-11-18T14:30:00Z',
      usingDefault: false
    })
    expect(listBackups(ctx).map((b) => b.name)).toEqual([name])
    // No half-finished folders left behind.
    expect(readdirSync(join(folder, 'demo')).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('restores a backup, after backing up what was there', async () => {
    const { ctx, folder, at } = open()
    const name = await backupNow(ctx, ctx.now())
    const todo = ctx.db.select().from(t.todos).all()[0]
    ctx.db
      .update(t.todos)
      .set({ title: 'Changed after the backup' })
      .where(eq(t.todos.id, todo.id))
      .run()
    at('2026-11-18T15:00:00Z')
    await restoreBackup(ctx, name, ctx.now())
    expect(ctx.db.select().from(t.todos).where(eq(t.todos.id, todo.id)).get()!.title).toBe(
      todo.title
    )
    // The state before the restore was kept as its own backup.
    expect(listBackups(ctx).map((b) => b.name)).toEqual(['2026-11-18 1500', name])
    expect(backupStatus(ctx).folder).toBe(folder)
  })

  it('prunes old backups as new ones are made', async () => {
    const { ctx, folder } = open()
    const dir = join(folder, 'demo')
    mkdirSync(join(dir, '2026-01-05 0900'), { recursive: true })
    writeFileSync(join(dir, '2026-01-05 0900', 'app.db'), '')
    await backupNow(ctx, ctx.now())
    expect(existsSync(join(dir, '2026-01-05 0900'))).toBe(false)
  })

  it('defaults to iCloud Drive when it exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'engram-home-'))
    expect(defaultBackupFolder(home)).toBe(join(home, 'Documents', 'Engram Backups'))
    mkdirSync(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true })
    expect(defaultBackupFolder(home)).toBe(
      join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Engram Backups')
    )
  })
})
