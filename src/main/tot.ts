import { execFile } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq, inArray, or } from 'drizzle-orm'
import { Temporal } from 'temporal-polyfill'
import { applyEdits, isUniDot, parseDot, planSync, relink, type TotLink } from '../core/tot'
import { toIso } from '../core/time'
import type { TotStatus } from '../shared/types'
import type { Db } from './db/client'
import * as t from './db/schema'
import { getSetting } from './repo'
import { archiveTodo, createTodo, setTodoDone } from './todos'

// Tot sync (Phase 8): plain deterministic code, never the LLM. The rules are in core/tot.ts;
// this file reads and writes the dot and applies the plan to the todos.
//   Real profile: Tot itself, only while it's running (Engram never launches it). Reads use
//   Tot's URL scheme (tot://N/content via osascript). Writes, when the user turns them on, go
//   through a shortcut they make with Tot's "Set Dot" action: the URL scheme's replace/append
//   would switch the dot to plain text (a monospaced font), the Shortcuts action doesn't.
//   Demo: a text file in the profile folder stands in for the dot.

export interface TotSource {
  readonly kind: 'tot' | 'file'
  /** Whether the dot may be edited (real Tot: only with the write shortcut turned on). */
  readonly canWrite: boolean
  /** The UNI dot and its text, or why it can't be read. */
  read(): Promise<{ dot: number; text: string } | { error: string }>
  write(dot: number, text: string): Promise<void>
}

const TOT_ID = 'com.iconfactory.Tot'

function osascript(lines: string[], args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      '/usr/bin/osascript',
      [...lines.flatMap((l) => ['-e', l]), ...args],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr.trim() || error.message, { cause: error }))
          : resolve(stdout)
    )
  )
}

/** osascript prints the result with one trailing newline. */
const stripNewline = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s)

/** Open a tot:// URL in Tot (passed as an argument, so nothing needs quoting). */
const openTot = (url: string) =>
  osascript(
    ['on run argv', `tell application id "${TOT_ID}" to open location (item 1 of argv)`, 'end run'],
    [url]
  ).then(stripNewline)

/** Run a shortcut with a text file as its input (`shortcuts run`). */
export type ShortcutWithInput = (name: string, inputFile: string) => Promise<void>

export const runShortcutWithInput: ShortcutWithInput = (name, inputFile) =>
  new Promise((resolve, reject) =>
    execFile(
      '/usr/bin/shortcuts',
      ['run', name, '-i', inputFile],
      { timeout: 60_000 },
      (error, _out, stderr) =>
        error
          ? reject(
              new Error(
                error.killed
                  ? `The “${name}” shortcut didn’t finish. Open Shortcuts and run it once by hand to answer any permission question.`
                  : stderr.trim() || `The “${name}” shortcut failed.`,
                { cause: error }
              )
            )
          : resolve()
    )
  )

/** The shortcut Engram writes through, and the dot it's set to. */
export interface TotWriter {
  shortcut: string
  dot: number
}

/**
 * Tot itself. Reads through the URL scheme. Writes only through the user's shortcut (see the
 * top of this file), and only to the dot that shortcut is set to.
 */
export class RealTot implements TotSource {
  readonly kind = 'tot' as const
  private dot: number | null = null

  constructor(
    private readonly writer: () => TotWriter | null,
    private readonly run: ShortcutWithInput = runShortcutWithInput
  ) {}

  get canWrite(): boolean {
    return this.writer() !== null
  }

  async running(): Promise<boolean> {
    try {
      return (await osascript([`application id "${TOT_ID}" is running`])).trim() === 'true'
    } catch {
      return false
    }
  }

  async read(): Promise<{ dot: number; text: string } | { error: string }> {
    if (!(await this.running())) return { error: 'Tot isn’t running.' }
    try {
      // The dot it was in last time, then all seven (moving the dot doesn't break anything).
      const order = this.dot ? [this.dot, 1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6, 7]
      for (const dot of new Set(order)) {
        const text = await openTot(`tot://${dot}/content`)
        if (isUniDot(text)) {
          this.dot = dot
          return { dot, text }
        }
      }
      this.dot = null
      return { error: 'No Tot dot starts with “UNI”.' }
    } catch (e) {
      return { error: `Couldn’t read Tot: ${(e as Error).message}` }
    }
  }

