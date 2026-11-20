// Domain types shared by main, preload and renderer.
// The Drizzle schema (src/main/db/schema.ts) uses the same enum arrays, so rows
// selected from the DB are assignable to these interfaces.

import type { SessionKind } from '../core/session-kinds'
import type { BuildInfo, UpdateNotes } from '../core/update'

export const PROFILES = ['demo', 'real'] as const
export type ProfileName = (typeof PROFILES)[number]

/** `calendar`: a linked calendar (iCloud…): its events are only shown, never planned around. */
export const CATEGORY_KINDS = ['module', 'social', 'work', 'calendar'] as const
export type CategoryKind = (typeof CATEGORY_KINDS)[number]

export const BLOCK_KINDS = ['fixed', 'flexible'] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

export const BLOCK_TYPES = [
  'lecture',
  'practical',
  'workshop',
  'pbl',
  'presentation',
  'assessment',
  'viva',
  'write-up',
  'assignment-stage',
  'dissertation',
  'meeting',
  'pub-shift',
  'social',
  'review',
  'other'
] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

/** Block types that are timetabled teaching (they don't count towards self-study time). */
export const TEACHING_TYPES: readonly BlockType[] = [
  'lecture',
  'practical',
  'workshop',
  'pbl',
  'presentation',
  'assessment',
  'viva'
]

export const BLOCK_SOURCES = ['timetable', 'user', 'auto', 'claude'] as const
export type BlockSource = (typeof BLOCK_SOURCES)[number]

export const OUTCOMES = ['none', 'done', 'partial', 'skipped'] as const
export type Outcome = (typeof OUTCOMES)[number]

/** What a block, session or todo can be linked to. Tables for most of these arrive in later phases. */
export const LINKED_TYPES = [
  'lecture',
  'assignment-stage',
  'dissertation-section',
  'todo',
  'module',
  'deadline'
] as const
export type LinkedType = (typeof LINKED_TYPES)[number]

/** What a file can be attached to (Phase 8). */
export const ATTACHMENT_TARGETS = [
  'assignment',
  'module',
  'dissertation',
  'dissertation-section',
  'meeting'
] as const
export type AttachmentTarget = (typeof ATTACHMENT_TARGETS)[number]
export interface AttachmentRef {
  type: AttachmentTarget
  id: string
}

/** A file Engram keeps a copy of (Phase 8). */
export interface Attachment {
  id: string
  /** The file's name as shown (the original name unless renamed). */
  name: string
  mime: string
  size: number
  /** What it's attached to; null while unfiled (dropped in a chat, not placed yet). */
  target: AttachmentRef | null
  targetLabel: string | null
  addedBy: 'user' | 'claude'
  createdAt: string
  /** Whether text can be read from it (Word, PDF, RTF, Pages, text). */
  readable: boolean
}

export const TODO_SOURCES = ['tot', 'app', 'debrief', 'meeting'] as const
export type TodoSource = (typeof TODO_SOURCES)[number]

export interface Category {
  id: string
  kind: CategoryKind
  name: string
  shortLabel: string
  /** Base colour as hex; the UI derives muted fills and lighter text from it. */
  colour: string
  sortOrder: number
}

export interface Module {
  id: string
  categoryId: string
  /** Minutes of write-up per hour of lecture. */
  writeUpMinutes: number
  folderPath: string | null
  assessmentNotes: string | null
  /** Claude names the lectures and tags their slides (Organise lectures). */
  autoOrganise: boolean
  /** Notifications for important posts in the module's Moodle forums. */
  forumNotifications: boolean
  /**
   * The timetable's [Practical] and [Workshop] events are listed with the lectures, with
   * write-ups (null: not asked yet).
   */
  timetabledSessions: boolean | null
}

export interface ModuleWithDetails extends Module {
  name: string
  shortLabel: string
  colour: string
  /** Names the module has in the timetable feed (cross-listed modules have several). */
  feedNames: string[]
}

