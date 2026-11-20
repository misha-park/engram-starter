import type {
  NextWeekMove,
  SyncResult,
  OrganiseStatus,
  MoodleCheck,
  MoodleCourseRow,
  MoodleFileGroup,
  MoodleStatus,
  Commitment,
  CommitmentInput,
  FeedStatus,
  LinkedCalendar,
  LinkedEventView,
  SetupState,
  LectureListAnalysis,
  NewBlockInput,
  BackupStatus,
  UpdateStatus,
  GoogleStatus,
  StatsOverview,
  StatsRange,
  TotStatus,
  Attachment,
  AttachmentRef,
  AssignmentPlanDraft,
  DissertationOverview,
  DissertationSettings,
  PlanDraft,
  ReadingStatus,
  SectionStatus,
  ZoteroCollection,
  FocusSettings,
  FocusStatus,
  ReviewRating,
  RevisionOverview,
  ShutdownSummary,
  TermStatus,
  AssistantEvent,
  AssistantStatus,
  BatchSummary,
  ConversationMode,
  ScreenContext,
  TodoSuggestion,
  WeeklyReview,
  AssistantMemory,
  AssignmentDetail,
  AssignmentInput,
  AssignmentSummary,
  AssignmentUpdate,
  AvailabilitySettings,
  BacklogItem,
  NotificationItem,
  TodoInput,
  ConversationSummary,
  StoredConversation,
  GeneralDeadline,
  DeadlineInput,
  Block,
  Category,
  CheckinItem,
  ManualTimeInput,
  OutcomeInput,
  RunningTimer,
  Deadline,
  FeedName,
  ImportSummary,
  ModuleDetail,
  ModuleUpdate,
  Recurrence,
  RecurrenceRule,
  ModuleWithDetails,
  ProfileInfo,
  ProfileName,
  SeedSummary,
  TodaySummary,
  Todo
} from './types'
import type { SessionKind } from '../core/session-kinds'

/**
 * The renderer ↔ main contract. Each channel maps to its argument tuple and result.
 * Main must implement every channel (see src/main/ipc.ts); the preload only forwards
 * channels listed in IPC_CHANNELS.
 */
