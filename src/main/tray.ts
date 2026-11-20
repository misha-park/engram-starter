import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { Temporal } from 'temporal-polyfill'
import { formatClock } from '../core/time'
import { elapsed } from '../core/timer'
import type { Db } from './db/client'
import { extendTimer, getRunningTimer, startableBlock, startTimer, stopTimer } from './sessions'

// The menu-bar timer: a brain icon with the elapsed time while a timer runs. Its menu names the
// running block and can start the
// current or next block, stop it or extend it. Same session logic as the in-app timer.

export interface MenuBarDeps {
  db(): Db
  now(): Temporal.Instant
  resourcesDir: string
  /** A timer started, stopped or was extended from the menu bar. */
  changed(event: 'started' | 'stopped' | 'extended'): void
  openApp(): void
}

const MAX_TITLE = 22

const short = (title: string) =>
  title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title

export class MenuBarTimer {
  private readonly tray: Tray
  private ticker: NodeJS.Timeout | null = null

  constructor(private readonly deps: MenuBarDeps) {
    const icon = nativeImage.createFromPath(join(deps.resourcesDir, 'trayTemplate.png'))
    icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Engram timer')
    this.refresh()
  }

  /** Redraw after any timer change (from here, the app window or a timeout). */
  refresh(): void {
    const running = getRunningTimer(this.deps.db())
    if (running && !this.ticker) {
      this.ticker = setInterval(() => this.updateTitle(), 1000)
    } else if (!running && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    this.updateTitle()
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menu()))
  }

  destroy(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.tray.destroy()
  }

  private updateTitle(): void {
    const running = getRunningTimer(this.deps.db())
    this.tray.setTitle(
      // Just the brain icon, plus the elapsed time while a timer runs (the block is in the menu).
      running ? ` ${elapsed(running.start, this.deps.now())}` : '',
      { fontType: 'monospacedDigit' }
    )
  }

  private act(fn: () => void, event: 'started' | 'stopped' | 'extended') {
    return () => {
      try {
        fn()
        this.deps.changed(event)
      } catch (e) {
        console.error('Menu-bar timer:', e)
      }
      this.refresh()
    }
  }

  private menu(): MenuItemConstructorOptions[] {
    const db = this.deps.db()
    const now = this.deps.now()
    const running = getRunningTimer(db)
    const items: MenuItemConstructorOptions[] = []
    if (running) {
      items.push(
        { label: `${running.title}`, enabled: false },
        {
          label: `Started ${formatClock(running.start)} · planned until ${formatClock(running.plannedEnd)}`,
          enabled: false
        },
        { type: 'separator' },
        {
          label: 'Stop',
          click: this.act(() => {
            stopTimer(db, this.deps.now())
            // The outcome is asked in the app.
            this.deps.openApp()
          }, 'stopped')
        },
        {
          label: 'Extend',
          submenu: [15, 30, 60].map((m) => ({
            label: m === 60 ? '+1 hour' : `+${m} minutes`,
            click: this.act(() => extendTimer(db, m, this.deps.now()), 'extended')
          }))
        }
      )
    } else {
      const next = startableBlock(db, now)
      items.push(
        next
          ? {
              label: next.current
                ? `Start “${short(next.block.title)}”`
                : `Start “${short(next.block.title)}” (planned ${formatClock(next.block.start)})`,
              click: this.act(() => startTimer(db, next.block.id, this.deps.now()), 'started')
            }
          : { label: 'Nothing left to start today', enabled: false }
      )
    }
    items.push({ type: 'separator' }, { label: 'Open Engram', click: () => this.deps.openApp() })
    return items
  }
}