export interface Block {
  id: string
  kind: BlockKind
  type: BlockType
  title: string
  /** UTC ISO instant, e.g. 2026-11-17T10:00:00Z */
  start: string
  end: string
  categoryId: string | null
  linkedType: LinkedType | null
  linkedId: string | null
  source: BlockSource
  outcome: Outcome
  recurrenceId: string | null
  /** For recurring blocks: the local date (YYYY-MM-DD) of the occurrence. */
  occurrenceDate: string | null
  debriefPending: boolean
  /** Edited by hand; automatic regeneration (series edits, timetable re-imports) skips it. */
  detached: boolean
  /** Why this block needs attention (e.g. placed outside availability), or null. */
  attention: string | null
  notes: string | null
  backlogResolvedAt?: string | null
  /** Its own colour (blocks that aren't module work); null = the category's colour. */
  colour: string | null
  /** The lecture this block is (or is the write-up of), if any. */
  lecture?: { id: string; moduleId: string; title: string | null }
  /** The calendar bubble's top line (e.g. the module's name) and the lighter line below it. */
  heading?: string
  detail?: string | null
}

/** A block the user adds from the calendar (New event, or dragging over empty time). */
export interface BlockLink {
  type: 'module' | 'assignment' | 'assignment-stage' | 'deadline'
  id: string
}

export interface NewBlockInput {
  title: string
  /** UTC ISO instants. */
  start: string
  end: string
  /** Fixed: never moved by Engram (appointments, plans). Flexible: study time it can move. */
  kind: BlockKind
  /** A module's id, for its colour and stats; or null. `link` takes over when given. */
  moduleId: string | null
  /** What it's for (the New event dialog's For): a module, an assignment (its next stage not
   *  done), a particular stage, or a general deadline. */
  link?: BlockLink | null
  notes?: string | null
  /** Repeat every week on these days (ISO weekdays, 1 = Monday), until a date or for good. */
  repeat?: { byWeekday: number[]; until: string | null } | null
}

// --- Backlog, todos, notifications ---------------------------------------------------------

export type BacklogKind =
  | 'unmarked'
  | 'partial'
  | 'skipped'
  | 'unscheduled-write-up'
  | 'overdue-assignment'
  | 'overdue-todo'

/** Something that slipped and needs scheduling (or a decision). */
export interface BacklogItem {
  /** Stable key: `${kind}:${refId}` */
  key: string
  kind: BacklogKind
  title: string
  /** One line of context, e.g. "Planned Tue 17 Nov, 15:00–16:15". */
  detail: string
  categoryId: string | null
  colour: string | null
  /** When it was planned or due (UTC ISO). */
  at: string
  /** Suggested length when scheduling; null if it can't be scheduled directly. */
  minutes: number | null
  blockId?: string
  lectureId?: string
  assignmentId?: string
  todoId?: string
}

export interface NotificationItem {
  key: string
  kind: 'debrief' | 'checkin' | 'overdue-todo' | 'moodle-brief' | 'moodle-forum'
  title: string
  detail: string
  at: string
  blockId?: string
  todoId?: string
  /** moodle-brief: the brief's file, to plan an assignment from. */
  attachmentId?: string
  /** moodle-forum: the post (opened on Moodle). */
  postId?: number
}

export interface TodoInput {
  title: string
  dueDate?: string | null
  link?: { type: 'module' | 'lecture'; id: string } | null
  recurrence?: Todo['recurrence']
}

export type LectureStatus = 'scheduled' | 'attended' | 'missed' | 'written-up'

export interface Lecture {
  id: string
  moduleId: string
  /** Its block on the calendar. */
  blockId: string
  number: number
  title: string
  start: string
  end: string
  status: LectureStatus
  /** Flashcards made for this lecture. */
  flashcards: boolean
  /** The user's notes made for this lecture. */
  notes: boolean
  writeUp: Pick<Block, 'id' | 'start' | 'end' | 'outcome' | 'attention'> | null
  /** The latest review rating (spaced repetition), for the confidence heatmap. */
  confidence: ReviewRating | null
  /** UCL teaching week (week 1 = the week of 1 September), to find that week's Moodle files. */
  week: number
  /** The lecture's name (from Claude, a lecture list or the user; null = none yet). */
  topic: string | null
  /** The user named it: Claude leaves it alone. */
  topicLocked: boolean
  /** One lecture across several sessions: which part this session is, of how many (else null). */
  part: { index: number; of: number; firstId: string; totalMinutes: number } | null
  /** One part of a timetable event that was split into several lectures (it can be joined). */
  splitPart: boolean
  /** Long enough to split into two lectures (over an hour), and not split already. */
  canSplit: boolean
  /** Before the start date: no write-up is planned for it on purpose (it waits in the Backlog). */
  beforeStart: boolean
  /** You deleted its write-up: none is planned (Plan a write-up brings one back). */
  noWriteUp: boolean
  /** What the session is: the user's choice, or else guessed from its name. */
  kind: SessionKind
  /** The user confirmed or chose the kind (or the timetable said so); else it's a guess. */
  kindConfirmed: boolean
  /** "L3", "WS1", "P2", numbered per kind; "" for an other session. */
  label: string
}