export interface IpcContract {
  'profile:get': { args: []; result: ProfileInfo }
  'profile:switch': { args: [name: ProfileName]; result: ProfileInfo }
  'demo:reset': { args: []; result: SeedSummary }
  'categories:list': { args: []; result: Category[] }
  'modules:list': { args: []; result: ModuleWithDetails[] }
  'modules:get': { args: [id: string]; result: ModuleDetail | null }
  'modules:update': { args: [id: string, patch: ModuleUpdate]; result: void }
  'modules:create': {
    args: [input: { name: string; shortLabel: string; colour: string; feedName?: string }]
    result: string
  }
  'modules:chooseFolder': { args: []; result: string | null }
  'modules:openFolder': { args: [id: string]; result: void }
  'lectures:setFlashcards': { args: [lectureId: string, done: boolean]; result: void }
  'lectures:setNotes': { args: [lectureId: string, done: boolean]; result: void }
  /** A lecture's write-up block, made if it has none. */
  'lectures:ensureWriteUp': {
    args: [lectureId: string]
    result: { blockId: string; created: boolean }
  }
  /** Plan a write-up for a lecture whose write-up you deleted (or delete it: true). */
  'lectures:setNoWriteUp': { args: [lectureId: string, noWriteUp: boolean]; result: void }
  /** Say what a session is (null: back to the guess from its name). */
  'lectures:setKind': { args: [lectureId: string, kind: SessionKind | null]; result: void }
  /** A module's guesses for one kind are right. Returns how many were confirmed. */
  'lectures:confirmKinds': { args: [moduleId: string, kind: SessionKind]; result: number }
  /** Join a lecture with the next one (the timetable split one session in two). */
  'lectures:split': { args: [lectureId: string, cuts?: number[]]; result: void }
  'lectures:setAttended': { args: [lectureId: string, attended: boolean]; result: void }
  'assignments:summarise': { args: [id: string]; result: string | null }
  /** Hide a timetabled event; the key for `blocks:undoDelete`. */
  'timetable:hideBlock': { args: [blockId: string]; result: { undo: string } }
  'timetable:hiddenCount': { args: []; result: number }
  'timetable:restoreHidden': { args: []; result: void }
  'timetable:listHidden': {
    args: []
    result: { uid: string; moduleName: string; feedType: string; start: string; end: string }[]
  }
  'timetable:restoreHiddenEvent': { args: [uid: string]; result: void }
  'lectures:join': { args: [lectureId: string]; result: void }
  /** Read a module's lecture list (a file already attached) and suggest merges. */
  'lectureList:analyse': {
    args: [moduleId: string, attachmentId: string]
    result: LectureListAnalysis
  }
  /** Merge the accepted suggestions (lecture id groups). Returns how many. */
  'lectureList:apply': {
    args: [
      splits: { lectureId: string; cuts: number[]; titles?: string[] }[],
      titles?: { lectureId: string; title: string }[]
    ]
    result: number
  }
  'feedNames:list': { args: []; result: FeedName[] }
  'feedNames:assign': { args: [feedName: string, moduleId: string | null]; result: FeedName[] }
  'timetable:import': { args: []; result: ImportSummary }
  'timetable:lastImport': { args: []; result: ImportSummary | null }
  'sync:all': { args: []; result: SyncResult[] }
  'feed:status': { args: []; result: FeedStatus }
  /** Linked calendars (iCloud…): shown for reference, never planned around. */
  'calendars:list': { args: []; result: LinkedCalendar[] }
  'calendars:listEvents': { args: [startIso: string, endIso: string]; result: LinkedEventView[] }
  /** Check a public calendar link by reading it, and link the calendar if that works. */
  'calendars:add': { args: [url: string]; result: LinkedCalendar }
  'calendars:update': {
    args: [id: string, patch: { name?: string; colour?: string }]
    result: void
  }
  'calendars:remove': { args: [id: string]; result: void }
  /** Delete one event from Engram's view (the calendar itself is untouched); restore undoes it. */
  'calendars:hideEvent': { args: [calendarId: string, uid: string]; result: void }
  'calendars:restoreEvent': { args: [calendarId: string, uid: string]; result: void }
  'calendars:sync': { args: []; result: void }
  'feed:connect': { args: [url: string]; result: ImportSummary }
  'feed:disconnect': { args: []; result: void }
  'setup:get': { args: []; result: SetupState }
  'setup:setStartDate': { args: [date: string | null]; result: void }
  'setup:setWeeklyTarget': { args: [minutes: number | null]; result: void }
  'setup:addCommitment': { args: [input: CommitmentInput]; result: Commitment }
  'setup:endCommitment': { args: [id: string]; result: void }
  'setup:complete': { args: []; result: void }
  'moodle:status': { args: []; result: MoodleStatus }
  'moodle:signIn': { args: []; result: MoodleCheck }
  'moodle:check': { args: []; result: MoodleCheck }
  'moodle:signOut': { args: []; result: void }
  'moodle:listCourses': { args: []; result: MoodleCourseRow[] }
  'moodle:refreshCourses': { args: []; result: MoodleCourseRow[] }
  'moodle:setCourseModule': { args: [courseId: number, moduleId: string | null]; result: void }
  'moodle:syncNow': { args: []; result: MoodleStatus }
  'moodle:moduleFiles': { args: [moduleId: string]; result: MoodleFileGroup[] }
  'moodle:dismissBrief': { args: [key: string]; result: void }
  'moodle:dismissForumPost': { args: [postId: number]; result: void }
  /** Opens the post on Moodle and dismisses it; false for a demo post (no page to open). */
  'moodle:openForumPost': { args: [postId: number]; result: boolean }
  'lectures:organiseStatus': { args: [moduleId: string]; result: OrganiseStatus | null }
  'lectures:organise': { args: [moduleId: string]; result: OrganiseStatus | null }
  'lectures:dismissSplits': { args: [moduleId: string]; result: void }
  'lectures:stopOrganise': { args: [moduleId: string]; result: void }
  'lectures:rename': { args: [lectureId: string, title: string | null]; result: void }
  'lectures:combine': { args: [lectureId: string, earlierLectureId: string]; result: void }
  'lectures:separate': { args: [lectureId: string]; result: void }
  /** Make this session the rest of the lecture before it; returns that lecture's id. */
  'lectures:mergeWithPrevious': { args: [lectureId: string]; result: string }
  'files:setLecture': { args: [attachmentId: string, lectureId: string | null]; result: void }
  'blocks:listInRange': { args: [startIso: string, endIso: string]; result: Block[] }
  'blocks:get': { args: [id: string]; result: Block | null }
  'blocks:move': { args: [id: string, startIso: string, endIso: string]; result: Block }
  /** Same time next week if free, else that week's first free slot; or why it can't move. */
  'blocks:moveToNextWeek': { args: [id: string]; result: NextWeekMove }
  'blocks:removeOccurrence': { args: [id: string]; result: void }
  'blocks:setColour': { args: [id: string, colour: string | null]; result: void }
  'blocks:create': { args: [input: NewBlockInput]; result: Block }
  /** Edit a block added by hand (or by Claude). */
  'blocks:update': { args: [id: string, input: NewBlockInput]; result: Block }
  /** Delete a block added by hand (or by Claude). */
  /** Delete any block but a timetabled one; `note` says what else changed, `undo` takes it back. */
  'blocks:delete': { args: [id: string]; result: { note: string | null; undo: string | null } }
  'blocks:undoDelete': { args: [undo: string]; result: void }
  /** A series stops after this occurrence. */
  'blocks:endSeriesAfter': { args: [id: string]; result: void }
  'recurrences:get': { args: [id: string]; result: Recurrence | null }
  'recurrences:update': { args: [id: string, rule: RecurrenceRule]; result: Recurrence }
  'deadlines:listInRange': { args: [startIso: string, endIso: string]; result: Deadline[] }
  'settings:getAvailability': { args: []; result: AvailabilitySettings }
  'settings:setAvailability': {
    args: [availability: AvailabilitySettings]
    result: AvailabilitySettings
  }
  'timer:get': { args: []; result: RunningTimer | null }
  'timer:start': { args: [blockId: string]; result: RunningTimer }
  'timer:extend': { args: [minutes: number]; result: RunningTimer }
  'timer:stop': { args: []; result: string }
  'sessions:complete': {
    args: [sessionId: string, input: OutcomeInput, correctedEnd?: string]
    result: void
  }
  'sessions:checkins': { args: []; result: CheckinItem[] }
  'sessions:addManual': { args: [input: ManualTimeInput]; result: string }
  'blocks:markOutcome': {
    args: [blockId: string, input: OutcomeInput & { minutes?: number }]
    result: void
  }
  'blocks:saveDebrief': { args: [blockId: string, debrief: string]; result: void }
  'clipboard:write': { args: [text: string]; result: void }
  'records:open': { args: [blockId: string]; result: void }
  'assignments:list': { args: []; result: AssignmentSummary[] }
  'assignments:get': { args: [id: string]; result: AssignmentDetail | null }
  'assignments:create': { args: [input: AssignmentInput]; result: string }
  'assignments:update': { args: [id: string, patch: AssignmentUpdate]; result: void }
  'assignments:submit': { args: [id: string, submitted: boolean]; result: void }
  /** Returns the key for `assignments:undoDelete`. */
  'assignments:delete': { args: [id: string]; result: string }
  'assignments:undoDelete': { args: [undo: string]; result: void }
  'assignments:reschedule': { args: [id: string]; result: { unplacedMinutes: number } }
  'assignments:setPlanned': { args: [id: string, planned: boolean]; result: void }
  'assignments:setTotal': { args: [id: string, totalMinutes: number]; result: void }
  'stages:add': {
    args: [assignmentId: string, stage: { name: string; estimateMinutes: number }]
    result: string
  }
  'stages:update': {
    args: [stageId: string, patch: { name?: string; estimateMinutes?: number; done?: boolean }]
    result: void
  }
  /** Returns the key for `assignments:undoDelete`. */
  'stages:remove': { args: [stageId: string]; result: string }
  'stages:move': { args: [stageId: string, direction: -1 | 1]; result: void }
  /** One block of a stage's work in the next free slot; its id and start. */
  'stages:addBlock': {
    args: [stageId: string, minutes: number]
    result: { id: string; start: string }
  }
  'deadlines:list': { args: []; result: GeneralDeadline[] }
  'deadlines:create': { args: [input: DeadlineInput]; result: GeneralDeadline }
  'deadlines:update': { args: [id: string, patch: Partial<DeadlineInput>]; result: void }
  'deadlines:setDone': { args: [id: string, done: boolean]; result: void }
  'deadlines:delete': { args: [id: string]; result: void }
  'deadlines:restore': { args: [deadline: GeneralDeadline]; result: void }
  'todos:list': { args: []; result: Todo[] }
  'todos:create': { args: [input: TodoInput]; result: string }
  'todos:update': { args: [id: string, patch: Partial<TodoInput>]; result: void }
  'todos:setDone': { args: [id: string, done: boolean]; result: void }
  'todos:archive': { args: [id: string]; result: void }
  'todos:unarchive': { args: [id: string]; result: void }
  'todos:schedule': {
    args: [id: string, opts: { start?: string; minutes?: number }]
    result: string
  }
  'backlog:list': { args: []; result: BacklogItem[] }
  'backlog:schedule': {
    args: [key: string, opts: { start?: string; minutes?: number }]
    result: string
  }
  'backlog:dismiss': { args: [key: string]; result: void }
  'notifications:list': { args: []; result: NotificationItem[] }
  'summary:today': { args: []; result: TodaySummary }
  'reviews:overview': { args: []; result: RevisionOverview }
  'reviews:rate': {
    args: [reviewId: string, input: { rating: ReviewRating; minutes?: number }]
    result: void
  }
  'reviews:reschedule': { args: [reviewId: string]; result: string }
  'shutdown:summary': { args: []; result: ShutdownSummary }
  'shutdown:reschedule': {
    args: [blockIds: string[]]
    result: { moved: number; notPlaced: string[] }
  }
  'shutdown:backlog': { args: [blockIds: string[]]; result: number }
  'term:status': { args: []; result: TermStatus }
  'term:simulate': { args: [on: boolean]; result: void }
  'diss:overview': { args: []; result: DissertationOverview }
  'diss:updateSettings': { args: [patch: Partial<DissertationSettings>]; result: void }
  'diss:addSection': { args: [title: string]; result: string }
  'diss:updateSection': {
    args: [
      id: string,
      patch: {
        title?: string
        status?: SectionStatus
        wordCount?: number | null
        wordTarget?: number | null
        notes?: string | null
      }
    ]
    result: void
  }
  'diss:removeSection': { args: [id: string]; result: void }
  'diss:moveSection': { args: [id: string, direction: -1 | 1]; result: void }
  'diss:addMilestone': { args: [title: string, due: string]; result: string }
  'diss:updateMilestone': {
    args: [id: string, patch: { title?: string; due?: string; done?: boolean }]
    result: void
  }
  'diss:removeMilestone': { args: [id: string]; result: void }
  'diss:updateReading': {
    args: [id: string, patch: { status?: ReadingStatus; sectionIds?: string[] }]
    result: void
  }
  'diss:saveMeeting': {
    args: [input: { id?: string; at: string; notes: string; actions: string[] }]
    result: string
  }
  'diss:removeMeeting': { args: [id: string]; result: void }
  'diss:scheduleSession': { args: [sectionId: string, minutes: number]; result: string }
  'zotero:collections': { args: []; result: ZoteroCollection[] }
  /** Get a paper's PDF ready from Zotero (hover); whether it has one. */
  'zotero:preparePdf': { args: [id: string]; result: boolean }
  /** Drag a paper's PDF out of Engram as a real file (call from `dragstart`). */
  'zotero:startDrag': { args: [id: string]; result: void }
  /** Open a paper's PDF. */
  'zotero:openPdf': { args: [id: string]; result: void }
  'zotero:sync': { args: []; result: { added: number; updated: number; missing: number } }
  'plan:fromText': { args: [text: string]; result: PlanDraft }
  'plan:fromFile': { args: []; result: { name: string; draft: PlanDraft } | null }
  /** Plan import from a dropped proposal (kept as a dissertation file). */
  'plan:fromPath': { args: [path: string]; result: { name: string; draft: PlanDraft } }
  'plan:apply': { args: [draft: PlanDraft]; result: { sections: number; milestones: number } }
  'files:add': { args: [paths: string[], target: AttachmentRef | null]; result: Attachment[] }
  /** Typed or pasted text (a brief), kept as a .txt file. */
  'files:addText': {
    args: [name: string, text: string, target: AttachmentRef | null]
    result: Attachment
  }
  /** Choose files with the Open dialog; null when cancelled. */
  'files:choose': { args: [target: AttachmentRef | null]; result: Attachment[] | null }
  'files:list': { args: [target: AttachmentRef]; result: Attachment[] }
  'files:listDissertation': { args: []; result: Attachment[] }
  'files:get': { args: [ids: string[]]; result: Attachment[] }
  'files:setTarget': { args: [id: string, target: AttachmentRef | null]; result: Attachment }
  'files:rename': { args: [id: string, name: string]; result: void }
  'files:remove': { args: [id: string]; result: void }
  'files:open': { args: [id: string]; result: void }
  'files:reveal': { args: [id: string]; result: void }
  /** Copy a file to the Downloads folder; the name it was saved under. */
  'files:download': { args: [id: string]; result: { name: string } }
  /** Show the copy `files:download` last saved of this file in Finder. */
  'files:revealDownload': { args: [id: string]; result: void }
  /** Put the file itself on the clipboard, to paste into Finder, Mail, Messages… */
  'files:copy': { args: [id: string]; result: void }
  /** Start dragging the file out of Engram, as a real file (call from `dragstart`). */
  'files:startDrag': { args: [id: string]; result: void }
  /** Claude's suggested plan for an assignment from a brief already added as a file. */
  'brief:draft': { args: [attachmentId: string]; result: AssignmentPlanDraft }
  'brief:apply': {
    args: [
      draft: AssignmentPlanDraft,
      opts: { assignmentId?: string | null; attachmentId?: string | null; planned?: boolean }
    ]
    result: string
  }
  'stats:overview': { args: [range: StatsRange]; result: StatsOverview }
  'backup:status': { args: []; result: BackupStatus }
  'backup:set': {
    args: [patch: { enabled?: boolean; folder?: string | null }]
    result: BackupStatus
  }
  'backup:chooseFolder': { args: []; result: BackupStatus | null }
  'backup:now': { args: []; result: BackupStatus }
  /** Replace the current data with a backup (a backup of the current state is made first). */
  'backup:restore': { args: [name: string]; result: BackupStatus }
  'backup:reveal': { args: [name?: string]; result: void }
  'update:status': { args: []; result: UpdateStatus }
  /**
   * Back up, quit, swap in the update `npm run release` staged, reopen. Returns the backup's
   * error instead when it fails (then `skipBackup` updates anyway); null when restarting.
   */
  'update:restart': {
    args: [opts?: { skipBackup?: boolean }]
    result: { backupError: string } | null
  }
  /** Quit, swap the previous app back in, reopen. */
  'update:rollback': { args: []; result: void }
  'google:status': { args: []; result: GoogleStatus }
  /** The OAuth client: its ID and secret, or the downloaded JSON in the first argument. */
  'google:setClient': { args: [clientIdOrJson: string, secret?: string]; result: GoogleStatus }
  'google:signIn': { args: []; result: GoogleStatus }
  'google:signOut': { args: []; result: GoogleStatus }
  'google:forget': { args: []; result: GoogleStatus }
  'google:setEnabled': { args: [enabled: boolean]; result: GoogleStatus }
  'google:syncNow': { args: []; result: GoogleStatus }
  'google:openCalendar': { args: []; result: void }
  'tot:status': { args: []; result: TotStatus }
  'tot:setEnabled': { args: [enabled: boolean]; result: TotStatus }
  'tot:setWriting': {
    args: [input: { twoWay: boolean; writeShortcut: string; writeDot: number }]
    result: TotStatus
  }
  'tot:syncNow': { args: []; result: TotStatus }
  /** Demo only: open the stand-in Tot file in the default text editor. */
  'tot:openDemoFile': { args: []; result: void }
  'focus:get': { args: []; result: FocusStatus }
  'focus:set': { args: [settings: FocusSettings]; result: void }
  'focus:test': { args: [which: 'on' | 'off']; result: void }
  'assistant:status': { args: []; result: AssistantStatus }
  'assistant:setToken': { args: [token: string]; result: AssistantStatus }
  'assistant:clearToken': { args: []; result: AssistantStatus }
  'assistant:send': {
    args: [
      req: {
        conversationId: string
        message: string
        mode: ConversationMode
        screen?: ScreenContext
        attachments?: string[]
      }
    ]
    result: BatchSummary | null
  }
  'assistant:stop': { args: []; result: void }
  /** Delete a conversation for good (from History). */
  'assistant:forget': { args: [conversationId: string]; result: void }
  'conversations:list': { args: []; result: ConversationSummary[] }
  'conversations:get': { args: [id: string]; result: StoredConversation | null }
  'conversations:save': {
    args: [
      conversation: {
        id: string
        title: string
        mode: ConversationMode
        messages: unknown[]
        open: boolean
      }
    ]
    result: void
  }
  'conversations:setOpen': { args: [id: string, open: boolean]; result: void }
  'assistant:pending': { args: []; result: BatchSummary | null }
  'assistant:accept': { args: [batchId: string]; result: void }
  'assistant:reject': { args: [batchId: string]; result: void }
  'assistant:undo': { args: [batchId: string]; result: void }
  'assistant:recent': { args: []; result: BatchSummary[] }
  'assistant:addTodo': { args: [todo: TodoSuggestion]; result: string }
  'assistant:review': { args: []; result: WeeklyReview | null }
  'assistant:runReview': { args: []; result: WeeklyReview }
  /** What the user asked Claude to remember (Settings → Claude). */
  'assistant:memories': { args: []; result: AssistantMemory[] }
  'assistant:remember': { args: [text: string]; result: AssistantMemory }
  'assistant:forgetMemory': { args: [id: string]; result: void }
}

