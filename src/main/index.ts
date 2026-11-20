import { app, BrowserWindow, nativeTheme, Notification, safeStorage, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { AppContext } from './app-context'
import { DEV_DATA_FOLDER, OLD_APP_NAME } from './profile'
import { broadcast, onDataChanged, registerIpc } from './ipc'
import { formatClock } from '../core/time'
import { tickTimer } from './sessions'
import { clearFittingNotes } from './calendar'
import { TokenStore } from './assistant/auth'
import { isReviewDue, writeReview } from './assistant/review'
import { Assistant } from './assistant/runner'
import { FocusController } from './focus'
import { MenuBarTimer } from './tray'
import { setAppMenu } from './menu'
import { keepWindowState, savedWindowState } from './window-state'
import { FixtureZotero, LocalZotero } from './zotero'
import { FileTot, getTotSettings, RealTot, TotSync } from './tot'
import { EncryptedJson } from './secrets'
import { GoogleAuth, type GoogleCredentials } from './google/auth'
import { FileCalendar, GoogleCalendar } from './google/calendar'
import { whitenStoredPdfs } from './attachments'
import { GcalSync } from './google/sync'
import { BackupScheduler } from './backup'
import { TimetableFeed, type FeedSecret } from './feed'
import { LinkedCalendars, type CalendarSecret } from './linked-calendars'
import { MoodleAuth, type MoodleCredentials } from './moodle/auth'
import { openMoodleSignIn } from './moodle/window'
import { FixtureMoodle, RealMoodle } from './moodle/source'
import { MoodleSync } from './moodle/sync'
import { Updates } from './updates'
import type { WeeklyReview } from '../shared/types'

// The assistant (Phase 6) must bill the user's Claude plan, never an API key.
delete process.env.ANTHROPIC_API_KEY

const migrationsFolder = is.dev
  ? join(app.getAppPath(), 'drizzle')
  : join(process.resourcesPath, 'drizzle')

// Packaged, resources/ (tray icons, demo fixtures) and the Agent SDK's native `claude` binary
// are unpacked next to app.asar (asarUnpack): a binary can't run from inside the archive.
const unpackedDir = join(process.resourcesPath, 'app.asar.unpacked')
const resourcesDir = is.dev ? join(app.getAppPath(), 'resources') : join(unpackedDir, 'resources')
const claudeExecutable = is.dev
  ? undefined
  : join(
      unpackedDir,
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      'claude'
    )

let ctx: AppContext
let assistant: Assistant
let tokens: TokenStore
let focus: FocusController
let menuBar: MenuBarTimer | null = null
let tot: TotSync
let google: GcalSync
let backups: BackupScheduler | null = null
let feed: TimetableFeed
let linkedCalendars: LinkedCalendars
let moodleSync: MoodleSync
let updates: Updates

function createWindow(): BrowserWindow {
  const saved = savedWindowState(app.getPath('userData'))
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...saved?.bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    if (saved?.fullScreen) win.setFullScreen(true)
    win.show()
  })
  keepWindowState(win, app.getPath('userData'))

  // External links open in the default browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * The app was renamed from "Study Planner" to "Engram". Move the old data (profiles and the
 * active-profile file) into the new folder once, if the new one doesn't have any yet.
 */
function migrateRenamedDataFolder(): void {
  const oldDir = join(app.getPath('appData'), OLD_APP_NAME)
  const newDir = app.getPath('userData')
  if (!existsSync(join(oldDir, 'profiles')) || existsSync(join(newDir, 'profiles'))) return
  mkdirSync(newDir, { recursive: true })
  renameSync(join(oldDir, 'profiles'), join(newDir, 'profiles'))
  if (existsSync(join(oldDir, 'profile.json'))) {
    renameSync(join(oldDir, 'profile.json'), join(newDir, 'profile.json'))
  }
  console.log(`Moved data from ${oldDir} to ${newDir}`)
}

// `npm run dev` keeps its own data folder ("Engram Dev"), so it never opens the installed app's
// database or runs its syncs and backups a second time (docs/ORIGINAL-SPEC.md §9). An explicit
// --user-data-dir (automated runs) wins. Set before the single-instance lock, which is per folder.
const devDataFolder = is.dev && !app.commandLine.hasSwitch('user-data-dir')
if (devDataFolder) app.setPath('userData', join(app.getPath('appData'), DEV_DATA_FOLDER))

/**
 * Dev starts on the demo profile in its own folder; copy the installed app's Claude sign-in
 * across once so the assistant works there too (same Keychain key, so it decrypts).
 */
function copyClaudeTokenForDev(): void {
  const to = join(app.getPath('userData'), 'secrets', 'claude-token.bin')
  const from = join(app.getPath('appData'), 'Engram', 'secrets', 'claude-token.bin')
  if (existsSync(to) || !existsSync(from)) return
  mkdirSync(join(app.getPath('userData'), 'secrets'), { recursive: true })
  copyFileSync(from, to)
}