export interface ModuleDetail extends ModuleWithDetails {
  lectures: Lecture[]
  /** Lectures that have happened (attended or written up), leaving out those with no write-up. */
  lecturesSoFar: number
  writtenUp: number
  /** The timetable's [Practical] and [Workshop] events for this module (listed or not). */
  timetabledSessionCount: number
  /** The module's [Assessment] events in the timetable (exams, in-class tests), by time. */
  assessments: { blockId: string; start: string; end: string }[]
}

/** A name from the timetable feed and the module it maps to (null = not mapped yet). */
export interface FeedName {
  name: string
  moduleId: string | null
  events: number
  /** Every event under this name is a hidden [None] event, so mapping it doesn't matter. */
  hiddenOnly: boolean
}

export interface ImportSummary {
  at: string
  source: string
  events: number
  added: number
  updated: number
  removed: number
  hidden: number
  skipped: number
  lectures: number
  writeUpsPlaced: number
  /** Write-ups that had to go outside availability, or couldn't be placed at all. */
  writeUpsNeedingAttention: number
  unmappedNames: string[]
}

export interface ModuleUpdate {
  name?: string
  shortLabel?: string
  colour?: string
  writeUpMinutes?: number
  folderPath?: string | null
  assessmentNotes?: string | null
  autoOrganise?: boolean
  forumNotifications?: boolean
  timetabledSessions?: boolean
}

export interface Recurrence {
  id: string
  title: string
  kind: BlockKind
  type: BlockType
  categoryId: string | null
  rule: RecurrenceRule
  /** Local date YYYY-MM-DD */
  startsOn: string
  until: string | null
  exdates: string[]
  colour: string | null
}

/** A deadline shown in the all-day strip and as a dot on the mini month. */
export interface Deadline {
  id: string
  title: string
  /** UTC ISO instant of the deadline (or the assessment's start). */
  at: string
  categoryId: string | null
  /** `todo`: an open todo with a due date (due at the end of its day). */
  kind: 'assessment' | 'viva' | 'assignment' | 'dissertation' | 'deadline' | 'todo'
}

/** A deadline of any kind that isn't an assignment (Assignments page → Deadlines). */
export interface GeneralDeadline {
  id: string
  title: string
  /** UTC ISO instant. */
  due: string
  moduleId: string | null
  /** The module's name and colour, when it belongs to one. */
  moduleName: string | null
  colour: string | null
  notes: string | null
  doneAt: string | null
}

export interface DeadlineInput {
  title: string
  /** UTC ISO instant. */
  due: string
  moduleId?: string | null
  notes?: string | null
}

// --- Assignments ---------------------------------------------------------------------------

export const ASSIGNMENT_TYPES = [
  'essay',
  'lab-report',
  'problem-set',
  'presentation',
  'other'
] as const
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number]
export type AssignmentStatus = 'not-started' | 'in-progress' | 'submitted'

export interface AssignmentSummary {
  id: string
  moduleId: string
  moduleLabel: string
  colour: string
  title: string
  /** UTC ISO instant */
  due: string
  type: AssignmentType
  weighting: number | null
  isGroup: boolean
  status: AssignmentStatus
  stagesDone: number
  stagesTotal: number
  loggedMinutes: number
  estimateMinutes: number
  /** Work that couldn't be fitted before the deadline at the last (re)schedule. */
  unplacedMinutes: number
  /** Its work is on the calendar (off: planned later, nothing placed). */
  planned: boolean
  /** The mark it got (a percentage), once it's back. */
  mark: number | null
}

export interface StageDetail {
  id: string
  position: number
  name: string
  estimateMinutes: number
  done: boolean
  loggedMinutes: number
  /** Planned blocks for this stage (past and future). */
  blocks: Pick<Block, 'id' | 'start' | 'end' | 'outcome' | 'attention'>[]
}

export interface AssignmentDetail extends AssignmentSummary {
  wordLimit: number | null
  briefLink: string | null
  notes: string | null
  /** What the assignment asks for, from its brief (Claude's summary, editable). */
  summary: string | null
  /** Its work is on the calendar (off until the user plans it). */
  planned: boolean
  submittedAt: string | null
  /** Feedback on it (the user's own copy). */
  feedback: string | null
  stages: StageDetail[]
}

