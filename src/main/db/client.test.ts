import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'

const MIGRATIONS = join(__dirname, '../../../drizzle')

describe('openDatabase', () => {
  it('keeps a copy of an existing database before applying new migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-db-'))
    // An "older version": the same migrations without the last one.
    const old = join(dir, 'old-migrations')
    cpSync(MIGRATIONS, old, { recursive: true })
    const journalPath = join(old, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries.pop()
    writeFileSync(journalPath, JSON.stringify(journal))

    const path = join(dir, 'app.db')
    openDatabase(path, old).close()
    expect(existsSync(`${path}.before-update`)).toBe(false) // a new database: nothing to keep

    openDatabase(path, MIGRATIONS).close()
    expect(existsSync(`${path}.before-update`)).toBe(true)
    const copy = new Database(`${path}.before-update`, { readonly: true })
    const { n } = copy.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
      n: number
    }
    copy.close()
    expect(n).toBe(journal.entries.length)
  })

  it('makes no copy when nothing is pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-db-'))
    const path = join(dir, 'app.db')
    openDatabase(path, MIGRATIONS).close()
    openDatabase(path, MIGRATIONS).close()
    expect(existsSync(`${path}.before-update`)).toBe(false)
  })
})
