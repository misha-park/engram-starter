import { execFile } from 'child_process'
import type { FocusSettings } from '../shared/types'
import type { Db } from './db/client'
import * as t from './db/schema'
import { getSetting } from './repo'

// Focus while a timer runs: turns a macOS Focus mode on when a timer starts and off when it
// stops. macOS has no API for this, so it runs two Shortcuts the user makes once
// ("Engram Focus On"/"Off", each with a "Set Focus" action), via the `shortcuts` command.

const KEY = 'focus'
export const DEFAULT_FOCUS: FocusSettings = {
  enabled: false,
  onShortcut: 'Engram Focus On',
  offShortcut: 'Engram Focus Off'
}

export function getFocusSettings(db: Db): FocusSettings {
  return { ...DEFAULT_FOCUS, ...(getSetting<Partial<FocusSettings>>(db, KEY) ?? {}) }
}

export function setFocusSettings(db: Db, input: FocusSettings): FocusSettings {
  const value: FocusSettings = {
    enabled: !!input.enabled,
    onShortcut: input.onShortcut.trim() || DEFAULT_FOCUS.onShortcut,
    offShortcut: input.offShortcut.trim() || DEFAULT_FOCUS.offShortcut
  }
  db.insert(t.settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
    .run()
  return value
}

/** Runs a shortcut by name. */
export type ShortcutRunner = (name: string) => Promise<void>

export const runShortcut: ShortcutRunner = (name) =>
  new Promise((resolve, reject) =>
    execFile('/usr/bin/shortcuts', ['run', name], { timeout: 15_000 }, (error, _out, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve()
    )
  )

/** The user's shortcut names, to show whether the two Focus shortcuts exist yet. */
export const listShortcuts = (): Promise<string[]> =>
  new Promise((resolve) =>
    execFile('/usr/bin/shortcuts', ['list'], { timeout: 15_000 }, (error, out) =>
      resolve(
        error
          ? []
          : out
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
      )
    )
  )

export class FocusController {
  lastError: string | null = null

  constructor(
    private readonly db: () => Db,
    private readonly run: ShortcutRunner = runShortcut
  ) {}

  /** A timer started (true) or stopped (false). Does nothing unless enabled in Settings. */
  async timer(started: boolean): Promise<void> {
    const settings = getFocusSettings(this.db())
    if (!settings.enabled) return
    await this.runNamed(started ? settings.onShortcut : settings.offShortcut)
  }

  /** Run one of the two shortcuts now (the Test buttons in Settings). */
  async test(which: 'on' | 'off'): Promise<void> {
    const settings = getFocusSettings(this.db())
    await this.runNamed(which === 'on' ? settings.onShortcut : settings.offShortcut, true)
  }

  private async runNamed(name: string, rethrow = false): Promise<void> {
    try {
      await this.run(name)
      this.lastError = null
    } catch (e) {
      this.lastError = `Couldn’t run the shortcut “${name}”: ${e instanceof Error ? e.message : String(e)}`
      console.error(this.lastError)
      if (rethrow) throw new Error(this.lastError, { cause: e })
    }
  }
}