export interface AssignmentInput {
  moduleId: string
  title: string
  due: string
  type: AssignmentType
  weighting?: number | null
  wordLimit?: number | null
  briefLink?: string | null
  isGroup?: boolean
  notes?: string | null
  summary?: string | null
  /** Put its work on the calendar now (default); false leaves it unplanned for later. */
  planned?: boolean
  /** Total estimate; split into the type's default stages (editable afterwards). */
  estimateMinutes: number
  /** Stages to use instead of the type's defaults (e.g. planned from the brief). */
  stages?: { name: string; estimateMinutes: number }[]
}

export type AssignmentUpdate = Partial<
  Omit<AssignmentInput, 'estimateMinutes' | 'moduleId' | 'stages'> & {
    mark: number | null
    feedback: string | null
  }
>

export interface Session {
  id: string
  blockId: string | null
  start: string
  end: string | null
  minutes: number
  manual: boolean
  linkedType: LinkedType | null
  linkedId: string | null
  outcome: Outcome | null
  debrief: string | null
  note: string | null
  /** A timer that ran out with no response; the user needs to confirm the end time. */
  checkinPending: boolean
  plannedEnd: string | null
  promptedAt: string | null
}

/** The timer that is running now (a session with no end yet). */
export interface RunningTimer {
  sessionId: string
  blockId: string
  title: string
  colour: string | null
  start: string
  /** When the "still working?" prompt is due. */
  plannedEnd: string
  /** Set once the prompt has been shown. */
  promptedAt: string | null
}

/** What the user says about a finished piece of work. */
export interface OutcomeInput {
  outcome: Exclude<Outcome, 'none'>
  /** Done: optional one-line note. */
  note?: string
  /** Partial: a short debrief (where you got to, what's left), e.g. summarised by Claude. */
  debrief?: string
}

/** A session that needs the user: a timed-out timer to check in on, or a stopped one without an outcome. */
export interface CheckinItem {
  sessionId: string
  kind: 'timed-out' | 'needs-outcome'
  blockId: string
  title: string
  /** The block's calendar (module) name, for context. */
  categoryName: string | null
  start: string
  /** Where the timer stopped (for timed-out: the planned end it ran to). */
  end: string
}

export interface ManualTimeInput {
  /** UTC ISO start */
  start: string
  minutes: number
  /** Optionally tag the time to a module or lecture so it lands in that record. */
  link: { type: 'module' | 'lecture'; id: string } | null
  note?: string
}

export interface RecurrenceRule {
  freq: 'weekly'
  /** ISO weekday numbers, 1 = Monday … 7 = Sunday */
  byWeekday: number[]
  /** Local wall-clock time HH:MM */
  startTime: string
  /** Local wall-clock time HH:MM; an end at or before the start means the next day (e.g. 17:00–00:00). */
  endTime: string
}

export interface Todo {
  id: string
  title: string
  done: boolean
  archived: boolean
  /** Local date YYYY-MM-DD */
  dueDate: string | null
  linkedType: LinkedType | null
  linkedId: string | null
  /** e.g. { freq: 'weekly', byWeekday: [1] } */
  recurrence: { freq: 'daily' | 'weekly'; byWeekday?: number[] } | null
  source: TodoSource
}

/** One day's working hours (HH:MM, 24h). */
export interface DayHours {
  start: string
  end: string
}

/** The hours automatic placement may use, per weekday. */
export interface AvailabilitySettings {
  /** Monday first (index 0 = Monday … 6 = Sunday). null = nothing is placed that day. */
  days: (DayHours | null)[]
}

/** The single-window shape older databases stored (converted when read). */
export interface LegacyAvailability {
  noWorkBefore: string
  workingHoursEnd: string
  protectedEvenings: number[]
  protectedEveningFrom: string
}

export interface ProfileInfo {
  active: ProfileName
  dbPath: string
  recordsDir: string
}

export interface TodaySummary {
  /** Self-study minutes logged this week (Mon–Sun, Europe/London). */
  weekMinutes: number
  weekTargetMinutes: number | null
  /** Minutes left in today's unfinished flexible blocks. */
  remainingTodayMinutes: number
  /** Minutes logged today (timers and manual time). */
  workedTodayMinutes: number
  /** Minutes of continuous work up to now (only while a timer runs; short gaps don't count as a break). */
  unbrokenMinutes: number
}

export interface SeedSummary {
  categories: number
  modules: number
  blocks: number
  sessions: number
  todos: number
}

