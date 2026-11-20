import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, shell } from 'electron'
import { parseTimetable } from '../core/ics'
import type { IpcChannel, IpcContract, IpcEvent, IpcEvents } from '../shared/ipc'
import type { Block, ImportSummary, SyncResult } from '../shared/types'
import type { AppContext } from './app-context'
import type { TokenStore } from './assistant/auth'
import { getFocusSettings, listShortcuts, setFocusSettings, type FocusController } from './focus'
import * as changes from './assistant/changes'
import * as convs from './assistant/conversations'
import * as memory from './assistant/memory'
import { latestReview } from './assistant/review'
import { ASSISTANT_MODEL, type Assistant } from './assistant/runner'
import * as assignments from './assignments'
import * as backlog from './backlog'
import * as todos from './todos'
import { removeBlock } from './remove-block'
import { moveToNextWeek } from './move-next-week'
import * as deadlines from './deadlines'
import * as calendar from './calendar'
import * as repo from './repo'
import * as reviews from './reviews'
import * as shutdown from './shutdown'
import * as diss from './dissertation'
import { extractPlan, readProposal } from './assistant/plan'
import { applyBriefPlan, extractBriefPlan, summariseAssignment } from './assistant/brief'
import * as files from './attachments'
import { ReadingPdfs } from './reading-pdfs'
import { statsOverview } from './stats'
import { analyseLectureList, applyLectureSplits } from './lecture-list'
import type { TimetableFeed } from './feed'
import type { LinkedCalendars } from './linked-calendars'
import * as moodleForums from './moodle/forums'
import { callMoodle, NEEDED_FUNCTIONS, type MoodleAuth, type SiteInfo } from './moodle/auth'
import * as setup from './setup'
import * as moodleSync from './moodle/sync'
import * as moodleLectures from './moodle/lectures'
import * as backups from './backup'
import { existsSync, readFileSync, rmSync, statSync } from 'fs'
import { isReadableDocument } from './documents'
import type { ReadingSource } from './zotero'
import type { TotSync } from './tot'
import type { GcalSync } from './google/sync'
import type { GoogleAuth } from './google/auth'
import { todayLocalDate } from '../core/time'
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import * as term from './term'
import { recordPath, targetForBlock } from './records'
import * as sessions from './sessions'
import { buildDemoTimetableIcs } from './seed/demo-timetable'
import { DEMO_TIMETABLE_SOURCE } from './seed'
import * as timetable from './timetable'
import type { Updates } from './updates'

type Handlers = {
  [C in IpcChannel]: (
    ...args: IpcContract[C]['args']
  ) => IpcContract[C]['result'] | Promise<IpcContract[C]['result']>
}

const dataListeners: (() => void)[] = []
/** Called whenever `data:changed` is broadcast (the Google Calendar push listens). */
export function onDataChanged(fn: () => void): void {
  dataListeners.push(fn)
}

export function broadcast<E extends IpcEvent>(event: E, ...args: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(event, ...args)
  if (event === 'data:changed') for (const fn of dataListeners) fn()
}

export interface AssistantServices {
  assistant: Assistant
  tokens: TokenStore
  /** Write this week's review now (Settings → Run now). */
  runReview(): Promise<import('../shared/types').WeeklyReview>
  /** A timer started, stopped or was extended in the app (menu bar, Focus mode). */
  timerChanged(event: 'started' | 'stopped' | 'extended'): void
  focus: FocusController
  /** Where the dissertation reading list comes from (Zotero, or the demo fixture). */
  readingSource(): ReadingSource
  tot: TotSync
  google: GcalSync
  googleAuth: GoogleAuth
  /** The real timetable feed (its link is kept encrypted). */
  feed: TimetableFeed
  /** Linked calendars such as iCloud (links kept encrypted; shown only, never planned around). */
  calendars: LinkedCalendars
  /** Moodle sign-in (its key is kept encrypted). */
  moodle: MoodleAuth
  /** Moodle downloads (the demo uses a stand-in). */
  moodleSync: moodleSync.MoodleSync
  /** Restart to update and Roll back (docs/ORIGINAL-SPEC.md §9). */
  updates: Updates
}

/** Channels that only read: everything else may change the calendar (Google pushes after). */
const READS =
  /:(list\w*|get\w*|status|overview|pending|recent|review|summary|collections|draft|open\w*|reveal|choose)$|^(google|tot|focus|assistant|moodle|conversations):/

/** Channels that can change todos: Tot syncs shortly after them. */
const TODO_CHANGES =
  /^(todos:(create|update|setDone|archive|unarchive)|assistant:(addTodo|undo|reject|accept)|diss:(saveMeeting|removeMeeting)|demo:reset|profile:switch)$/

/** What each recent calendar delete changed, so its Undo can put it back. */
const deletedBlocks = new Map<string, changes.RowChange[]>()
let deleteCount = 0

/** Where each file's latest copy in Downloads went, for "Show in Finder" afterwards. */
const downloaded = new Map<string, string>()
/** A raw macOS clipboard type. */
const osFormat = (uti: string) => `electron application/osclipboard;format="${uti}"`
/**
 * Files whose contents also go on the clipboard, so apps that take data rather than files
 * (GoodNotes, Notes, Keynote…) paste the PDF or picture itself instead of its path.
 */
