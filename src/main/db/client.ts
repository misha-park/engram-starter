import Database from 'better-sqlite3'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

/** Drizzle over better-sqlite3; `$client` is the raw connection (used by the assistant's change tracking). */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }
/** A database handle or a transaction on it (helpers that run inside transactions accept either). */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface DbHandle {
  db: Db
  close(): void
}

/** Open (or create) a database file, apply pending migrations and return a Drizzle handle. */
export function openDatabase(path: string, migrationsFolder: string): DbHandle {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  // A new version of Engram may bring migrations: keep a copy of the data as it was first
  // (<db>.before-update, replaced each time), in case one goes wrong.
  if (pendingMigrations(sqlite, migrationsFolder) > 0) {
    const copy = `${path}.before-update`
    rmSync(copy, { force: true })
    sqlite.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
  }
  migrate(db, { migrationsFolder })
  return { db, close: () => sqlite.close() }
}

/** How many migrations an existing database hasn't had yet (0 for a new, empty one). */
export function pendingMigrations(sqlite: Database.Database, migrationsFolder: string): number {
  const applied = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get()
  if (!applied) return 0
  const { n } = sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
    n: number
  }
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'))
  return Math.max(0, (journal.entries as unknown[]).length - n)
}