// --- Assistant (Phase 6) ----------------------------------------------------------------

/**
 * applied: a small change, live straight away. pending: a larger change, live but waiting for
 * the user to accept or reject it. rejected/undone: reverted.
 */
export const BATCH_STATUSES = ['applied', 'pending', 'accepted', 'rejected', 'undone'] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

/** Where the user is in the app, sent with each message so "this week" or "this module" resolve. */
export interface ScreenContext {
  /** The route, e.g. "/calendar" or "/modules/neur". */
  path: string
  /** The calendar's visible range, when the calendar is showing. */
  visibleRange?: { start: string; end: string }
  moduleId?: string
  assignmentId?: string
  /** The block whose dialog is open, if any. */
  blockId?: string
}

/** What kind of conversation the panel is having. Debriefs and check-ins get their own tools. */
export type ConversationMode =
  | { kind: 'chat' }
  | { kind: 'debrief'; blockId: string }
  | { kind: 'checkin'; sessionId: string }
  /** The dissertation page's own assistant. */
  | { kind: 'dissertation' }

/** A kept Claude conversation, for the panel's History list. */
export interface ConversationSummary {
  id: string
  title: string
  mode: ConversationMode
  /** Shown as a tab. */
  open: boolean
  updatedAt: string
  messageCount: number
  /** The start of the last message, for the list. */
  preview: string
}

/** A kept conversation with its messages (the panel's own message objects, as JSON). */
export interface StoredConversation {
  id: string
  title: string
  mode: ConversationMode
  messages: unknown[]
  open: boolean
  updatedAt: string
}

export interface AssistantStatus {
  /** A Claude token from `claude setup-token` is stored in the Keychain. */
  hasToken: boolean
  /** safeStorage can encrypt (the Keychain is available). */
  canStore: boolean
  model: string
  /** A reply is being generated. */
  busy: boolean
}

/** Something the user asked Claude to remember ("no write-ups after 21:00"). */
export interface AssistantMemory {
  id: string
  text: string
  createdAt: string
}

/** One block's before/after in a batch, for the calendar preview. */
export interface BlockChange {
  blockId: string
  before: Pick<Block, 'title' | 'start' | 'end' | 'outcome'> | null
  after: Pick<Block, 'title' | 'start' | 'end' | 'outcome'> | null
}

export interface BatchSummary {
  id: string
  conversationId: string | null
  request: string
  status: BatchStatus
  changeCount: number
  createdAt: string
  /** One line per visible change, e.g. "Moved “L7 write-up” to Wed 19 Nov, 14:00–15:00". */
  lines: string[]
  blocks: BlockChange[]
}

/** A todo Claude proposes at the end of a debrief; created only if the user approves it. */
export interface TodoSuggestion {
  id: string
  title: string
  dueDate: string | null
}

/** Streamed from main to the panel while Claude replies. */
export type AssistantEvent =
  | { type: 'start'; conversationId: string; turnId: string }
  | { type: 'text'; conversationId: string; turnId: string; text: string }
  | { type: 'tool'; conversationId: string; turnId: string; name: string; label: string }
  | { type: 'suggestions'; conversationId: string; turnId: string; todos: TodoSuggestion[] }
  | {
      type: 'planBrief'
      conversationId: string
      turnId: string
      attachmentId: string
      assignmentId: string | null
    }
  | {
      type: 'done'
      conversationId: string
      turnId: string
      batch: BatchSummary | null
    }
  | { type: 'error'; conversationId: string; turnId: string; message: string }

export interface WeeklyReview {
  weekStart: string
  at: string
  text: string
}

// --- Spaced repetition (Phase 6.5, experimental) ---------------------------------------------

export const REVIEW_RATINGS = ['easy', 'ok', 'hard'] as const
export type ReviewRating = (typeof REVIEW_RATINGS)[number]

/** One review of a lecture: open (due) or done with a rating. */
export interface ReviewItem {
  id: string
  lectureId: string
  /** e.g. "NEUR L7" */
  lectureTitle: string
  moduleId: string
  moduleLabel: string
  colour: string
  /** 1-based: review 1 of 5, … */
  step: number
  steps: number
  /** Local date YYYY-MM-DD */
  due: string
  status: 'overdue' | 'today' | 'upcoming' | 'done'
  block: Pick<Block, 'id' | 'start' | 'end' | 'outcome' | 'attention'> | null
  rating: ReviewRating | null
  doneAt: string | null
}

