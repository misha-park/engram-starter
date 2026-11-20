// `npm run release`: test, build and sign Engram, then hand it to the installed app (docs/ORIGINAL-SPEC.md §9).
//
//   1. Refuses when files have uncommitted changes (another chat may be mid-change), unless
//      run as `npm run release -- --dirty`. docs/ORIGINAL-SPEC.md doesn't count.
//   2. `npm test`, then `npm run package` (typecheck, build, electron-builder, signing). If any
//      step fails, nothing is installed.
//   3. Stages the new app in <data folder>/updates/next/ with what's new since the installed build.
//   4. If Engram is open, it shows "Restart to update". If it isn't, the update is installed now.
//
// `npm run release -- --install` installs an update that's already staged (Engram must be closed).
// ENGRAM_APP and ENGRAM_DATA_DIR point it elsewhere (for testing).
import { execFileSync, spawnSync } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { notesFromLog, parseBuildInfo, UPDATE_DIRS, type UpdateNotes } from '../src/core/update'
import { git, ROOT, uncommittedFiles } from './git'

const args = process.argv.slice(2)
const APP = process.env.ENGRAM_APP ?? '/Applications/Engram.app'
const DATA =
  process.env.ENGRAM_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Engram')
const UPDATES = join(DATA, 'updates')
const BUILT = join(ROOT, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Engram.app')
const SWAP = join(ROOT, 'resources', 'update-swap.sh')
const LOCK = join(ROOT, 'dist', '.release.lock')

function fail(message: string): never {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function step(cmd: string, cmdArgs: string[], what: string): void {
  console.log(`\n→ ${what}`)
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) fail(`${what} failed. Nothing was installed.`)
}

function isRunning(): boolean {
  return spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/Engram`]).status === 0
}

/** The installed app's build.json (missing for builds from before updates). */
function installedBuild() {
  const file = join(APP, 'Contents', 'Resources', 'build.json')
  return existsSync(file) ? parseBuildInfo(readFileSync(file, 'utf8')) : null
}

/** Swap the staged app in now (Engram isn't running). */
function installNow(): void {
  const r = spawnSync('/bin/bash', [SWAP, '0', 'update', APP, UPDATES, 'no-open'], {
    stdio: 'inherit'
  })
  if (r.status !== 0) fail('Installing failed (see above). The installed app is unchanged.')
  console.log(`\n✓ Installed in ${APP}. Open Engram to use it.`)
}

/** One release at a time (two chats could run it at once). A lock older than 20 minutes is stale. */
function takeLock(): void {
  mkdirSync(join(ROOT, 'dist'), { recursive: true })
  if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 20 * 60_000) {
    fail('Another release is running. Try again when it has finished.')
  }
  rmSync(LOCK, { force: true })
  closeSync(openSync(LOCK, 'wx'))
  process.on('exit', () => rmSync(LOCK, { force: true }))
}

if (args.includes('--install')) {
  if (!existsSync(join(UPDATES, UPDATE_DIRS.next, 'Engram.app'))) fail('No update is waiting.')
  if (isRunning()) fail('Quit Engram first (⌘Q), then run this again.')
  installNow()
  process.exit(0)
}

takeLock()

const dirty = uncommittedFiles()
if (dirty.length && !args.includes('--dirty')) {
  fail(
    `These files have uncommitted changes:\n${dirty.map((f) => `  ${f}`).join('\n')}\n` +
      'Another chat may be in the middle of a change. Commit them first, or release them as they ' +
      'are with: npm run release -- --dirty'
  )
}

// A longer timeout than the default 5 s: on a busy Mac (other builds running) slow isn't failing.
step('npm', ['test', '--', '--testTimeout=60000'], 'Tests')
step('npm', ['run', 'package'], 'Typecheck, build and sign')

console.log('\n→ Checking the signature')
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', BUILT], { stdio: 'inherit' })
} catch {
  fail('The built app’s signature is invalid. Nothing was installed.')
}

// What's new since the installed build.
const installed = installedBuild()
let notes: UpdateNotes = { changes: [], more: 0 }
if (installed) {
  try {
    notes = notesFromLog(git('log', '--format=%s', `${installed.commit}..HEAD`))
  } catch {
    // The installed commit isn't in this repo's history (e.g. it was rewritten).
  }
}

console.log('\n→ Staging the update')
const partial = join(UPDATES, UPDATE_DIRS.partial)
const next = join(UPDATES, UPDATE_DIRS.next)
rmSync(partial, { recursive: true, force: true })
mkdirSync(partial, { recursive: true })
execFileSync('ditto', [BUILT, join(partial, 'Engram.app')])
writeFileSync(join(partial, 'notes.json'), JSON.stringify(notes, null, 2) + '\n')
rmSync(next, { recursive: true, force: true })
renameSync(partial, next)

if (!isRunning()) {
  installNow()
} else if (installed) {
  console.log('\n✓ Ready. Engram shows “Restart to update”: click it when it suits you.')
} else {
  console.log(
    '\n✓ Staged. The open Engram is from before updates were added, so it can’t restart into ' +
      'this one. Quit it (⌘Q), then run: npm run release -- --install'
  )
}
if (notes.changes.length) {
  console.log(`\nWhat's new:\n${notes.changes.map((c) => `  • ${c}`).join('\n')}`)
  if (notes.more) console.log(`  … and ${notes.more} more`)
}