  async write(dot: number, text: string): Promise<void> {
    const w = this.writer()
    if (!w) throw new Error('Writing to Tot is off.')
    // The shortcut always writes to its own dot: never let it overwrite a different one.
    if (dot !== w.dot) {
      throw new Error(
        `The UNI list is in dot ${dot}, but the “${w.shortcut}” shortcut writes to dot ${w.dot}. Change the dot in the shortcut and in Settings → Tot.`
      )
    }
    const dir = mkdtempSync(join(tmpdir(), 'engram-tot-'))
    const file = join(dir, 'dot.txt')
    try {
      writeFileSync(file, text)
      await this.run(w.shortcut, file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** The demo's Tot: one text file standing in for the UNI dot. */
export class FileTot implements TotSource {
  readonly kind = 'file' as const
  readonly canWrite = true
  constructor(readonly file: string) {}

  async read(): Promise<{ dot: number; text: string } | { error: string }> {
    if (!existsSync(this.file))
      return { error: 'The demo Tot file is missing. Reset the demo data.' }
    const text = readFileSync(this.file, 'utf8')
    return isUniDot(text)
      ? { dot: 1, text }
      : { error: 'The demo Tot file doesn’t start with “UNI”.' }
  }

  async write(_dot: number, text: string): Promise<void> {
    writeFileSync(this.file, text)
  }
}

const KEY = 'tot'
interface TotSettings {
  enabled: boolean
  /** Item texts at the last sync, to recognise lines renamed in Tot. */
  previous: string[] | null
  lastSyncedAt: string | null
  lastError: string | null
  dot: number | null
  /** Real Tot: write back through the user's shortcut (off until they set it up). */
  twoWay: boolean
  writeShortcut: string
  writeDot: number
}

export const DEFAULT_WRITE_SHORTCUT = 'Engram Tot Write'

export function getTotSettings(db: Db, defaultEnabled: boolean): TotSettings {
  return {
    enabled: defaultEnabled,
    previous: null,
    lastSyncedAt: null,
    lastError: null,
    dot: null,
    twoWay: false,
    writeShortcut: DEFAULT_WRITE_SHORTCUT,
    writeDot: 1,
    ...(getSetting<Partial<TotSettings>>(db, KEY) ?? {})
  }
}

function saveTotSettings(db: Db, patch: Partial<TotSettings>, defaultEnabled: boolean): void {
  const value = { ...getTotSettings(db, defaultEnabled), ...patch }
  db.insert(t.settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
}

export interface SyncResult {
  /** Changes made to the app's todos. */
  appChanges: number
  /** Whether the dot was rewritten. */
  wroteTot: boolean
}

/** One sync: read the dot, plan, apply to the todos, write the dot, save the links. */
export async function syncOnce(
  db: Db,
  source: TotSource,
  now: Temporal.Instant,
  defaultEnabled: boolean
): Promise<SyncResult> {
  const read = await source.read()
  if ('error' in read) throw new Error(read.error)
  const items = parseDot(read.text)
  const links: TotLink[] = db
    .select()
    .from(t.totLinks)
    .all()
    .map((l) => ({ todoId: l.todoId, text: l.text, done: l.done, position: l.position }))
  const linkedIds = links.map((l) => l.todoId)
  const todoRows = db
    .select()
    .from(t.todos)
    .where(
      or(linkedIds.length ? inArray(t.todos.id, linkedIds) : undefined, eq(t.todos.done, false))
    )
    .all()
  const todos = todoRows.map((r) => ({
    id: r.id,
    title: r.title,
    done: r.done,
    archived: r.archived
  }))
  const settings = getTotSettings(db, defaultEnabled)
  const plan = planSync(items, links, todos, settings.previous, { readOnly: !source.canWrite })

  // The app side. Created todos get their link straight away.
  const created: TotLink[] = []
  let appChanges = 0
  for (const c of plan.app.create) {
    const id = createTodo(db, { title: c.text }, 'tot')
    created.push({ todoId: id, text: c.text, done: false, position: c.position })
    appChanges++
  }
  for (const d of plan.app.setDone) {
    setTodoDone(db, d.todoId, d.done, now)
    appChanges++
  }
  for (const r of plan.app.rename) {
    db.update(t.todos).set({ title: r.title }).where(eq(t.todos.id, r.todoId)).run()
    appChanges++
  }
  for (const id of plan.app.archive) {
    archiveTodo(db, id)
    appChanges++
  }

  // The Tot side, applied to the text just read. Read back what Tot actually stored.
  let text = read.text
  const next = applyEdits(read.text, items, plan.tot)
  const wroteTot = next !== read.text
  if (wroteTot) {
    await source.write(read.dot, next)
    const after = await source.read()
    // Check Tot ended up with exactly what was written; if not, stop writing (read-only again).
    if ('error' in after || after.dot !== read.dot || after.text.trimEnd() !== next.trimEnd()) {
      saveTotSettings(db, { twoWay: false }, defaultEnabled)
      throw new Error(
        'Tot didn’t end up with Engram’s changes, so Engram has stopped writing to Tot. Check the shortcut in Settings → Tot.'
      )
    }
    text = after.text
  }

  const finalItems = parseDot(text)
  const appended = plan.appended.map((a) => ({ ...a, done: false }))
  const saved = relink([...plan.links, ...created, ...appended], finalItems)
  db.transaction((tx) => {
    tx.delete(t.totLinks).run()
    for (const l of saved) tx.insert(t.totLinks).values(l).run()
  })
  saveTotSettings(
    db,
    {
      previous: finalItems.map((i) => i.text),
      lastSyncedAt: toIso(now),
      lastError: null,
      dot: read.dot
    },
    defaultEnabled
  )
  return { appChanges, wroteTot }
}

export interface TotSyncDeps {
  db(): Db
  now(): Temporal.Instant
  source(): TotSource
  /** The demo syncs by default; the real profile once it's turned on. */
  defaultEnabled(): boolean
  /** The app's todos changed (refresh the UI). */
  changed(): void
}

const POLL_MS = 20_000
const SOON_MS = 1_500

/** Runs syncs: every 20 s while on, and shortly after the app's todos change. One at a time. */
export class TotSync {
  private running: Promise<void> | null = null
  private queued: Promise<void> | null = null
  private queuedForce = false
  private soonTimer: NodeJS.Timeout | null = null
  private poller: NodeJS.Timeout | null = null

  constructor(private readonly deps: TotSyncDeps) {}

  start(): void {
    this.poller ??= setInterval(() => void this.sync(), POLL_MS)
    void this.sync()
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller)
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.poller = this.soonTimer = null
  }

  /** After a change in the app: sync in a moment (several changes make one sync). */
  soon(): void {
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      void this.sync()
    }, SOON_MS)
  }

  status(): TotStatus {
    const db = this.deps.db()
    const s = getTotSettings(db, this.deps.defaultEnabled())
    return {
      enabled: s.enabled,
      source: this.deps.source().kind,
      lastSyncedAt: s.lastSyncedAt,
      lastError: s.lastError,
      dot: s.dot,
      oneWay: !this.deps.source().canWrite,
      twoWay: s.twoWay,
      writeShortcut: s.writeShortcut,
      writeDot: s.writeDot,
      linked: db.select().from(t.totLinks).all().length
    }
  }

  /** Real Tot: write back through a shortcut (or not). */
  setWriting(input: { twoWay: boolean; writeShortcut: string; writeDot: number }): TotStatus {
    const writeDot = Number(input.writeDot)
    if (!Number.isInteger(writeDot) || writeDot < 1 || writeDot > 7)
      throw new Error('Choose a dot from 1 to 7.')
    saveTotSettings(
      this.deps.db(),
      {
        twoWay: !!input.twoWay,
        writeShortcut: String(input.writeShortcut ?? '').trim() || DEFAULT_WRITE_SHORTCUT,
        writeDot,
        lastError: null
      },
      this.deps.defaultEnabled()
    )
    if (input.twoWay) void this.sync()
    return this.status()
  }

  setEnabled(enabled: boolean): TotStatus {
    saveTotSettings(this.deps.db(), { enabled, lastError: null }, this.deps.defaultEnabled())
    if (enabled) void this.sync()
    return this.status()
  }

  /** Sync now, unless sync is off. Resolves when done; never throws (errors go in the status). */
  sync(force = false): Promise<void> {
    if (this.running) {
      // One more run after the current one (several requests share it).
      this.queuedForce ||= force
      this.queued ??= this.running.then(() => {
        const f = this.queuedForce
        this.queued = null
        this.queuedForce = false
        return this.sync(f)
      })
      return this.queued
    }
    const run = this.runOnce(force)
    this.running = run
    void run.finally(() => {
      if (this.running === run) this.running = null
    })
    return run
  }

  private async runOnce(force: boolean): Promise<void> {
    try {
      const db = this.deps.db()
      if (!force && !getTotSettings(db, this.deps.defaultEnabled()).enabled) return
      const result = await syncOnce(
        db,
        this.deps.source(),
        this.deps.now(),
        this.deps.defaultEnabled()
      )
      if (result.appChanges) this.deps.changed()
    } catch (e) {
      try {
        saveTotSettings(
          this.deps.db(),
          { lastError: (e as Error).message },
          this.deps.defaultEnabled()
        )
      } catch {
        // The profile may be switching; the next sync tries again.
      }
    }
  }
}