export interface LectureReviews {
  lectureId: string
  lectureTitle: string
  moduleId: string
  number: number
  reviews: ReviewItem[]
}

export interface RevisionOverview {
  /** Overdue and due today, oldest first. */
  due: ReviewItem[]
  /** Open reviews with a block this week (Mon–Sun), by time. */
  week: ReviewItem[]
  /** Lectures with any reviews, per module, with their history. */
  lectures: LectureReviews[]
}

// --- Focus and menu-bar timer (Phase 6.5) ----------------------------------------------------

export interface FocusSettings {
  /** Turn a Focus mode on while a timer runs. */
  enabled: boolean
  /** Shortcut names run with `shortcuts run`. */
  onShortcut: string
  offShortcut: string
}

export interface FocusStatus extends FocusSettings {
  /** Which of the two shortcuts exist in the Shortcuts app. */
  found: { on: boolean; off: boolean }
  lastError: string | null
}

/** Tot sync (Phase 8), for Settings. */
export interface TotStatus {
  enabled: boolean
  /** Tot itself, or the demo's stand-in file. */
  source: 'tot' | 'file'
  lastSyncedAt: string | null
  lastError: string | null
  /** The dot the UNI list was found in. */
  dot: number | null
  /** Changes only flow from Tot to Engram right now. */
  oneWay: boolean
  /** Real Tot: write back through the user's shortcut with Tot's "Set Dot" action. */
  twoWay: boolean
  writeShortcut: string
  /** The dot that shortcut is set to. */
  writeDot: number
  /** Whether a shortcut with that name exists (filled in by the IPC handler). */
  shortcutFound?: boolean
  /** Todos currently linked to a line. */
  linked: number
}

/** Google Calendar push (Phase 9), for Settings. */
export interface GoogleStatus {
  /** Google itself, or the demo's stand-in file. */
  source: 'google' | 'file'
  enabled: boolean
  /** An OAuth client has been added (real profile). */
  hasClient: boolean
  signedIn: boolean
  calendarId: string | null
  lastSyncedAt: string | null
  lastError: string | null
  /** Events Engram has pushed and keeps up to date. */
  events: number
  /** Demo: events in the stand-in file. */
  demoEvents: number | null
}

/** The Stats page (Phase 9). */
export type StatsRange = 'week' | '4w' | '12w' | 'all'
export interface StatsOverview {
  range: StatsRange
  /** Local date the range starts on (null = all time). */
  from: string | null
  totalMinutes: number
  weekTargetMinutes: number | null
  averagePerWeek: number
  byModule: {
    categoryId: string | null
    label: string
    name: string
    colour: string | null
    minutes: number
  }[]
  byType: { type: string; minutes: number }[]
  /** The last 12 weeks, oldest first (whatever the range). */
  weeks: { weekStart: string; minutes: number }[]
  /** Flexible work that has ended, in the range. */
  planned: {
    plannedMinutes: number
    loggedMinutes: number
    blocks: number
    done: number
    partial: number
    skipped: number
    unmarked: number
  }
  /** Finished assignment stages (all time): logged ÷ estimate. */
  estimates: {
    stages: number
    ratio: number | null
    furthestOff: {
      assignment: string
      stage: string
      estimate: number
      logged: number
      ratio: number
    }[]
  }
}

/** Backups (Phase 9). */
export interface BackupInfo {
  /** Folder name, e.g. "2026-11-18 1430" (London time). */
  name: string
  at: string
  bytes: number
}
export interface BackupStatus {
  enabled: boolean
  /** Where backups go (iCloud Drive by default). */
  folder: string
  usingDefault: boolean
  /** This profile's folder inside it. */
  profileFolder: string
  lastBackupAt: string | null
  lastError: string | null
  /** Newest first. */
  backups: BackupInfo[]
}

/** Settings → Updates and the top bar's "Restart to update" (docs/ORIGINAL-SPEC.md §9). */
export interface UpdateStatus {
  /** The installed app. False under `npm run dev`, which has nothing to update. */
  packaged: boolean
  /** This app's build (null for installed builds from before updates). */
  current: BuildInfo | null
  /** A newer build staged by `npm run release`. */
  ready: { build: BuildInfo; notes: UpdateNotes } | null
  /** The app the last update replaced (its build is null if it predates updates). */
  previous: { build: BuildInfo | null } | null
}

