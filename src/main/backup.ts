import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Temporal } from 'temporal-polyfill'
import { backupName, backupTime, backupsToDelete } from '../core/backup'
import { toIso } from '../core/time'
import type { BackupInfo, BackupStatus } from '../shared/types'
import type { AppContext } from './app-context'
import type { Db } from './db/client'
import * as t from './db/schema'
import { getSetting } from './repo'

// Backups (Phase 9): a daily copy of the active profile's database (SQLite's online backup,
// so it's consistent while the app runs), records and files, by default in iCloud Drive:
//   <folder>/<profile>/<YYYY-MM-DD HHmm>/{app.db, records/, files/, backup.json}
// Old ones are pruned (core/backup.ts). Restoring makes a backup of the current state first.

const KEY = 'backup'
const EVERY_HOURS = 24

interface BackupSettings {
  enabled: boolean
  folder: string | null
  lastBackupAt: string | null
  lastError: string | null
}

/** iCloud Drive when it's set up, otherwise Documents. */
export function defaultBackupFolder(home = homedir()): string {
  const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  return join(existsSync(icloud) ? icloud : join(home, 'Documents'), 'Engram Backups')
}

export function getBackupSettings(db: Db): BackupSettings {
  return {
    enabled: true,
    folder: null,
    lastBackupAt: null,
    lastError: null,
    ...(getSetting<Partial<BackupSettings>>(db, KEY) ?? {})
  }
}

function saveBackupSettings(db: Db, patch: Partial<BackupSettings>): void {
  const value = { ...getBackupSettings(db), ...patch }
  db.insert(t.settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

const folderOf = (ctx: AppContext) =>
  join(getBackupSettings(ctx.db).folder ?? defaultBackupFolder(), ctx.profile.name)

export function listBackups(ctx: AppContext): BackupInfo[] {
  const dir = folderOf(ctx)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => backupTime(name) && existsSync(join(dir, name, 'app.db')))
    .sort()
    .reverse()
    .map((name) => ({
      name,
      at: toIso(backupTime(name)!.toInstant()),
      bytes: statSync(join(dir, name, 'app.db')).size
    }))
}

/** Make a backup now and prune old ones. Returns its name. */
export async function backupNow(
  ctx: AppContext,
  now: Temporal.Instant,
  protect: string[] = []
): Promise<string> {
  const dir = folderOf(ctx)
  const name = backupName(now)
  const final = join(dir, name)
  if (existsSync(join(final, 'app.db'))) return name // Already one this minute.
  const tmp = join(dir, `.${name}.partial`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    await ctx.db.$client.backup(join(tmp, 'app.db'))
    for (const [from, to] of [
      [ctx.profile.recordsDir, 'records'],
      [ctx.profile.filesDir, 'files']
    ]) {
      if (existsSync(from)) cpSync(from, join(tmp, to), { recursive: true })
    }
    writeFileSync(
      join(tmp, 'backup.json'),
      JSON.stringify({ app: 'Engram', profile: ctx.profile.name, at: toIso(now) }, null, 2)
    )
    rmSync(final, { recursive: true, force: true })
    renameSync(tmp, final)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  for (const old of backupsToDelete(readdirSync(dir), now, undefined, protect)) {
    rmSync(join(dir, old), { recursive: true, force: true })
  }
  saveBackupSettings(ctx.db, { lastBackupAt: toIso(now), lastError: null })
  return name
}

/** Replace the current data with a backup, after backing up the current state. */
export async function restoreBackup(
  ctx: AppContext,
  name: string,
  now: Temporal.Instant
): Promise<void> {
  if (!backupTime(name)) throw new Error('Unknown backup.')
  const dir = join(folderOf(ctx), name)
  if (!existsSync(join(dir, 'app.db'))) throw new Error('That backup can’t be found.')
  const folder = getBackupSettings(ctx.db).folder
  // A backup of the current state first (named a minute later if one exists this minute,
  // so the backup being restored is never overwritten).
  const safetyAt = backupName(now) === name ? now.add({ minutes: 1 }) : now
  await backupNow(ctx, safetyAt, [name])
  ctx.restoreFrom(dir)
  // Keep the backup settings from before the restore (the folder may differ in the backup).
  saveBackupSettings(ctx.db, { folder, lastBackupAt: toIso(now), lastError: null })
}

export function backupStatus(ctx: AppContext): BackupStatus {
  const s = getBackupSettings(ctx.db)
  return {
    enabled: s.enabled,
    folder: s.folder ?? defaultBackupFolder(),
    usingDefault: s.folder === null,
    profileFolder: folderOf(ctx),
    lastBackupAt: s.lastBackupAt,
    lastError: s.lastError,
    backups: listBackups(ctx).slice(0, 30)
  }
}

export function setBackupSettings(
  ctx: AppContext,
  patch: { enabled?: boolean; folder?: string | null }
): BackupStatus {
  const values: Partial<BackupSettings> = {}
  if (patch.enabled !== undefined) values.enabled = !!patch.enabled
  if (patch.folder !== undefined) values.folder = patch.folder
  saveBackupSettings(ctx.db, values)
  return backupStatus(ctx)
}

/** Backs up once a day while the app runs (checked hourly, and soon after starting). */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.first = setTimeout(() => void this.check(), 60_000)
    this.timer = setInterval(() => void this.check(), 60 * 60_000)
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
  }

  async check(): Promise<void> {
    if (this.running) return
    const s = getBackupSettings(this.ctx.db)
    if (!s.enabled) return
    const now = this.ctx.now()
    const due =
      !s.lastBackupAt ||
      Temporal.Instant.compare(
        Temporal.Instant.from(s.lastBackupAt).add({ hours: EVERY_HOURS }),
        now
      ) <= 0
    if (!due) return
    this.running = true
    try {
      await backupNow(this.ctx, now)
    } catch (e) {
      try {
        saveBackupSettings(this.ctx.db, { lastError: (e as Error).message })
      } catch {
        // Profile switching; next hour.
      }
    } finally {
      this.running = false
    }
  }
}
