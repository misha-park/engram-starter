// Updates to the installed app (docs/ORIGINAL-SPEC.md §9). `npm run release` stages a new build in
// <userData>/updates/next/; this notices it (checked every 30 s), and on "Restart to update"
// hands over to update-swap.sh, which waits for Engram to quit, swaps the app in /Applications
// and reopens it. The app it replaces is kept in updates/previous/ for Roll back.
// Only the packaged app updates itself; `npm run dev` has nothing to swap.
import { app } from 'electron'
import { spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  bundleOf,
  parseBuildInfo,
  parseNotes,
  sameBuild,
  UPDATE_DIRS,
  type BuildInfo
} from '../core/update'
import type { UpdateStatus } from '../shared/types'

interface Deps {
  userDataDir: string
  /** Where the app's resources/ folder is (update-swap.sh is in it). */
  resourcesDir: string
  /** process.resourcesPath: build.json is packaged there. */
  resourcesPath: string
  exePath: string
  packaged: boolean
  /** The status changed (an update became ready, or went). */
  changed(): void
}

const POLL_MS = 30_000

function readBuild(file: string): BuildInfo | null {
  if (!existsSync(file)) return null
  try {
    return parseBuildInfo(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** An app bundle's build.json. */
const buildOfApp = (appPath: string) =>
  readBuild(join(appPath, 'Contents', 'Resources', 'build.json'))

export class Updates {
  private readonly dir: string
  private readonly bundle: string | null
  private readonly current: BuildInfo | null
  private timer: NodeJS.Timeout | null = null
  private lastKey = ''
  private swapping = false

  constructor(private readonly deps: Deps) {
    this.dir = join(deps.userDataDir, 'updates')
    this.bundle = deps.packaged ? bundleOf(deps.exePath) : null
    this.current = deps.packaged ? readBuild(join(deps.resourcesPath, 'build.json')) : null
  }

  status(): UpdateStatus {
    if (!this.bundle) return { packaged: false, current: null, ready: null, previous: null }
    const nextApp = join(this.dir, UPDATE_DIRS.next, 'Engram.app')
    const nextBuild = existsSync(nextApp) ? buildOfApp(nextApp) : null
    // A staged build that is the running one (installed by hand meanwhile) isn't an update.
    const ready =
      nextBuild && !sameBuild(nextBuild, this.current)
        ? {
            build: nextBuild,
            notes: parseNotes(this.readText(join(this.dir, UPDATE_DIRS.next, 'notes.json')))
          }
        : null
    const previousApp = join(this.dir, UPDATE_DIRS.previous, 'Engram.app')
    return {
      packaged: true,
      current: this.current,
      ready,
      previous: existsSync(previousApp) ? { build: buildOfApp(previousApp) } : null
    }
  }

  start(): void {
    if (!this.bundle) return
    this.lastKey = this.key()
    this.timer = setInterval(() => {
      const key = this.key()
      if (key !== this.lastKey) {
        this.lastKey = key
        this.deps.changed()
      }
    }, POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Quit and let update-swap.sh put the staged update (or, for a rollback, the previous app)
   * in place, then reopen Engram. Callers back up first.
   */
  swap(mode: 'update' | 'rollback'): void {
    if (!this.bundle) throw new Error('Only the installed app can update itself.')
    if (this.swapping) return
    const s = this.status()
    if (mode === 'update' && !s.ready) throw new Error('No update is waiting.')
    if (mode === 'rollback' && !s.previous)
      throw new Error('There’s no previous version to go back to.')
    mkdirSync(this.dir, { recursive: true })
    // Run a copy: the script inside the app bundle is about to be moved.
    const script = join(this.dir, 'update-swap.sh')
    copyFileSync(join(this.deps.resourcesDir, 'update-swap.sh'), script)
    const log = openSync(join(this.dir, 'update.log'), 'a')
    // A copy started with its own data folder (automated runs) reopens with it.
    const dataDir = app.commandLine.getSwitchValue('user-data-dir')
    const reopenArgs = dataDir ? [`--user-data-dir=${dataDir}`] : []
    const child = spawn(
      '/bin/bash',
      [script, String(process.pid), mode, this.bundle, this.dir, 'open', ...reopenArgs],
      { detached: true, stdio: ['ignore', log, log] }
    )
    child.unref()
    this.swapping = true
    // Let the IPC reply reach the window before quitting.
    setTimeout(() => app.quit(), 200)
  }

  /** Changes when an update is staged, replaced or removed. */
  private key(): string {
    const r = this.status().ready
    return r ? `${r.build.commit}@${r.build.builtAt}` : ''
  }

  private readText(file: string): string {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
}