/** What a module's lecture list suggests merging (Phase 10). */
export interface LectureListAnalysis {
  method: 'dates' | 'order'
  /** Timetabled lectures that the list shows are really several. */
  proposals: {
    lectureId: string
    number: number
    /** The lectures in it, as the list gives them (local HH:MM). */
    parts: { title: string; start: string; end: string }[]
    /** Where the parts begin, in minutes from the lecture's start. */
    cuts: number[]
    confidence: 'sure' | 'check'
  }[]
  /** Lectures the list names one-to-one: their titles (kept when the list is applied). */
  titled: { lectureId: string; number: number; title: string }[]
  unmatched: number
  /** Lectures in the list, and in the timetable. */
  listed: number
  timetabled: number
}

/** The evening shutdown view. */
export interface ShutdownSummary {
  done: Block[]
  loggedMinutes: number
  /** Planned later today, not started. */
  left: Block[]
  /** Over or half done today and not finished (unmarked, partial, skipped). */
  unfinished: Block[]
  tomorrowFirst: Block | null
  /** Tomorrow's first piece of work (flexible block), if different. */
  tomorrowFirstWork: Block | null
}

/** Whether term 2 is over (for the exam-season reminder). */
export interface TermStatus {
  termTwoEnded: boolean
  /** The inferred last lecture of term 2 (YYYY-MM-DD), once it's over. */
  lastLecture: string | null
  /** The demo is pretending term 2 has ended. */
  simulated: boolean
}

// --- Dissertation (Phase 7) -----------------------------------------------------------------

export const SECTION_STATUSES = [
  'not-started',
  'reading',
  'drafting',
  'drafted',
  'revised'
] as const
export type SectionStatus = (typeof SECTION_STATUSES)[number]

export const READING_STATUSES = ['to-read', 'read', 'notes-done'] as const
export type ReadingStatus = (typeof READING_STATUSES)[number]

export interface DissertationSettings {
  title: string
  /** The module the dissertation belongs to (its colour and records folder). */
  moduleId: string | null
  /** UTC ISO instant. */
  submissionDue: string | null
  /** The user's own viva day (YYYY-MM-DD); the feed only lists the cohort's viva sessions. */
  vivaDate: string | null
  /** HH:MM, if known. */
  vivaTime: string | null
  wordTarget: number | null
  /** The timeline starts here (YYYY-MM-DD). */
  startedOn: string | null
  zoteroCollectionKey: string | null
  zoteroCollectionName: string | null
}

export interface DissertationSection {
  id: string
  position: number
  title: string
  status: SectionStatus
  wordCount: number | null
  wordTarget: number | null
  notes: string | null
  /** Logged on this section's sessions. */
  loggedMinutes: number
  /** Planned sessions still to come. */
  upcoming: Pick<Block, 'id' | 'start' | 'end'>[]
  readingCount: number
}

export interface Milestone {
  id: string
  title: string
  /** YYYY-MM-DD */
  due: string
  doneAt: string | null
}

export interface ReadingItem {
  /** The Zotero item key. */
  id: string
  title: string
  creators: string
  year: string | null
  itemType: string
  publication: string | null
  doi: string | null
  url: string | null
  status: ReadingStatus
  sectionIds: string[]
  /** No longer in the Zotero collection (kept for its status and links). */
  missing: boolean
}

export interface MeetingAction {
  id: string
  text: string
  todoId: string | null
  done: boolean
}

export interface Meeting {
  id: string
  /** UTC ISO instant */
  at: string
  notes: string
  actions: MeetingAction[]
}

export interface DissertationOverview {
  settings: DissertationSettings
  sections: DissertationSection[]
  milestones: Milestone[]
  reading: ReadingItem[]
  meetings: Meeting[]
  wordCount: number
  zoteroSyncedAt: string | null
  /** The cohort's viva days from the timetable (to pick your own from). */
  vivaDays: string[]
  colour: string | null
}

export interface ZoteroCollection {
  key: string
  name: string
  /** "Parent / Child" */
  path: string
  /** How deep it is (0 = top level), for showing the folders as a tree. */
  depth: number
  /** Items in it and all its subfolders (an item in several counts once per folder). */
  numItems: number
  /** Items directly in it. */
  ownItems: number
}

/** What Claude extracts from a project proposal, for the user to check before saving. */
/** An assignment planned from its brief (Phase 8), checked by the user before saving. */
export interface AssignmentPlanDraft {
  title: string | null
  moduleId: string | null
  type: AssignmentType
  /** Local date YYYY-MM-DD and time HH:MM. */
  dueDate: string | null
  dueTime: string | null
  weighting: number | null
  wordLimit: number | null
  /** What the assignment asks for, in a few sentences. */
  summary: string | null
  stages: { name: string; minutes: number }[]
}