const CONTENT_TYPES: Record<string, { uti: string; mime: string }> = {
  '.pdf': { uti: 'com.adobe.pdf', mime: 'application/pdf' },
  '.png': { uti: 'public.png', mime: 'image/png' },
  '.jpg': { uti: 'public.jpeg', mime: 'image/jpeg' },
  '.jpeg': { uti: 'public.jpeg', mime: 'image/jpeg' },
  '.gif': { uti: 'com.compuserve.gif', mime: 'image/gif' },
  '.tif': { uti: 'public.tiff', mime: 'image/tiff' },
  '.tiff': { uti: 'public.tiff', mime: 'image/tiff' }
}

export function registerIpc(ctx: AppContext, ai: AssistantServices): void {
  const readingPdfs = new ReadingPdfs(
    () => ai.readingSource(),
    () => join(app.getPath('temp'), 'Engram reading'),
    () => ctx.db
  )
  /** A planned assignment's other blocks shrink to match work added for it by hand. */
  const replanFor = (b: Block): Block => {
    const id =
      b.linkedType === 'assignment-stage' && assignments.assignmentForStage(ctx.db, b.linkedId!)
    if (id) assignments.rescheduleAssignment(ctx.db, id, ctx.now())
    return b
  }
  /** Organise lectures runs in progress, by module (so Stop can cancel them). */
  const organising = new Map<string, AbortController>()

  /** Import the timetable: the real feed (null when it has no link yet), or the demo's fake one. */
  const importTimetableNow = async (): Promise<ImportSummary | null> => {
    if (ctx.profile.name !== 'demo') return ai.feed.importNow()
    const now = ctx.now()
    const parsed = parseTimetable(buildDemoTimetableIcs(now))
    const summary = timetable.importTimetable(ctx.db, parsed.events, now, {
      source: DEMO_TIMETABLE_SOURCE,
      skipped: parsed.skipped.length
    })
    broadcast('data:changed')
    return summary
  }

  const status = async () => ({
    hasToken: ai.tokens.has(),
    canStore: await ai.tokens.canStore(),
    model: ASSISTANT_MODEL,
    busy: ai.assistant.busy
  })
  /**
   * Run a deletion tracked like Claude's changes, so its Undo puts back everything it touched
   * (blocks, stages, re-planned work). Returns its result and the key Undo needs.
   */
  const tracked = <T>(fn: () => T): [T, string] => {
    const tracker = new changes.ChangeTracker(ctx.db)
    const result = tracker.track(fn)
    const undo = `del-${++deleteCount}`
    deletedBlocks.set(undo, tracker.all)
    if (deletedBlocks.size > 20) deletedBlocks.delete(deletedBlocks.keys().next().value!)
    return [result, undo]
  }
  const trackDeletion = (fn: () => void): string => tracked(fn)[1]
  const undoDeletion = (undo: string): void => {
    const rows = deletedBlocks.get(undo)
    if (!rows) throw new Error('That can’t be undone any more.')
    changes.revertChanges(ctx.db, rows)
    deletedBlocks.delete(undo)
  }

  const handlers: Handlers = {
    'profile:get': () => ctx.info(),
    'profile:switch': (name) => {
      const info = ctx.switchProfile(name)
      calendar.clearFittingNotes(ctx.db)
      ai.google.reset()
      // Redraw the menu-bar timer for the other profile (no Focus change).
      ai.timerChanged('extended')
      // Reload so no state from the other profile survives in the renderer.
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reload()
      return info
    },
    'demo:reset': () => {
      ai.google.reset()
      const summary = ctx.resetDemo()
      ai.timerChanged('stopped')
      broadcast('data:changed')
      return summary
    },
    'categories:list': () => repo.listCategories(ctx.db),
    'modules:list': () => repo.listModules(ctx.db),
    'modules:get': (id) => repo.getModuleDetail(ctx.db, id, ctx.now()),
    'modules:update': (id, patch) => timetable.updateModule(ctx.db, id, patch, ctx.now()),
    'modules:create': (input) => timetable.createModule(ctx.db, input, ctx.now()),
    'modules:chooseFolder': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const options = { properties: ['openDirectory' as const], title: 'Choose the module folder' }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'modules:openFolder': async (id) => {
      // A link only: the app never scans module folders.
      const mod = repo.listModules(ctx.db).find((m) => m.id === id)
      if (!mod?.folderPath) throw new Error('No folder set for this module.')
      // Only ever a folder: openPath would run an app or script given as the path.
      if (!statSync(mod.folderPath, { throwIfNoEntry: false })?.isDirectory())
        throw new Error('That folder can’t be found. Choose it again in the module’s settings.')
      const error = await shell.openPath(mod.folderPath)
      if (error) throw new Error(error)
    },
    'assignments:summarise': async (id) => {
      const summary = await summariseAssignment(
        ctx.db,
        ctx.profile.filesDir,
        id,
        (s, p, schema) => ai.assistant.completeJson(s, p, schema),
        ctx.now()
      )
      if (summary === null)
        throw new Error('Add the brief first: drop its file under Files, or use Paste the brief…')
      return summary
    },
    'timetable:hideBlock': (id) => {
      // Recorded like a calendar delete, so Undo (and ⌘Z) puts back exactly what went.
      const [, undo] = tracked(() => timetable.hideTimetableBlock(ctx.db, id, ctx.now()))
      broadcast('data:changed')
      return { undo }
    },
    'timetable:hiddenCount': () => timetable.hiddenTimetableCount(ctx.db),
    'timetable:listHidden': () => timetable.listHiddenTimetable(ctx.db),
    'timetable:restoreHiddenEvent': (uid) => {
      timetable.restoreHiddenEvent(ctx.db, uid, ctx.now())
      broadcast('data:changed')
    },
    'timetable:restoreHidden': () => {
      timetable.restoreHiddenTimetable(ctx.db, ctx.now())
      broadcast('data:changed')
    },
    'lectures:setAttended': (id, attended) => timetable.setAttended(ctx.db, id, !!attended),
    'lectures:split': (id, cuts) => {
      timetable.splitLecture(ctx.db, id, ctx.now(), Array.isArray(cuts) ? cuts : undefined)
      broadcast('data:changed')
    },
    'lectureList:analyse': async (moduleId, attachmentId) => {
      const text = await files.readAttachmentText(ctx.db, ctx.profile.filesDir, attachmentId)
      return analyseLectureList(ctx.db, moduleId, text, (s, p, schema) =>
        ai.assistant.completeJson(s, p, schema)
      )
    },
    'lectureList:apply': (splits, titles) => {
      const n = applyLectureSplits(
        ctx.db,
        Array.isArray(splits) ? splits : [],
        ctx.now(),
        Array.isArray(titles) ? titles : []
      )
      broadcast('data:changed')
      return n
    },
    'lectures:join': (id) => {
      timetable.joinLecture(ctx.db, id, ctx.now())
      broadcast('data:changed')
    },
    'lectures:setFlashcards': (id, done) => timetable.setFlashcards(ctx.db, id, done, ctx.now()),
    'lectures:setNotes': (id, done) => timetable.setNotes(ctx.db, id, done, ctx.now()),
    'lectures:setNoWriteUp': (id, no) => timetable.setNoWriteUp(ctx.db, id, no, ctx.now()),
    'lectures:setKind': (id, kind) => timetable.setLectureKind(ctx.db, id, kind, ctx.now()),
    'lectures:confirmKinds': (moduleId, kind) =>
      timetable.confirmKinds(ctx.db, moduleId, kind, ctx.now()),
    'lectures:ensureWriteUp': (id) => backlog.ensureWriteUp(ctx.db, id, ctx.now()),
    'feedNames:list': () => timetable.listFeedNames(ctx.db),
    'feedNames:assign': (name, moduleId) =>
      timetable.assignFeedName(ctx.db, name, moduleId, ctx.now()),
    'timetable:import': async () => {
      const summary = await importTimetableNow()
      if (!summary) throw new Error('No timetable link yet. Add it in the setup wizard.')
      return summary
    },
    // Sync everything (top bar): each connection that's set up, Google last so it carries
    // what the others changed. A failure in one doesn't stop the rest.
    'sync:all': async () => {
      const results: SyncResult[] = []
      const step = async (name: SyncResult['name'], run: () => Promise<string | null>) => {
        try {
          const detail = await run()
          if (detail !== null) results.push({ name, ok: true, detail })
        } catch (e) {
          results.push({ name, ok: false, detail: e instanceof Error ? e.message : 'Failed.' })
        }
      }
      await step('Timetable', async () => {
        const s = await importTimetableNow()
        return s ? `${s.added} new, ${s.updated} changed, ${s.removed} removed` : null
      })
      await step('Tot', async () => {
        if (!ai.tot.status().enabled) return null
        await ai.tot.sync(true)
        const s = ai.tot.status()
        if (s.lastError) throw new Error(s.lastError)
        return `${s.linked} todos in step`
      })
      await step('Moodle', async () => {
        if (!ai.moodleSync.status().connected) return null
        const s = await ai.moodleSync.syncNow()
        if (s.lastError) throw new Error(s.lastError)
        return 'Files and briefs up to date'
      })
      await step('Google Calendar', async () => {
        const before = await ai.google.status()
        if (!before.enabled || (before.source === 'google' && !before.signedIn)) return null
        await ai.google.sync(true)
        const s = await ai.google.status()
        if (s.lastError) throw new Error(s.lastError)
        return `${s.events} events up to date`
      })
      broadcast('data:changed')
      return results
    },
    'timetable:lastImport': () => timetable.lastImport(ctx.db),
    'feed:status': () => ai.feed.status(),
    'calendars:list': () => ai.calendars.list(),
    'calendars:listEvents': (start, end) => ai.calendars.listEvents(start, end),
    'calendars:add': (url) => ai.calendars.add(url),
    'calendars:update': (id, patch) => ai.calendars.update(id, patch ?? {}),
    'calendars:remove': (id) => ai.calendars.remove(id),
    'calendars:hideEvent': (id, uid) => ai.calendars.hideEvent(id, uid),
    'calendars:restoreEvent': (id, uid) => ai.calendars.restoreEvent(id, uid),
    'calendars:sync': () => ai.calendars.syncNow(),
    'feed:connect': (url) => ai.feed.connect(url),
    'feed:disconnect': () => ai.feed.disconnect(),
    'setup:get': () => setup.getSetupState(ctx.db),
    'setup:setStartDate': (date) => {
      timetable.setStartDate(ctx.db, date, ctx.now())
      broadcast('data:changed')
    },
    'setup:setWeeklyTarget': (minutes) => setup.setWeeklyTarget(ctx.db, minutes),
    'setup:addCommitment': (input) => setup.addCommitment(ctx.db, input, ctx.now()),
    'setup:endCommitment': (id) => setup.endCommitment(ctx.db, id, ctx.now()),
    'setup:complete': () => setup.completeSetup(ctx.db, ctx.now()),
    'moodle:status': () => ai.moodleSync.status(),
    'moodle:listCourses': () => moodleSync.listCourses(ctx.db),
    'moodle:refreshCourses': () => ai.moodleSync.refreshCourses(),
    'moodle:setCourseModule': (courseId, moduleId) =>
      moodleSync.setCourseModule(ctx.db, Number(courseId), moduleId),
    'moodle:syncNow': () => ai.moodleSync.syncNow(),
    'moodle:moduleFiles': (moduleId) => moodleSync.moduleMoodleFiles(ctx.db, moduleId),
    'moodle:dismissBrief': (key) => moodleSync.dismissBrief(ctx.db, key),
    'moodle:dismissForumPost': (postId) => moodleForums.dismissForumPost(ctx.db, Number(postId)),
    'moodle:openForumPost': async (postId) => {
      // Only ever a page on Moodle itself (forums.ts keeps no other links).
      const url = moodleForums.openForumPost(ctx.db, Number(postId))
      if (!url) return false
      await shell.openExternal(url)
      return true
    },
    'lectures:organiseStatus': (moduleId) => moodleLectures.getOrganiseStatus(ctx.db, moduleId),
    'lectures:organise': async (moduleId) => {
      organising.get(moduleId)?.abort()
      const stop = new AbortController()
      organising.set(moduleId, stop)
      try {
        const status = await moodleLectures.organiseModule(
          ctx.db,
          ctx.profile.filesDir,
          moduleId,
          (s, p, schema, signal) => ai.assistant.completeJson(s, p, schema, signal),
          ctx.now(),
          { force: true, signal: stop.signal }
        )
        broadcast('data:changed')
        return status
      } catch (e) {
        // Stopped by the user: nothing changed, and that's not an error.
        if (stop.signal.aborted) return moodleLectures.getOrganiseStatus(ctx.db, moduleId)
        throw e
      } finally {
        if (organising.get(moduleId) === stop) organising.delete(moduleId)
      }
    },
    'lectures:stopOrganise': (moduleId) => organising.get(moduleId)?.abort(),
    'lectures:dismissSplits': (moduleId) =>
      moodleLectures.dismissSplitSuggestions(ctx.db, moduleId),
    'lectures:rename': (id, title) => timetable.renameLecture(ctx.db, id, title),
    'lectures:combine': (id, earlierId) => {
      timetable.combineLectures(ctx.db, id, earlierId, ctx.now())
      broadcast('data:changed')
    },
    'lectures:separate': (id) => {
      timetable.separateLecture(ctx.db, id, ctx.now())
      broadcast('data:changed')
    },
    'lectures:mergeWithPrevious': (id) => {
      const prev = timetable.mergeWithPrevious(ctx.db, id, ctx.now())
      broadcast('data:changed')
      return prev
    },
    'files:setLecture': (attachmentId, lectureId) =>
      moodleSync.setFileLecture(ctx.db, attachmentId, lectureId),
    'moodle:signIn': async () => moodleCheck(ai.moodle, await ai.moodle.signIn()),
    'moodle:check': async () => moodleCheck(ai.moodle, await ai.moodle.siteInfo()),
    'moodle:signOut': () => ai.moodle.signOut(),

    'blocks:listInRange': (start, end) => repo.listBlocksInRange(ctx.db, start, end),
    'blocks:get': (id) => {
      const block = calendar.getBlock(ctx.db, id)
      return block ? repo.withDisplay(ctx.db, [block])[0] : null
    },
    'blocks:move': (id, start, end) => calendar.moveBlock(ctx.db, id, start, end, 'user'),
    'blocks:moveToNextWeek': (id) => moveToNextWeek(ctx.db, id, ctx.now()),
    'blocks:removeOccurrence': (id) => calendar.removeOccurrence(ctx.db, id, 'user'),
    'blocks:setColour': (id, colour) => calendar.setBlockColour(ctx.db, id, colour, 'user'),
    'blocks:create': (input) => replanFor(calendar.createBlock(ctx.db, input, 'user')),
    'blocks:update': (id, input) => replanFor(calendar.updateBlock(ctx.db, id, input, 'user')),
    'blocks:delete': (id) => {
      const [note, undo] = tracked(() => removeBlock(ctx.db, id, ctx.now(), 'user'))
      return { note, undo }
    },
    'blocks:undoDelete': (undo) => {
      undoDeletion(undo)
      broadcast('data:changed')
    },
    'blocks:endSeriesAfter': (id) => calendar.endSeriesAfter(ctx.db, id, 'user'),
    'recurrences:get': (id) => calendar.getRecurrence(ctx.db, id) ?? null,
    'recurrences:update': (id, rule) =>
      calendar.updateRecurrence(ctx.db, id, rule, ctx.now(), 'user'),
    'deadlines:listInRange': (start, end) => repo.listDeadlines(ctx.db, start, end),
    'settings:getAvailability': () => calendar.getAvailability(ctx.db),
    'settings:setAvailability': (av) => calendar.setAvailability(ctx.db, av),
    'timer:get': () => sessions.getRunningTimer(ctx.db),
    'timer:start': (blockId) => {
      const timer = sessions.startTimer(ctx.db, blockId, ctx.now())
      ai.timerChanged('started')
      return timer
    },
    'timer:extend': (minutes) => {
      const timer = sessions.extendTimer(ctx.db, minutes, ctx.now())
      ai.timerChanged('extended')
      return timer
    },
    'timer:stop': () => {
      const id = sessions.stopTimer(ctx.db, ctx.now())
      ai.timerChanged('stopped')
      return id
    },
    'sessions:complete': (id, input, correctedEnd) =>
      sessions.completeSession(ctx.db, ctx.profile.recordsDir, id, input, {
        correctedEnd,
        now: ctx.now()
      }),
    'sessions:checkins': () => sessions.listCheckins(ctx.db),
    'sessions:addManual': (input) =>
      sessions.addManualTime(ctx.db, ctx.profile.recordsDir, input, ctx.now()),
    'blocks:markOutcome': (blockId, input) =>
      sessions.markOutcome(ctx.db, ctx.profile.recordsDir, blockId, input, ctx.now()),
    'blocks:saveDebrief': (blockId, d) =>
      sessions.saveDebrief(ctx.db, ctx.profile.recordsDir, blockId, d, ctx.now()),
    'clipboard:write': (text) => {
      if (typeof text !== 'string' || text.length > 20_000) throw new Error('Nothing to copy.')
      clipboard.writeText(text)
    },
    'records:open': async (blockId) => {
      const block = calendar.getBlock(ctx.db, blockId)
      if (!block) throw new Error('Block not found.')
      const path = recordPath(ctx.db, ctx.profile.recordsDir, targetForBlock(ctx.db, block))
      if (!path) throw new Error('No record yet: one is created when a session is logged.')
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    },
    'assignments:list': () => assignments.listAssignments(ctx.db),
    'assignments:get': (id) => assignments.getAssignment(ctx.db, id),
    'assignments:create': (input) => assignments.createAssignment(ctx.db, input, ctx.now()),
    'assignments:update': (id, patch) => assignments.updateAssignment(ctx.db, id, patch, ctx.now()),
    'assignments:submit': (id, submitted) =>
      assignments.setSubmitted(ctx.db, id, submitted, ctx.now()),
    'assignments:delete': (id) =>
      trackDeletion(() => assignments.deleteAssignment(ctx.db, id, ctx.now())),
    'assignments:undoDelete': (undo) => undoDeletion(undo),
    'assignments:reschedule': (id) => assignments.rescheduleAssignment(ctx.db, id, ctx.now()),
    'assignments:setPlanned': (id, planned) =>
      assignments.setPlanned(ctx.db, id, !!planned, ctx.now()),
    'assignments:setTotal': (id, minutes) =>
      assignments.setTotalEstimate(ctx.db, id, Number(minutes), ctx.now()),
    'stages:add': (id, stage) => assignments.addStage(ctx.db, id, stage, ctx.now()),
    'stages:update': (id, patch) => assignments.updateStage(ctx.db, id, patch, ctx.now()),
    'stages:remove': (id) => trackDeletion(() => assignments.removeStage(ctx.db, id, ctx.now())),
    'stages:move': (id, direction) => assignments.moveStage(ctx.db, id, direction, ctx.now()),
    'stages:addBlock': (id, minutes) => assignments.addStageBlock(ctx.db, id, minutes, ctx.now()),
    'todos:list': () => repo.listTodos(ctx.db, ctx.now()),
    'deadlines:list': () => deadlines.listGeneralDeadlines(ctx.db),
    'deadlines:create': (input) => deadlines.createDeadline(ctx.db, input),
    'deadlines:update': (id, patch) => {
      deadlines.updateDeadline(ctx.db, id, patch)
    },
    'deadlines:setDone': (id, done) => deadlines.setDeadlineDone(ctx.db, id, done, ctx.now()),
    'deadlines:delete': (id) => deadlines.deleteDeadline(ctx.db, id),
    'deadlines:restore': (d) => deadlines.restoreDeadline(ctx.db, d),
    'todos:create': (input) => todos.createTodo(ctx.db, input),
    'todos:update': (id, patch) => todos.updateTodo(ctx.db, id, patch),
    'todos:setDone': (id, done) => {
      todos.setTodoDone(ctx.db, id, done, ctx.now())
    },
    'todos:archive': (id) => todos.archiveTodo(ctx.db, id),
    'todos:unarchive': (id) => todos.unarchiveTodo(ctx.db, id),
    'todos:schedule': (id, opts) => backlog.scheduleTodo(ctx.db, id, opts, ctx.now()),
    'backlog:list': () => backlog.listBacklog(ctx.db, ctx.now()),
    'backlog:schedule': (key, opts) => backlog.scheduleBacklogItem(ctx.db, key, opts, ctx.now()),
    'backlog:dismiss': (key) => backlog.dismissBacklogItem(ctx.db, key, ctx.now()),
    'notifications:list': () => backlog.listNotifications(ctx.db, ctx.now()),
    'summary:today': () => repo.getTodaySummary(ctx.db, ctx.now()),
    'reviews:overview': () => reviews.revisionOverview(ctx.db, ctx.now()),
    'reviews:rate': (id, input) =>
      reviews.rateReview(ctx.db, ctx.profile.recordsDir, id, input, ctx.now()),
    'reviews:reschedule': (id) => reviews.rescheduleReview(ctx.db, id, ctx.now()),
    'shutdown:summary': () => shutdown.shutdownSummary(ctx.db, ctx.now()),
    'shutdown:reschedule': (ids) => shutdown.rescheduleUnfinished(ctx.db, ids, ctx.now()),
    'shutdown:backlog': (ids) =>
      shutdown.sendToBacklog(ctx.db, ctx.profile.recordsDir, ids, ctx.now()),
    'term:status': () => term.termStatus(ctx.db, ctx.now(), ctx.profile.name === 'demo'),
    'term:simulate': (on) => {
      term.setSimulateTermEnded(ctx.db, on, ctx.profile.name === 'demo')
      broadcast('data:changed')
    },
    'diss:overview': () => diss.getOverview(ctx.db, ctx.now()),
    'diss:updateSettings': (patch) => {
      diss.updateSettings(ctx.db, patch)
    },
    'diss:addSection': (title) => diss.addSection(ctx.db, title),
    'diss:updateSection': (id, patch) => diss.updateSection(ctx.db, id, patch),
    'diss:removeSection': (id) => diss.removeSection(ctx.db, id),
    'diss:moveSection': (id, direction) => diss.moveSection(ctx.db, id, direction),
    'diss:addMilestone': (title, due) => diss.addMilestone(ctx.db, title, due),
    'diss:updateMilestone': (id, patch) => diss.updateMilestone(ctx.db, id, patch, ctx.now()),
    'diss:removeMilestone': (id) => diss.removeMilestone(ctx.db, id),
    'diss:updateReading': (id, patch) => diss.updateReading(ctx.db, id, patch),
    'diss:saveMeeting': (input) => diss.saveMeeting(ctx.db, input),
    'diss:removeMeeting': (id) => diss.removeMeeting(ctx.db, id),
    'diss:scheduleSession': (sectionId, minutes) =>
      diss.scheduleSession(ctx.db, sectionId, { minutes }, ctx.now()),
    'zotero:collections': () => ai.readingSource().collections(),
    'zotero:preparePdf': async (id) => (await readingPdfs.prepare(id)) !== null,
    'zotero:startDrag': async (id) => {
      const file = await readingPdfs.prepare(id)
      if (!file) throw new Error('Zotero has no PDF for this paper.')
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return
      win.webContents.startDrag({ file, icon: await app.getFileIcon(file) })
    },
    'zotero:openPdf': async (id) => {
      const file = await readingPdfs.prepare(id)
      if (!file) throw new Error('Zotero has no PDF for this paper.')
      const error = await shell.openPath(file)
      if (error) throw new Error(error)
    },
    'zotero:sync': async () => {
      const key = diss.getSettings(ctx.db).zoteroCollectionKey
      if (!key) throw new Error('Choose a Zotero collection first.')
      const items = await ai.readingSource().items(key)
      return diss.syncReading(ctx.db, items, ctx.now())
    },
    'plan:fromText': (text) =>
      extractPlan(text, todayLocalDate(ctx.now()), (s, p, schema) =>
        ai.assistant.completeJson(s, p, schema)
      ),
    'plan:fromFile': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Choose your project proposal',
        properties: ['openFile' as const],
        filters: [
          {
            name: 'Documents',
            extensions: ['docx', 'doc', 'pdf', 'rtf', 'odt', 'pages', 'txt', 'md']
          }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const path = result.canceled ? null : result.filePaths[0]
      if (!path) return null
      const text = await readProposal(path)
      const draft = await extractPlan(text, todayLocalDate(ctx.now()), (s, p, schema) =>
        ai.assistant.completeJson(s, p, schema)
      )
      return { name: basename(path), draft }
    },
    'plan:fromPath': async (path) => {
      if (!isReadableDocument(String(path))) {
        throw new Error('Drop a Word, PDF or text file, or paste the proposal instead.')
      }
      const [file] = files.addFiles(ctx.db, ctx.profile.filesDir, [path], {
        type: 'dissertation',
        id: files.DISSERTATION_ID
      })
      const text = await files.readAttachmentText(ctx.db, ctx.profile.filesDir, file.id)
      const draft = await extractPlan(text, todayLocalDate(ctx.now()), (s, p, schema) =>
        ai.assistant.completeJson(s, p, schema)
      )
      return { name: file.name, draft }
    },
    'plan:apply': (draft) => {
      const r = diss.applyPlan(ctx.db, draft)
      broadcast('data:changed')
      return r
    },
    'files:addText': (name, text, target) => {
      const added = files.addText(ctx.db, ctx.profile.filesDir, name, text, target ?? null)
      if (target) broadcast('data:changed')
      return added
    },
    'files:add': (paths, target) => {
      if (!Array.isArray(paths) || paths.length > 20)
        throw new Error('Add up to 20 files at a time.')
      const added = files.addFiles(ctx.db, ctx.profile.filesDir, paths, target ?? null)
      if (target) broadcast('data:changed')
      return added
    },
    'files:choose': async (target) => {
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Choose files',
        properties: ['openFile' as const, 'multiSelections' as const]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return null
      const added = files.addFiles(
        ctx.db,
        ctx.profile.filesDir,
        result.filePaths.slice(0, 20),
        target ?? null
      )
      if (target) broadcast('data:changed')
      return added
    },
    'files:list': (target) => files.listAttachments(ctx.db, target),
    'files:listDissertation': () => files.listDissertationFiles(ctx.db),
    'files:get': (ids) => files.getAttachments(ctx.db, Array.isArray(ids) ? ids.slice(0, 50) : []),
    'files:setTarget': (id, target) => {
      const a = files.setTarget(ctx.db, id, target ?? null)
      broadcast('data:changed')
      return a
    },
    'files:rename': (id, name) => {
      files.renameAttachment(ctx.db, id, String(name ?? ''))
      broadcast('data:changed')
    },
    'files:remove': (id) => {
      files.removeAttachment(ctx.db, ctx.profile.filesDir, id)
      broadcast('data:changed')
    },
    'files:open': async (id) => {
      const error = await shell.openPath(
        await files.readyAttachmentPath(ctx.db, ctx.profile.filesDir, id)
      )
      if (error) throw new Error(error)
    },
    'files:reveal': async (id) => {
      shell.showItemInFolder(await files.readyAttachmentPath(ctx.db, ctx.profile.filesDir, id))
    },
    'files:download': async (id) => {
      await files.readyAttachmentPath(ctx.db, ctx.profile.filesDir, id)
      // ENGRAM_DOWNLOADS_DIR keeps automated test runs out of the real Downloads folder.
      const folder = process.env.ENGRAM_DOWNLOADS_DIR || app.getPath('downloads')
      const saved = files.saveCopyTo(ctx.db, ctx.profile.filesDir, id, folder)
      downloaded.set(id, saved)
      return { name: basename(saved) }
    },
    'files:revealDownload': (id) => {
      const saved = downloaded.get(id)
      if (!saved || !existsSync(saved)) throw new Error('That copy is no longer in Downloads.')
      shell.showItemInFolder(saved)
    },
    'files:copy': async (id) => {
      // A copy under the file's own name (Engram's is named by id), kept until the next copy
      // so a later paste still finds it.
      const folder = join(app.getPath('temp'), 'Engram clipboard')
      rmSync(folder, { recursive: true, force: true })
      await files.readyAttachmentPath(ctx.db, ctx.profile.filesDir, id)
      const path = files.saveCopyTo(ctx.db, ctx.profile.filesDir, id, folder)
      // The file itself (Finder, Mail, Messages) and, where we know its type, its contents.
      const item: Record<string, string | Blob> = {
        [osFormat('public.file-url')]: pathToFileURL(path).href
      }
      const content = CONTENT_TYPES[extname(path).toLowerCase()]
      if (content) {
        item[osFormat(content.uti)] = new Blob([readFileSync(path)], { type: content.mime })
      }
      await clipboard.write([new ClipboardItem(item)])
    },
    'files:startDrag': async (id) => {
      // A real file drag (into Finder, GoodNotes, a shelf app…), under the file's own name.
      // Each file has its own folder, never emptied by another drag, so a shelf can keep it.
      const folder = join(app.getPath('temp'), 'Engram drag', id)
      rmSync(folder, { recursive: true, force: true })
      await files.readyAttachmentPath(ctx.db, ctx.profile.filesDir, id)
      const file = files.saveCopyTo(ctx.db, ctx.profile.filesDir, id, folder)
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return
      win.webContents.startDrag({ file, icon: await app.getFileIcon(file) })
    },
    'brief:draft': async (attachmentId) => {
      const text = await files.readAttachmentText(ctx.db, ctx.profile.filesDir, attachmentId)
      const modules = repo
        .listModules(ctx.db)
        .map((m) => ({ id: m.id, label: `${m.shortLabel} · ${m.name}` }))
      return extractBriefPlan(text, todayLocalDate(ctx.now()), modules, (s, p, schema) =>
        ai.assistant.completeJson(s, p, schema)
      )
    },
    'brief:apply': (draft, opts) => {
      const id = applyBriefPlan(ctx.db, draft, opts ?? {}, ctx.now())
      broadcast('data:changed')
      return id
    },
    'stats:overview': (range) =>
      statsOverview(ctx.db, ['week', '4w', '12w', 'all'].includes(range) ? range : '4w', ctx.now()),
    'backup:status': () => backups.backupStatus(ctx),
    'backup:set': (patch) => backups.setBackupSettings(ctx, patch ?? {}),
    'backup:chooseFolder': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Choose where backups go',
        properties: ['openDirectory' as const, 'createDirectory' as const]
      }
      const r = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (r.canceled || !r.filePaths[0]) return null
      return backups.setBackupSettings(ctx, { folder: r.filePaths[0] })
    },
    'backup:now': async () => {
      try {
        await backups.backupNow(ctx, ctx.now())
      } catch (e) {
        throw new Error(`The backup failed: ${(e as Error).message}`, { cause: e })
      }
      return backups.backupStatus(ctx)
    },
    'backup:restore': async (name) => {
      await backups.restoreBackup(ctx, String(name), ctx.now())
      ai.google.reset()
      ai.timerChanged('extended')
      // Reload so nothing from before the restore stays on screen.
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reload()
      return backups.backupStatus(ctx)
    },
    'backup:reveal': async (name) => {
      const s = backups.backupStatus(ctx)
      const path = name ? join(s.profileFolder, String(name)) : s.profileFolder
      if (!existsSync(path)) throw new Error('No backups there yet.')
      if (name) shell.showItemInFolder(path)
      else await shell.openPath(path)
    },
    'update:status': () => ai.updates.status(),
    'update:restart': async (opts) => {
      // A backup first, unless backups are off (app.db.before-update still covers migrations).
      if (!opts?.skipBackup && backups.getBackupSettings(ctx.db).enabled) {
        try {
          await backups.backupNow(ctx, ctx.now())
        } catch (e) {
          return { backupError: (e as Error).message }
        }
      }
      ai.updates.swap('update')
      return null
    },
    'update:rollback': () => ai.updates.swap('rollback'),
    'google:status': () => ai.google.status(),
    'google:setClient': async (idOrJson, secret) => {
      await ai.googleAuth.setClient(String(idOrJson ?? ''), secret ? String(secret) : undefined)
      return ai.google.status()
    },
    'google:signIn': async () => {
      await ai.googleAuth.signIn()
      await ai.google.setEnabled(true)
      return ai.google.status()
    },
    'google:signOut': async () => {
      await ai.googleAuth.signOut()
      return ai.google.status()
    },
    'google:forget': async () => {
      await ai.googleAuth.forget()
      return ai.google.status()
    },
    'google:setEnabled': (enabled) => ai.google.setEnabled(!!enabled),
    'google:syncNow': async () => {
      await ai.google.sync(true)
      return ai.google.status()
    },
    'google:openCalendar': async () => {
      await shell.openExternal('https://calendar.google.com/')
    },
    'tot:status': async () => {
      const status = ai.tot.status()
      if (status.source !== 'tot') return status
      const names = new Set(await listShortcuts())
      return { ...status, shortcutFound: names.has(status.writeShortcut) }
    },
    'tot:setWriting': (input) => ai.tot.setWriting(input),
    'tot:setEnabled': (enabled) => ai.tot.setEnabled(!!enabled),
    'tot:syncNow': async () => {
      await ai.tot.sync(true)
      return ai.tot.status()
    },
    'tot:openDemoFile': async () => {
      if (ctx.profile.name !== 'demo') throw new Error('Only the demo uses a Tot file.')
      const error = await shell.openPath(ctx.profile.totDemoFile)
      if (error) throw new Error(error)
    },
    'focus:get': async () => {
      const settings = getFocusSettings(ctx.db)
      const names = new Set(await listShortcuts())
      return {
        ...settings,
        found: { on: names.has(settings.onShortcut), off: names.has(settings.offShortcut) },
        lastError: ai.focus.lastError
      }
    },
    'focus:set': (input) => {
      setFocusSettings(ctx.db, input)
    },
    'focus:test': (which) => ai.focus.test(which),
    'assistant:status': status,
    'assistant:setToken': async (token) => {
      if (typeof token !== 'string') throw new Error('Paste the token first.')
      await ai.tokens.set(token)
      return status()
    },
    'assistant:clearToken': () => {
      ai.tokens.clear()
      return status()
    },
    'assistant:send': (req) => {
      if (!['chat', 'debrief', 'checkin', 'dissertation'].includes(req?.mode?.kind)) {
        throw new Error('Unknown conversation.')
      }
      return ai.assistant.send(req)
    },
    'assistant:stop': () => ai.assistant.stop(),
    'assistant:forget': (id) => ai.assistant.forget(id),
    'conversations:list': () => convs.listConversations(ctx.db),
    'conversations:get': (id) => convs.getConversation(ctx.db, id),
    'conversations:save': (c) => convs.saveConversation(ctx.db, c, ctx.now()),
    'conversations:setOpen': (id, open) => convs.setConversationOpen(ctx.db, id, open),
    'assistant:pending': () => changes.pendingBatch(ctx.db),
    'assistant:accept': (id) => changes.acceptBatch(ctx.db, id, ctx.now()),
    'assistant:reject': (id) => {
      changes.undoBatch(ctx.db, id, ctx.now(), 'rejected')
      broadcast('data:changed')
    },
    'assistant:undo': (id) => {
      changes.undoBatch(ctx.db, id, ctx.now(), 'undone')
      broadcast('data:changed')
    },
    'assistant:recent': () => changes.recentBatches(ctx.db),
    'assistant:addTodo': (todo) =>
      todos.createTodo(ctx.db, { title: todo.title, dueDate: todo.dueDate }, 'debrief'),
    'assistant:review': () => latestReview(ctx.db),
    'assistant:runReview': () => ai.runReview(),
    'assistant:memories': () => memory.listMemories(ctx.db),
    'assistant:remember': (text) => memory.addMemory(ctx.db, text, ctx.now()),
    'assistant:forgetMemory': (id) => {
      memory.removeMemory(ctx.db, id)
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    const syncAfter = TODO_CHANGES.test(channel)
    const pushAfter = !READS.test(channel)
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      const result = await (handler as (...a: unknown[]) => unknown)(...args)
      if (syncAfter) ai.tot.soon()
      if (pushAfter) ai.google.soon()
      return result
    })
  }
}

/** What Engram can see in Moodle with its key: the site, your courses, missing functions. */
async function moodleCheck(moodle: MoodleAuth, info: SiteInfo) {
  const creds = (await moodle.credentials())!
  const courses = await callMoodle<unknown[]>(creds, 'core_enrol_get_users_courses', {
    userid: info.userid
  })
  return {
    sitename: info.sitename,
    courses: Array.isArray(courses) ? courses.length : 0,
    missing: NEEDED_FUNCTIONS.filter((f) => info.functions.length && !info.functions.includes(f))
  }
}