export type IpcChannel = keyof IpcContract

export const IPC_CHANNELS = [
  'profile:get',
  'profile:switch',
  'demo:reset',
  'categories:list',
  'modules:list',
  'modules:get',
  'modules:update',
  'modules:create',
  'modules:chooseFolder',
  'modules:openFolder',
  'lectures:setFlashcards',
  'lectures:setNotes',
  'lectures:setNoWriteUp',
  'lectures:setKind',
  'lectures:confirmKinds',
  'lectures:ensureWriteUp',
  'lectures:split',
  'lectures:setAttended',
  'assignments:summarise',
  'timetable:hideBlock',
  'timetable:hiddenCount',
  'timetable:restoreHidden',
  'timetable:listHidden',
  'timetable:restoreHiddenEvent',
  'lectures:join',
  'lectureList:analyse',
  'lectureList:apply',
  'feedNames:list',
  'feedNames:assign',
  'timetable:import',
  'timetable:lastImport',
  'sync:all',
  'feed:status',
  'calendars:list',
  'calendars:listEvents',
  'calendars:add',
  'calendars:update',
  'calendars:remove',
  'calendars:hideEvent',
  'calendars:restoreEvent',
  'calendars:sync',
  'feed:connect',
  'feed:disconnect',
  'setup:get',
  'setup:setStartDate',
  'setup:setWeeklyTarget',
  'setup:addCommitment',
  'setup:endCommitment',
  'setup:complete',
  'moodle:status',
  'moodle:signIn',
  'moodle:check',
  'moodle:signOut',
  'moodle:listCourses',
  'moodle:refreshCourses',
  'moodle:setCourseModule',
  'moodle:syncNow',
  'moodle:moduleFiles',
  'moodle:dismissBrief',
  'moodle:dismissForumPost',
  'moodle:openForumPost',
  'lectures:organiseStatus',
  'lectures:organise',
  'lectures:dismissSplits',
  'lectures:stopOrganise',
  'lectures:rename',
  'lectures:combine',
  'lectures:separate',
  'lectures:mergeWithPrevious',
  'files:setLecture',
  'blocks:listInRange',
  'blocks:get',
  'blocks:move',
  'blocks:moveToNextWeek',
  'blocks:removeOccurrence',
  'blocks:setColour',
  'blocks:create',
  'blocks:update',
  'blocks:delete',
  'blocks:undoDelete',
  'blocks:endSeriesAfter',
  'recurrences:get',
  'recurrences:update',
  'deadlines:listInRange',
  'settings:getAvailability',
  'settings:setAvailability',
  'timer:get',
  'timer:start',
  'timer:extend',
  'timer:stop',
  'sessions:complete',
  'sessions:checkins',
  'sessions:addManual',
  'blocks:markOutcome',
  'blocks:saveDebrief',
  'records:open',
  'clipboard:write',
  'assignments:list',
  'assignments:get',
  'assignments:create',
  'assignments:update',
  'assignments:submit',
  'assignments:delete',
  'assignments:undoDelete',
  'assignments:reschedule',
  'assignments:setPlanned',
  'assignments:setTotal',
  'stages:add',
  'stages:update',
  'stages:remove',
  'stages:move',
  'stages:addBlock',
  'todos:list',
  'deadlines:list',
  'deadlines:create',
  'deadlines:update',
  'deadlines:setDone',
  'deadlines:delete',
  'deadlines:restore',
  'todos:create',
  'todos:update',
  'todos:setDone',
  'todos:archive',
  'todos:unarchive',
  'todos:schedule',
  'backlog:list',
  'backlog:schedule',
  'backlog:dismiss',
  'notifications:list',
  'summary:today',
  'reviews:overview',
  'reviews:rate',
  'reviews:reschedule',
  'shutdown:summary',
  'shutdown:reschedule',
  'shutdown:backlog',
  'term:status',
  'term:simulate',
  'diss:overview',
  'diss:updateSettings',
  'diss:addSection',
  'diss:updateSection',
  'diss:removeSection',
  'diss:moveSection',
  'diss:addMilestone',
  'diss:updateMilestone',
  'diss:removeMilestone',
  'diss:updateReading',
  'diss:saveMeeting',
  'diss:removeMeeting',
  'diss:scheduleSession',
  'zotero:collections',
  'zotero:preparePdf',
  'zotero:startDrag',
  'zotero:openPdf',
  'zotero:sync',
  'plan:fromText',
  'plan:fromFile',
  'plan:fromPath',
  'plan:apply',
  'files:add',
  'files:addText',
  'files:choose',
  'files:list',
  'files:listDissertation',
  'files:get',
  'files:setTarget',
  'files:rename',
  'files:remove',
  'files:open',
  'files:reveal',
  'files:download',
  'files:revealDownload',
  'files:copy',
  'files:startDrag',
  'brief:draft',
  'brief:apply',
  'stats:overview',
  'backup:status',
  'backup:set',
  'backup:chooseFolder',
  'backup:now',
  'backup:restore',
  'backup:reveal',
  'update:status',
  'update:restart',
  'update:rollback',
  'google:status',
  'google:setClient',
  'google:signIn',
  'google:signOut',
  'google:forget',
  'google:setEnabled',
  'google:syncNow',
  'google:openCalendar',
  'tot:status',
  'tot:setEnabled',
  'tot:setWriting',
  'tot:syncNow',
  'tot:openDemoFile',
  'focus:get',
  'focus:set',
  'focus:test',
  'assistant:status',
  'assistant:setToken',
  'assistant:clearToken',
  'assistant:send',
  'assistant:stop',
  'assistant:forget',
  'conversations:list',
  'conversations:get',
  'conversations:save',
  'conversations:setOpen',
  'assistant:pending',
  'assistant:accept',
  'assistant:reject',
  'assistant:undo',
  'assistant:recent',
  'assistant:addTodo',
  'assistant:review',
  'assistant:runReview',
  'assistant:memories',
  'assistant:remember',
  'assistant:forgetMemory'
] as const satisfies readonly IpcChannel[]