export interface PlanDraft {
  title: string | null
  sections: { title: string; wordTarget: number | null }[]
  milestones: { title: string; due: string }[]
  submissionDue: string | null
  wordTarget: number | null
}

/**
 * A linked calendar (iCloud…), shown on the calendar for reference only: its events are never
 * blocks, so nothing is planned around them. Its link is kept encrypted and never shown again.
 */
export interface LinkedCalendar {
  /** The calendar's category id (its toggle in the Calendars list). */
  id: string
  name: string
  colour: string
  /** How many events were on it at the last check (from two weeks ago to six months ahead). */
  events: number
  lastCheckedAt: string | null
  lastError: string | null
}

/** One event of a linked calendar, as the calendar draws it. */
export interface LinkedEventView {
  id: string
  /** The event's own id in its calendar (for deleting it from Engram's view). */
  uid: string
  /** The calendar's category id: hidden when its toggle is off. */
  calendarId: string
  calendar: string
  colour: string
  title: string
  allDay: boolean
  /** UTC ISO instants; for an all-day event, dates (YYYY-MM-DD, the end not included). */
  start: string
  end: string
}

/** The real timetable feed (its link is kept encrypted, never shown again). */
export interface FeedStatus {
  connected: boolean
  lastCheckedAt: string | null
  lastError: string | null
}

/** A weekly fixed commitment, e.g. a pub shift. */
export interface Commitment {
  id: string
  title: string
  kind: 'work' | 'social'
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  byWeekday: number[]
  startTime: string
  endTime: string
}

export type CommitmentInput = Omit<Commitment, 'id'>

/** What the setup wizard keeps. */
export interface SetupState {
  /** The day the user started with Engram (YYYY-MM-DD): earlier lectures go to the Backlog. */
  startDate: string | null
  weeklyTargetMinutes: number | null
  completedAt: string | null
  commitments: Commitment[]
}

/** Moodle (UCL): whether Engram has a key, and what it can see with it. */
export interface MoodleCheck {
  sitename: string
  /** Courses you're enrolled on. */
  courses: number
  /** Functions Engram will need that Moodle doesn't allow with this key. */
  missing: string[]
}

/** Moodle downloads, for Settings. */
export interface MoodleStatus {
  /** There's something to sync from (signed in, or the demo's stand-in). */
  connected: boolean
  demo: boolean
  lastSyncedAt: string | null
  lastError: string | null
}

/** One of this year's Moodle courses and the module it feeds (null = not synced). */
export interface MoodleCourseRow {
  id: number
  code: string | null
  title: string
  moduleId: string | null
  /** Files fetched from it so far. */
  files: number
}

/** A file from Moodle, and the lecture it's the slides or notes for (when one was found). */
export type MoodleFile = Attachment & { lectureId: string | null }

/** A module's Moodle files under one Moodle section ("Week 8: …"). */
export interface MoodleFileGroup {
  section: string
  week: number | null
  files: MoodleFile[]
}

/** The last time Claude organised a module's lectures (Organise lectures). */
export interface OrganiseStatus {
  /** What it was run on (it runs again only when this changes). */
  hash: string
  at: string
  /** The lecture list it read, if any. */
  listName: string | null
  /** Lectures it named, files it tagged to a lecture. */
  named: number
  tagged: number
  /** Timetable slots that hold more than one lecture (suggested, never applied by itself). */
  splits: {
    lectureId: string
    number: number
    cuts: number[]
    parts: { title: string; start: string; end: string }[]
  }[]
  /** Sessions that look like the rest of an earlier lecture (suggested, never applied by itself). */
  continuations?: { lectureId: string; number: number; firstId: string; firstNumber: number }[]
  splitsDismissed: boolean
}

/** One connection's result from Sync everything (top bar). */
export interface SyncResult {
  name: 'Timetable' | 'Tot' | 'Moodle' | 'Google Calendar'
  ok: boolean
  /** What happened, or why it failed (never a link or key). */
  detail: string
}

/** What right-click → Move to next week did (`blocks:moveToNextWeek`). */
export type NextWeekMove =
  | { moved: true; block: Block; sameTime: boolean; withinAvailability: boolean }
  | { moved: false; reason: string }
