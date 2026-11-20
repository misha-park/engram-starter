import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// The window's size, position and full-screen/maximised state, kept in
// <userData>/window-state.json so the next launch opens it where it was left.

interface WindowState {
  bounds: Rectangle
  maximized: boolean
  fullScreen: boolean
}

const file = (userDataDir: string): string => join(userDataDir, 'window-state.json')

/** The saved bounds, if they're still mostly on a connected screen (displays change). */
export function savedWindowState(userDataDir: string): WindowState | null {
  try {
    const state = JSON.parse(readFileSync(file(userDataDir), 'utf8')) as WindowState
    const b = state.bounds
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null
    const area = screen.getDisplayMatching(b).workArea
    const overlapW = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x)
    const overlapH = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y)
    if (overlapW < 200 || overlapH < 100) return null
    return state
  } catch {
    return null
  }
}

/** Save the window's state whenever it's moved, resized or closed. */
export function keepWindowState(win: BrowserWindow, userDataDir: string): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (win.isDestroyed()) return
    const state: WindowState = {
      // The normal bounds, so un-maximising later goes back to the right size.
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen()
    }
    try {
      writeFileSync(file(userDataDir), JSON.stringify(state))
    } catch (e) {
      console.error('Could not save the window position', e)
    }
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('enter-full-screen', later)
  win.on('leave-full-screen', later)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}
