import { copyFileSync, cpSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { count } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { PROFILES, type ProfileInfo, type ProfileName, type SeedSummary } from '../shared/types'
import { openDatabase, type Db, type DbHandle } from './db/client'
import * as t from './db/schema'
import {
  assertDemo,
  ensureProfileDirs,
  profilePaths,
  readActiveProfile,
  writeActiveProfile,
  type ProfilePaths
} from './profile'
import { seedDemo } from './seed'
import { ensureOccurrences } from './calendar'

/**
 * Owns the open database for the active profile. Electron-free so it can be tested directly.
 * The demo profile is seeded automatically the first time it is opened.
 */
export class AppContext {
  private handle: DbHandle | null = null
  private current: ProfilePaths
  private readonly clock: () => Temporal.Instant

  constructor(
    private readonly userDataDir: string,
    private readonly migrationsFolder: string,
    options: {
      /** Override the clock (tests). */
      clock?: () => Temporal.Instant
      /** Open this profile instead of the remembered active one (CLI seed). Doesn't change the active profile. */
      profile?: ProfileName
    } = {}
  ) {
    this.clock = options.clock ?? (() => Temporal.Now.instant())
    this.current = profilePaths(userDataDir, options.profile ?? readActiveProfile(userDataDir))
  }

  get db(): Db {
    if (!this.handle) this.open()
    return this.handle!.db
  }

  get profile(): ProfilePaths {
    return this.current
  }

  info(): ProfileInfo {
    return {
      active: this.current.name,
      dbPath: this.current.dbPath,
      recordsDir: this.current.recordsDir
    }
  }

  now(): Temporal.Instant {
    return this.clock()
  }

  open(): void {
    this.close()
    ensureProfileDirs(this.current)
    this.handle = openDatabase(this.current.dbPath, this.migrationsFolder)
    if (this.current.name === 'demo' && this.isEmpty()) {
      seedDemo(this.handle.db, this.current, this.clock())
    }
    ensureOccurrences(this.handle.db, this.clock())
  }

  close(): void {
    this.handle?.close()
    this.handle = null
  }

  switchProfile(name: ProfileName): ProfileInfo {
    if (!PROFILES.includes(name)) throw new Error(`Unknown profile: ${String(name)}`)
    writeActiveProfile(this.userDataDir, name)
    this.current = profilePaths(this.userDataDir, name)
    this.open()
    return this.info()
  }

  /** Delete the demo database, records, files and fake Tot dot, then regenerate them. Refuses on the real profile. */
  resetDemo(): SeedSummary {
    assertDemo(this.current)
    this.close()
    for (const suffix of ['', '-wal', '-shm']) {
      const file = this.current.dbPath + suffix
      if (existsSync(file)) rmSync(file)
    }
    rmSync(this.current.recordsDir, { recursive: true, force: true })
    rmSync(this.current.filesDir, { recursive: true, force: true })
    rmSync(this.current.totDemoFile, { force: true })
    rmSync(this.current.googleDemoFile, { force: true })
    ensureProfileDirs(this.current)
    this.handle = openDatabase(this.current.dbPath, this.migrationsFolder)
    const summary = seedDemo(this.handle.db, this.current, this.clock())
    summary.blocks += ensureOccurrences(this.handle.db, this.clock())
    return summary
  }

  /**
   * Replace the active profile's database, records and files with a backup's (a folder made
   * by backup.ts), then reopen it. Migrations bring an older backup up to date.
   */
  restoreFrom(dir: string): void {
    if (!existsSync(join(dir, 'app.db'))) throw new Error('That backup has no database.')
    this.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(this.current.dbPath + suffix, { force: true })
    copyFileSync(join(dir, 'app.db'), this.current.dbPath)
    for (const [from, to] of [
      [join(dir, 'records'), this.current.recordsDir],
      [join(dir, 'files'), this.current.filesDir]
    ]) {
      rmSync(to, { recursive: true, force: true })
      if (existsSync(from)) cpSync(from, to, { recursive: true })
    }
    this.open()
  }

  private isEmpty(): boolean {
    const [row] = this.handle!.db.select({ n: count() }).from(t.categories).all()
    return row.n === 0
  }
}
