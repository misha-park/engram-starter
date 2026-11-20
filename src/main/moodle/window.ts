import { BrowserWindow, session } from 'electron'
import { APP_SCHEME, MOODLE_SITE } from './auth'

// The Moodle sign-in window: Moodle's launch page and the university's sign-in, in a window
// of Engram's own with a temporary session (nothing is kept). The user signs in there; Engram
// only catches the moodlemobile:// link Moodle sends at the end. Pages can't open other
// windows, and links to other sites open nowhere.

const TIMEOUT_MS = 10 * 60_000
let open: BrowserWindow | null = null

export function openMoodleSignIn(url: string, parent?: BrowserWindow | null): Promise<string> {
  if (open && !open.isDestroyed()) {
    open.focus()
    return Promise.reject(new Error('The Moodle sign-in window is already open.'))
  }
  const ses = session.fromPartition(`moodle-signin-${Date.now()}`) // in memory only
  const win = new BrowserWindow({
    width: 520,
    height: 720,
    parent: parent ?? undefined,
    title: 'Sign in to Moodle',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  open = win

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, link?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ses.protocol.unhandle(APP_SCHEME)
      } catch {
        // Already gone.
      }
      if (!win.isDestroyed()) win.close()
      open = null
      if (error) reject(error)
      else resolve(link!)
    }
    const timer = setTimeout(
      () => finish(new Error('The Moodle sign-in took too long. Try again.')),
      TIMEOUT_MS
    )
    const catchLink = (event: { preventDefault(): void }, link: string) => {
      if (link.startsWith(`${APP_SCHEME}://`)) {
        event.preventDefault()
        finish(null, link)
      }
    }

    // However Moodle sends it (a redirect, a script, a link the user clicks), the link to the
    // app scheme ends here.
    ses.protocol.handle(APP_SCHEME, (req) => {
      finish(null, req.url)
      return new Response('Signed in. You can close this window.', {
        headers: { 'content-type': 'text/plain' }
      })
    })
    win.webContents.on('will-navigate', (e) => catchLink(e, e.url))
    win.webContents.on('will-redirect', (e) => catchLink(e, e.url))
    win.webContents.on('will-frame-navigate', (e) => catchLink(e, e.url))
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${APP_SCHEME}://`)) finish(null, url)
      return { action: 'deny' }
    })
    win.on('closed', () => finish(new Error('The Moodle sign-in window was closed.')))
    win.loadURL(url).catch(() => {
      // A navigation to the app scheme aborts the load; that's expected.
    })
  })
}

export { MOODLE_SITE }