/** Events pushed from main to the renderer. */
export interface IpcEvents {
  /** Data changed outside the renderer's own mutations (reset, timer timeout; later sync, assistant). */
  'data:changed': []
  /** The running timer reached its planned end: ask "still working?" once. */
  'timer:prompt': []
  /** Claude's reply streaming in, tool activity, and the end of a turn. */
  'assistant:event': [event: AssistantEvent]
  /** Open the Claude panel (e.g. the Sunday review notification was clicked). */
  'assistant:open': [what: 'review']
  /** Show a page (the menu bar's Settings… ⌘,). */
  'app:navigate': [path: string]
  /** An update was staged by `npm run release`, or went. */
  'update:changed': []
}

export type IpcEvent = keyof IpcEvents
export const IPC_EVENTS = [
  'data:changed',
  'timer:prompt',
  'assistant:event',
  'assistant:open',
  'app:navigate',
  'update:changed'
] as const satisfies readonly IpcEvent[]

/** What the preload exposes as `window.api`. */
export interface WindowApi {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: IpcContract[C]['args']
  ): Promise<IpcContract[C]['result']>
  on<E extends IpcEvent>(event: E, listener: (...args: IpcEvents[E]) => void): () => void
  /** The path of a file dragged in from Finder (Electron's webUtils). */
  pathForFile(file: File): string
}