// One copy at a time: two would share the database and run every sync and backup twice.
// Opening Engram again brings the running copy forward instead.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
else app.on('second-instance', () => focusWindow())

app.whenReady().then(() => {
  if (!primaryInstance) return
  nativeTheme.themeSource = 'dark'
  setAppMenu({
    dev: is.dev,
    openPage: (path) => {
      // With the window closed, a new one has to load before it can be told.
      if (BrowserWindow.getAllWindows().length === 0) {
        const win = createWindow()
        win.webContents.once('did-finish-load', () => broadcast('app:navigate', path))
        return
      }
      focusWindow()
      broadcast('app:navigate', path)
    }
  })
  if (devDataFolder) copyClaudeTokenForDev()
  else migrateRenamedDataFolder()
  // In development the Dock shows Electron's icon unless we set ours.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(join(app.getAppPath(), 'resources', 'icon.png'))
  }
  ctx = new AppContext(app.getPath('userData'), migrationsFolder)
  ctx.open()
  clearFittingNotes(ctx.db)
  // PDFs stored before this existed get their white background too, quietly, after launch.
  setTimeout(() => void whitenStoredPdfs(ctx.db, ctx.profile.filesDir), 15_000)
  tokens = new TokenStore(app.getPath('userData'), safeStorage)
  assistant = new Assistant({
    db: () => ctx.db,
    recordsDir: () => ctx.profile.recordsDir,
    filesDir: () => ctx.profile.filesDir,
    now: () => ctx.now(),
    token: () => tokens.get(),
    workDir: join(app.getPath('userData'), 'assistant'),
    executable: claudeExecutable,
    emit: (event) => broadcast('assistant:event', event),
    dataChanged: () => {
      broadcast('data:changed')
      tot?.soon()
    }
  })
  focus = new FocusController(() => ctx.db)
  const demoZotero = new FixtureZotero(join(resourcesDir, 'fixtures', 'zotero-demo.json'))
  const localZotero = new LocalZotero()
  // Tot sync: the demo uses a text file in its profile folder; the real profile uses Tot.
  const realTot = new RealTot(() => {
    const s = getTotSettings(ctx.db, false)
    return s.twoWay ? { shortcut: s.writeShortcut, dot: s.writeDot } : null
  })
  tot = new TotSync({
    db: () => ctx.db,
    now: () => ctx.now(),
    source: () => (ctx.profile.name === 'demo' ? new FileTot(ctx.profile.totDemoFile) : realTot),
    defaultEnabled: () => ctx.profile.name === 'demo',
    changed: () => broadcast('data:changed')
  })
  // Google Calendar: the demo pushes to a file; the real profile to Google once signed in.
  const googleAuth = new GoogleAuth({
    store: new EncryptedJson<GoogleCredentials>(app.getPath('userData'), 'google', safeStorage),
    openExternal: (url) => shell.openExternal(url)
  })
  const realCalendar = new GoogleCalendar(() => googleAuth.accessToken())
  google = new GcalSync({
    db: () => ctx.db,
    now: () => ctx.now(),
    kind: () => (ctx.profile.name === 'demo' ? 'file' : 'google'),
    defaultEnabled: () => ctx.profile.name === 'demo',
    target: async () => {
      if (ctx.profile.name === 'demo') return new FileCalendar(ctx.profile.googleDemoFile)
      return (await googleAuth.state()).signedIn ? realCalendar : null
    },
    account: () => googleAuth.state(),
    eventsInDemo: () => new FileCalendar(ctx.profile.googleDemoFile).count()
  })
  // The real timetable feed; its link is kept encrypted (the demo imports a fake feed).
  feed = new TimetableFeed({
    store: new EncryptedJson<FeedSecret>(app.getPath('userData'), 'timetable', safeStorage),
    db: () => ctx.db,
    now: () => ctx.now(),
    isReal: () => ctx.profile.name === 'real',
    changed: () => {
      broadcast('data:changed')
      google.soon()
    }
  })
  // Linked calendars (iCloud…): shown on the calendar only; their links are kept encrypted.
  linkedCalendars = new LinkedCalendars({
    store: new EncryptedJson<CalendarSecret>(app.getPath('userData'), 'calendars', safeStorage),
    db: () => ctx.db,
    now: () => ctx.now(),
    isReal: () => ctx.profile.name === 'real',
    changed: () => broadcast('data:changed')
  })
  // Moodle: signed in through Moodle's own launch page in a window of Engram's (key encrypted).
  const moodle = new MoodleAuth({
    store: new EncryptedJson<MoodleCredentials>(app.getPath('userData'), 'moodle', safeStorage),
    openSignInWindow: (url) => openMoodleSignIn(url, BrowserWindow.getAllWindows()[0])
  })
  // Moodle downloads: UCL Moodle once connected; the demo uses a stand-in.
  const realMoodle = new RealMoodle(moodle)
  const demoMoodle = new FixtureMoodle(join(resourcesDir, 'fixtures'), () => ctx.now())
  moodleSync = new MoodleSync({
    db: () => ctx.db,
    now: () => ctx.now(),
    filesDir: () => ctx.profile.filesDir,
    source: () =>
      ctx.profile.name === 'demo' ? demoMoodle : moodle.connected() ? realMoodle : null,
    demo: () => ctx.profile.name === 'demo',
    changed: () => broadcast('data:changed'),
    completeJson: () =>
      tokens.has()
        ? (system, prompt, schema) => assistant.completeJson(system, prompt, schema)
        : null
  })
  updates = new Updates({
    userDataDir: app.getPath('userData'),
    resourcesDir,
    resourcesPath: process.resourcesPath,
    exePath: app.getPath('exe'),
    packaged: app.isPackaged,
    changed: () => broadcast('update:changed')
  })
  onDataChanged(() => google.soon())
  registerIpc(ctx, {
    assistant,
    tokens,
    runReview,
    timerChanged,
    focus,
    // The demo reads a fixture; the real profile reads Zotero itself.
    readingSource: () => (ctx.profile.name === 'demo' ? demoZotero : localZotero),
    tot,
    google,
    googleAuth,
    feed,
    calendars: linkedCalendars,
    moodle,
    moodleSync,
    updates
  })
  createWindow()
  menuBar = new MenuBarTimer({
    db: () => ctx.db,
    now: () => ctx.now(),
    resourcesDir,
    changed: (event) => {
      if (event !== 'extended') void focus.timer(event === 'started')
      broadcast('data:changed')
    },
    openApp: focusWindow
  })
  startTimerTicker()
  tot.start()
  google.start()
  feed.start()
  linkedCalendars.start()
  moodleSync.start()
  backups = new BackupScheduler(ctx)
  // Dev's data is for trying changes: no daily backups into the installed app's iCloud folder.
  if (!devDataFolder) backups.start()
  updates.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** Checks the running timer every 15 s: "still working?" prompt, then timeout. */
function startTimerTicker(): void {
  const tick = () => {
    try {
      const result = tickTimer(ctx.db, ctx.now())
      if (result.prompt) {
        menuBar?.refresh()
        broadcast('timer:prompt')
        notifyStillWorking(result.prompt.title, result.prompt.plannedEnd)
      }
      if (result.timedOut) {
        timerChanged('stopped')
        broadcast('data:changed')
      }
      if (tokens.has() && !reviewRunning && isReviewDue(ctx.db, ctx.now())) {
        runReview().then(notifyReview, (e) => console.error('Weekly review failed', e))
      }
    } catch (e) {
      console.error('Timer tick failed', e)
    }
  }
  tick()
  setInterval(tick, 15_000)
}

/** Keep the menu bar and Focus mode in step with the timer, wherever it was changed. */
function timerChanged(event: 'started' | 'stopped' | 'extended'): void {
  menuBar?.refresh()
  if (event !== 'extended') void focus.timer(event === 'started')
}

/** The Sunday review: written by Claude from the week's numbers, then shown as a notification. */
let reviewRunning = false
async function runReview(): Promise<WeeklyReview> {
  if (reviewRunning) throw new Error('The review is already being written.')
  reviewRunning = true
  try {
    const review = await writeReview(ctx.db, ctx.now(), (system, prompt) =>
      assistant.complete(system, prompt)
    )
    broadcast('data:changed')
    return review
  } finally {
    reviewRunning = false
  }
}

let reviewNotification: Notification | null = null
function notifyReview(review: WeeklyReview): void {
  if (!Notification.isSupported()) return
  reviewNotification = new Notification({
    title: 'Your week in Engram',
    body: review.text.length > 220 ? `${review.text.slice(0, 219)}…` : review.text
  })
  reviewNotification.on('click', () => {
    focusWindow()
    broadcast('assistant:open', 'review')
  })
  reviewNotification.show()
}

function focusWindow(): void {
  const win = BrowserWindow.getAllWindows()[0] ?? null
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * A macOS notification for the "still working?" question, so it's seen even when Engram
 * isn't in front. The answer itself is given in the app (clicking brings it forward).
 */
let stillWorkingNotification: Notification | null = null
function notifyStillWorking(title: string, plannedEnd: string): void {
  if (!Notification.isSupported()) return
  stillWorkingNotification = new Notification({
    title: 'Still working?',
    body: `${title} was planned until ${formatClock(plannedEnd)}. Open Engram to keep the timer going, or it stops in 10 minutes.`
  })
  stillWorkingNotification.on('click', focusWindow)
  stillWorkingNotification.show()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  assistant?.stop()
  tot?.stop()
  google?.stop()
  backups?.stop()
  updates?.stop()
  menuBar?.destroy()
  ctx?.close()
})
