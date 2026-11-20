// resources/update-swap.sh against fake app bundles in a temp folder (never /Applications).
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(import.meta.dirname, '../../resources/update-swap.sh')

let root: string
let app: string
let updates: string

/** A fake Engram.app whose marker file says which build it is. */
function fakeApp(at: string, name: string): void {
  mkdirSync(join(at, 'Contents'), { recursive: true })
  writeFileSync(join(at, 'Contents', 'which'), name)
}
const which = (at: string) => readFileSync(join(at, 'Contents', 'which'), 'utf8')

function swap(mode: string) {
  return spawnSync('/bin/bash', [SCRIPT, '0', mode, app, updates, 'no-open'], { encoding: 'utf8' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engram-swap-'))
  app = join(root, 'Applications', 'Engram.app')
  updates = join(root, 'data', 'updates')
  fakeApp(app, 'v1')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('update-swap.sh', () => {
  it('puts the staged update in and keeps the old app as the previous one', () => {
    fakeApp(join(updates, 'next', 'Engram.app'), 'v2')
    writeFileSync(join(updates, 'next', 'notes.json'), '{}')
    expect(swap('update').status).toBe(0)
    expect(which(app)).toBe('v2')
    expect(which(join(updates, 'previous', 'Engram.app'))).toBe('v1')
    expect(existsSync(join(updates, 'next'))).toBe(false)
    expect(existsSync(join(updates, 'swap'))).toBe(false)
  })

  it('rolls back, and rolling back again returns to the newer app', () => {
    fakeApp(join(updates, 'next', 'Engram.app'), 'v2')
    swap('update')
    expect(swap('rollback').status).toBe(0)
    expect(which(app)).toBe('v1')
    expect(which(join(updates, 'previous', 'Engram.app'))).toBe('v2')
    swap('rollback')
    expect(which(app)).toBe('v2')
  })

  it('a second update replaces the previous app with the one it replaces', () => {
    fakeApp(join(updates, 'next', 'Engram.app'), 'v2')
    swap('update')
    fakeApp(join(updates, 'next', 'Engram.app'), 'v3')
    swap('update')
    expect(which(app)).toBe('v3')
    expect(which(join(updates, 'previous', 'Engram.app'))).toBe('v2')
  })

  it('installs when there was no app yet', () => {
    rmSync(app, { recursive: true })
    fakeApp(join(updates, 'next', 'Engram.app'), 'v2')
    expect(swap('update').status).toBe(0)
    expect(which(app)).toBe('v2')
    expect(existsSync(join(updates, 'previous'))).toBe(false)
  })

  it('changes nothing when nothing is staged', () => {
    const r = swap('update')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('nothing changed')
    expect(which(app)).toBe('v1')
  })

  it('waits for the app to quit first', () => {
    fakeApp(join(updates, 'next', 'Engram.app'), 'v2')
    // Not our own child (a child that has exited stays a zombie, which still "exists").
    const pid = spawnSync('/bin/bash', ['-c', 'sleep 0.5 >/dev/null 2>&1 & echo $!'], {
      encoding: 'utf8'
    }).stdout.trim()
    const started = Date.now()
    const r = spawnSync('/bin/bash', [SCRIPT, pid, 'update', app, updates, 'no-open'], {
      encoding: 'utf8'
    })
    expect(r.status).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(which(app)).toBe('v2')
  })
})
