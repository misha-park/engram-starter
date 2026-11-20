import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
import { SESSION_KINDS } from '../../core/session-kinds'
import {
  ASSIGNMENT_TYPES,
  BATCH_STATUSES,
  READING_STATUSES,
  REVIEW_RATINGS,
  SECTION_STATUSES,
  BLOCK_KINDS,
  BLOCK_SOURCES,
  BLOCK_TYPES,
  CATEGORY_KINDS,
  LINKED_TYPES,
  OUTCOMES,
  TODO_SOURCES,
  ATTACHMENT_TARGETS,
  type ConversationMode,
  type RecurrenceRule,
  type Todo
} from '../../shared/types'

// Conventions:
// - ids are text (stable, readable ids from the seed; random UUIDs for user data)
// - instants are UTC ISO strings; local dates are YYYY-MM-DD strings
// - after editing this file run `npm run db:generate` to create a migration

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`)

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
  name: text('name').notNull(),
  shortLabel: text('short_label').notNull(),
  colour: text('colour').notNull(),
  sortOrder: integer('sort_order').notNull().default(0)
})

export const modules = sqliteTable('modules', {
  id: text('id').primaryKey(),
  categoryId: text('category_id')
    .notNull()
    .unique()
    .references(() => categories.id, { onDelete: 'cascade' }),
  /** Write-up time per hour of lecture (a 2-hour lecture gets twice this). */
  writeUpMinutes: integer('write_up_minutes').notNull().default(60),
  folderPath: text('folder_path'),
  assessmentNotes: text('assessment_notes'),
  /** Claude names the lectures and tags their slides (the user can switch it off). */
  autoOrganise: integer('auto_organise', { mode: 'boolean' }).notNull().default(true),
  /** Notify about important posts in the module's Moodle forums (the user can switch it off). */
  forumNotifications: integer('forum_notifications', { mode: 'boolean' }).notNull().default(true),
  /**
   * The timetable's [Practical] and [Workshop] events are listed with the lectures, with
   * write-ups. Null until the user is asked (only modules that have such events are).
   */
  timetabledSessions: integer('timetabled_sessions', { mode: 'boolean' })
})

/** Names a module has in the timetable feed. Several names can map to one module. */
export const moduleAliases = sqliteTable('module_aliases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  moduleId: text('module_id')
    .notNull()
    .references(() => modules.id, { onDelete: 'cascade' }),
  feedName: text('feed_name').notNull().unique()
})

/**
 * Every event from the timetable feed, keyed on the feed's UID (so re-imports are idempotent).
 * Several events can share one block: a cross-listed module's event appears once per name.
 */
export const timetableEvents = sqliteTable(
  'timetable_events',
  {
    uid: text('uid').primaryKey(),
    moduleName: text('module_name').notNull(),
    level: integer('level'),
    feedType: text('feed_type').notNull(),
    /** Our block type; null for [None] events, which are kept but hidden. */
    type: text('type', { enum: BLOCK_TYPES }),
    start: text('start').notNull(),
    end: text('end').notNull(),
    blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    firstSeenAt: createdAt(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** Deleted by the user: kept out of the calendar, whatever later imports say. */
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false)
  },
  (t) => [index('timetable_events_block_idx').on(t.blockId)]
)

/** A lecture: one timetabled Lecture block, its number within the module and its write-up. */
export const lectures = sqliteTable('lectures', {
  id: text('id').primaryKey(),
  moduleId: text('module_id')
    .notNull()
    .references(() => modules.id, { onDelete: 'cascade' }),
  blockId: text('block_id')
    .notNull()
    .unique()
    .references(() => blocks.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  /** When flashcards were made for this lecture (null = not yet). */
  flashcardsAt: text('flashcards_at'),
  /** When the user's notes for this lecture were made (null = not yet). */
  notesAt: text('notes_at'),
  writeUpBlockId: text('write_up_block_id').references(() => blocks.id, { onDelete: 'set null' }),
  /** The lecture's title, from the module's lecture list (null until one is applied). */
  title: text('title'),
  /** The user named it: Claude never renames it. */
  titleLocked: integer('title_locked', { mode: 'boolean' }).notNull().default(false),
  /**
   * This session continues an earlier lecture (one lecture across several days): it shares
   * that lecture's number and name, and the lecture gets one write-up after its last part.
   */
  continuesId: text('continues_id').references((): AnySQLiteColumn => lectures.id, {
    onDelete: 'set null'
  }),
  /** The user didn't go (lectures count as attended once they're over, unless marked). */
  missed: integer('missed', { mode: 'boolean' }).notNull().default(false),
  /** The user deleted its write-up: none is placed again (Plan a write-up undoes it). */
  noWriteUp: integer('no_write_up', { mode: 'boolean' }).notNull().default(false),
  /**
   * What the session really is (the feed calls workshops and practicals lectures too). Null:
   * not confirmed, so it's guessed from its name (`core/session-kinds.ts`).
   */
  kind: text('kind', { enum: SESSION_KINDS })
})

export const assignments = sqliteTable('assignments', {
  id: text('id').primaryKey(),
  moduleId: text('module_id')
    .notNull()
    .references(() => modules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  due: text('due').notNull(),
  type: text('type', { enum: ASSIGNMENT_TYPES }).notNull(),
  weighting: integer('weighting'),
  wordLimit: integer('word_limit'),
  briefLink: text('brief_link'),
  isGroup: integer('is_group', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  /** What the assignment asks for, from its brief (Claude's summary, editable). */
  summary: text('summary'),
  /** Its work is on the calendar. Off: nothing is planned until the user plans it. */
  planned: integer('planned', { mode: 'boolean' }).notNull().default(true),
  /** Set when submitted (status stops there). */
  submittedAt: text('submitted_at'),
  /** The mark it got (a percentage), once it's back. */
  mark: real('mark'),
  /** Feedback on it, pasted or typed by the user. */
  feedback: text('feedback'),
  /** Minutes that didn't fit before the deadline at the last (re)schedule. */
  unplacedMinutes: integer('unplaced_minutes').notNull().default(0),
  createdAt: createdAt()
})

/** An assignment's stages, in order. Each is planned as one or more flexible blocks. */
export const assignmentStages = sqliteTable('assignment_stages', {
  id: text('id').primaryKey(),
  assignmentId: text('assignment_id')
    .notNull()
    .references(() => assignments.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  name: text('name').notNull(),
  estimateMinutes: integer('estimate_minutes').notNull(),
  doneAt: text('done_at')
})

/** A recurring series (e.g. the Saturday pub shift). Occurrences are stored as ordinary blocks. */
export const recurrences = sqliteTable('recurrences', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  kind: text('kind', { enum: BLOCK_KINDS }).notNull(),
  type: text('type', { enum: BLOCK_TYPES }).notNull(),
  categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
  rule: text('rule', { mode: 'json' }).$type<RecurrenceRule>().notNull(),
  startsOn: text('starts_on').notNull(),
  until: text('until'),
  /** Local dates (YYYY-MM-DD) of occurrences the user removed; never regenerated. */
  exdates: text('exdates', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Colour for every occurrence (copied onto each generated block). */
  colour: text('colour'),
  createdAt: createdAt()
})

export const blocks = sqliteTable(
  'blocks',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: BLOCK_KINDS }).notNull(),
    type: text('type', { enum: BLOCK_TYPES }).notNull(),
    title: text('title').notNull(),
    start: text('start').notNull(),
    end: text('end').notNull(),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    linkedType: text('linked_type', { enum: LINKED_TYPES }),
    linkedId: text('linked_id'),
    source: text('source', { enum: BLOCK_SOURCES }).notNull(),
    outcome: text('outcome', { enum: OUTCOMES }).notNull().default('none'),
    recurrenceId: text('recurrence_id').references(() => recurrences.id, { onDelete: 'cascade' }),
    occurrenceDate: text('occurrence_date'),
    debriefPending: integer('debrief_pending', { mode: 'boolean' }).notNull().default(false),
    /**
     * Edited by hand (moved or resized). Automatic regeneration (series edits, timetable
     * re-imports) leaves it alone.
     */
    detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
    /** Why this block needs the user's attention (e.g. placed outside availability); shown in red. */
    attention: text('attention'),
    /** A partial or skipped block that has been followed up (rescheduled) or let go: off the Backlog. */
    backlogResolvedAt: text('backlog_resolved_at'),
    /** Its own colour, for blocks that aren't module work (otherwise the category's colour). */
    colour: text('colour'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: text('updated_at')
  },
  (t) => [
    index('blocks_start_idx').on(t.start),
    uniqueIndex('blocks_occurrence_idx').on(t.recurrenceId, t.occurrenceDate)
  ]
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    start: text('start').notNull(),
    end: text('end'),
    minutes: integer('minutes').notNull().default(0),
    manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
    linkedType: text('linked_type', { enum: LINKED_TYPES }),
    linkedId: text('linked_id'),
    outcome: text('outcome', { enum: OUTCOMES }),
    debrief: text('debrief'),
    /** One-line note for a done session. */
    note: text('note'),
    checkinPending: integer('checkin_pending', { mode: 'boolean' }).notNull().default(false),
    /** For a running timer: when the "still working?" prompt is due (extending moves it). */
    plannedEnd: text('planned_end'),
    /** When the prompt was shown (null until then; reset when the timer is extended). */
    promptedAt: text('prompted_at'),
    createdAt: createdAt()
  },
  (t) => [index('sessions_start_idx').on(t.start)]
)

export const todos = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  dueDate: text('due_date'),
  linkedType: text('linked_type', { enum: LINKED_TYPES }),
  linkedId: text('linked_id'),
  recurrence: text('recurrence', { mode: 'json' }).$type<Todo['recurrence']>(),
  source: text('source', { enum: TODO_SOURCES }).notNull().default('app'),
  /** Identity of the matching line in the Tot dot (Phase 8). */
  totLineId: text('tot_line_id'),
  doneAt: text('done_at'),
  /** A ticked recurring todo's next instance, so re-ticking never makes a second one. */
  nextId: text('next_id'),
  createdAt: createdAt()
})

/** Deadlines of any kind that aren't assignments (forms, applications, fees…). */
export const deadlines = sqliteTable('deadlines', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  /** UTC ISO instant. */
  due: text('due').notNull(),
  moduleId: text('module_id').references(() => modules.id, { onDelete: 'set null' }),
  notes: text('notes'),
  doneAt: text('done_at'),
  createdAt: createdAt()
})

/** Key/value settings; values are JSON. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull()
})

/** Every mutation made by the assistant (and later, bulk user actions), with enough to undo it. */
export const changeLog = sqliteTable('change_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: createdAt(),
  actor: text('actor', { enum: ['user', 'claude', 'system'] }).notNull(),
  /** Groups the changes made by one assistant action, so they undo together. */
  batchId: text('batch_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  before: text('before', { mode: 'json' }),
  after: text('after', { mode: 'json' }),
  undoneAt: text('undone_at')
})

/** Where each entity's Markdown record file lives (paths are relative to the records dir). */
export const recordsIndex = sqliteTable(
  'records_index',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    path: text('path').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [uniqueIndex('records_entity_idx').on(t.entityType, t.entityId)]
)

/**
 * Claude conversations, kept so tabs come back after a restart and old chats can be reopened
 * from History. `messages` is what the panel shows (JSON); `session_id` is the Agent SDK
 * session a new message resumes.
 */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  mode: text('mode', { mode: 'json' }).notNull().$type<ConversationMode>(),
  messages: text('messages', { mode: 'json' }).notNull().$type<unknown[]>(),
  sessionId: text('session_id'),
  /** Shown as a tab in the panel. */
  open: integer('open', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: text('updated_at').notNull()
})

/**
 * One assistant turn that changed data. Its row-level changes are in change_log (same batch id),
 * so the whole turn undoes together. Larger turns wait for review (pending → accepted/rejected).
 */
export const assistantBatches = sqliteTable('assistant_batches', {
  id: text('id').primaryKey(),
  createdAt: createdAt(),
  conversationId: text('conversation_id'),
  /** What the user asked, for the change history. */
  request: text('request').notNull(),
  status: text('status', { enum: BATCH_STATUSES }).notNull(),
  /** Visible changes (blocks, todos, stages…); side effects such as sessions don't count. */
  changeCount: integer('change_count').notNull().default(0),
  resolvedAt: text('resolved_at')
})

/**
 * Spaced-repetition reviews of a written-up lecture (experimental; its own table so the
 * feature is easy to remove). One row per review; the next is created when one is done.
 */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    lectureId: text('lecture_id')
      .notNull()
      .references(() => lectures.id, { onDelete: 'cascade' }),
    /** 1-based position in the review sequence. */
    step: integer('step').notNull(),
    /** Local date YYYY-MM-DD the review is due. */
    due: text('due').notNull(),
    blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
    rating: text('rating', { enum: REVIEW_RATINGS }),
    doneAt: text('done_at'),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('reviews_lecture_step_idx').on(t.lectureId, t.step)]
)

// --- Dissertation (Phase 7) -----------------------------------------------------------------

/** The dissertation (one row, id "main"). */
export const dissertation = sqliteTable('dissertation', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  moduleId: text('module_id').references(() => modules.id, { onDelete: 'set null' }),
  submissionDue: text('submission_due'),
  vivaDate: text('viva_date'),
  vivaTime: text('viva_time'),
  wordTarget: integer('word_target'),
  startedOn: text('started_on'),
  zoteroCollectionKey: text('zotero_collection_key'),
  zoteroCollectionName: text('zotero_collection_name'),
  zoteroSyncedAt: text('zotero_synced_at')
})

export const dissSections = sqliteTable('diss_sections', {
  id: text('id').primaryKey(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  status: text('status', { enum: SECTION_STATUSES }).notNull().default('not-started'),
  wordCount: integer('word_count'),
  wordTarget: integer('word_target'),
  notes: text('notes')
})

export const dissMilestones = sqliteTable('diss_milestones', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  /** Local date YYYY-MM-DD */
  due: text('due').notNull(),
  doneAt: text('done_at')
})

/** The reading list, mirrored from a Zotero collection (id = the Zotero item key). */
export const readingItems = sqliteTable('reading_items', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  creators: text('creators').notNull().default(''),
  year: text('year'),
  itemType: text('item_type').notNull(),
  publication: text('publication'),
  doi: text('doi'),
  url: text('url'),
  status: text('status', { enum: READING_STATUSES }).notNull().default('to-read'),
  /** Sections this item is used in. */
  sectionIds: text('section_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  missing: integer('missing', { mode: 'boolean' }).notNull().default(false)
})

export const meetings = sqliteTable('meetings', {
  id: text('id').primaryKey(),
  at: text('at').notNull(),
  notes: text('notes').notNull().default('')
})

/** A meeting's action items; each becomes a todo. */
export const meetingActions = sqliteTable('meeting_actions', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  text: text('text').notNull(),
  todoId: text('todo_id').references(() => todos.id, { onDelete: 'set null' })
})

/** Tot sync (Phase 8): what each linked todo's line was at the last sync. */
export const totLinks = sqliteTable('tot_links', {
  todoId: text('todo_id')
    .primaryKey()
    .references(() => todos.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  done: integer('done', { mode: 'boolean' }).notNull(),
  position: integer('position').notNull()
})

/**
 * Files attached to an item (Phase 8). Engram keeps its own copy in the profile's `files/`
 * folder (`storedName`); the original is left where it was.
 */
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  storedName: text('stored_name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  targetType: text('target_type', { enum: ATTACHMENT_TARGETS }),
  targetId: text('target_id'),
  addedBy: text('added_by', { enum: ['user', 'claude'] })
    .notNull()
    .default('user'),
  createdAt: createdAt()
})

/** Google Calendar push (Phase 9): what was last pushed for each block or deadline. */
export const gcalEvents = sqliteTable('gcal_events', {
  /** `block:<id>` or `deadline:<id>` */
  key: text('key').primaryKey(),
  eventId: text('event_id').notNull(),
  hash: text('hash').notNull(),
  /** The event's start as pushed (local date-time or date), to tell what's in the window. */
  start: text('start').notNull()
})

/**
 * Lectures the timetable gives as one event but are really several (e.g. a 2-hour slot with
 * two different lectures). Keyed on the event's UID, so the split survives re-imports;
 * reconcileTimetable turns the event into one block (and one lecture) per part.
 */
export const lectureSplits = sqliteTable('lecture_splits', {
  uid: text('uid').primaryKey(),
  /** Where the parts begin, in minutes from the event's start (ascending, inside the event). */
  cuts: text('cuts', { mode: 'json' }).notNull().$type<number[]>(),
  /** From an uploaded lecture list, or by hand. */
  source: text('source', { enum: ['list', 'user'] })
    .notNull()
    .default('user'),
  createdAt: createdAt()
})

/**
 * Moodle courses of this academic year (Moodle downloads), and the module each one feeds.
 * moduleId null = not synced. `matchedBy` says whether Engram suggested it or the user chose.
 */
export const moodleCourses = sqliteTable('moodle_courses', {
  id: integer('id').primaryKey(),
  shortname: text('shortname').notNull(),
  fullname: text('fullname').notNull(),
  moduleId: text('module_id').references(() => modules.id, { onDelete: 'set null' }),
  matchedBy: text('matched_by', { enum: ['auto', 'user'] })
    .notNull()
    .default('auto'),
  createdAt: createdAt()
})

/**
 * Everything Engram has fetched from Moodle: one row per file (or per assignment brief), so a
 * file is fetched once, replaced when Moodle's copy changes, and never fetched again after the
 * user deletes it (the attachment is gone but the row stays).
 */
export const moodleItems = sqliteTable('moodle_items', {
  /** `file:<course module id>:<path><name>` or `brief:<course module id>` */
  key: text('key').primaryKey(),
  courseId: integer('course_id').notNull(),
  kind: text('kind', { enum: ['file', 'brief'] }).notNull(),
  /** The Moodle section, e.g. "Week 8: Simple supervised learning". */
  section: text('section').notNull(),
  /** UCL teaching week from the section name, when it has one. */
  week: integer('week'),
  /** The item's name on Moodle (a resource's title, or the assignment's). */
  title: text('title').notNull(),
  /** Moodle's last-modified time (seconds) of what was fetched. */
  modified: integer('modified').notNull(),
  attachmentId: text('attachment_id').references(() => attachments.id, { onDelete: 'set null' }),
  /** Files: the lecture these are the slides (or notes) for, when one was found. */
  lectureId: text('lecture_id').references(() => lectures.id, { onDelete: 'set null' }),
  /** Files: the user chose the lecture (or "just the week"): Claude never changes it. */
  lectureLocked: integer('lecture_locked', { mode: 'boolean' }).notNull().default(false),
  /** Files: whether matching to a lecture was done (so it's asked once). */
  lectureMatched: integer('lecture_matched', { mode: 'boolean' }).notNull().default(false),
  /** For briefs: a summary was asked for once (so it isn't asked again every sync). */
  summaryTried: integer('summary_tried', { mode: 'boolean' }).notNull().default(false),
  /** For briefs: the notification was seen and dismissed. */
  dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt()
})

/**
 * A Moodle forum of a synced course. `baseline` is the newest activity when Engram first read
 * it: older posts never notify. `seenUntil` is the newest discussion change read since.
 */
export const moodleForums = sqliteTable('moodle_forums', {
  id: integer('id').primaryKey(),
  courseId: integer('course_id').notNull(),
  /** Moodle's forum type: 'news' is the course's Announcements forum. */
  type: text('type').notNull(),
  name: text('name').notNull(),
  baseline: integer('baseline').notNull(),
  seenUntil: integer('seen_until').notNull(),
  createdAt: createdAt()
})

/**
 * Every forum post Engram has read since a forum's first sync, so each is looked at once.
 * Students' posts keep only their ids; staff posts and announcements keep what the
 * notification needs (and their text, so Claude can classify them on a later sync).
 */
export const moodleForumPosts = sqliteTable('moodle_forum_posts', {
  /** Moodle's post id. */
  id: integer('id').primaryKey(),
  courseId: integer('course_id').notNull(),
  forumId: integer('forum_id').notNull(),
  discussionId: integer('discussion_id').notNull(),
  authorId: integer('author_id').notNull(),
  kind: text('kind', { enum: ['announcement', 'staff', 'other'] }).notNull(),
  status: text('status', { enum: ['important', 'not-important', 'pending'] }).notNull(),
  isReply: integer('is_reply', { mode: 'boolean' }).notNull().default(false),
  subject: text('subject'),
  author: text('author'),
  /** Staff posts waiting for Claude: their text (cleared once classified). */
  text: text('text'),
  /** The notification's one-line title. */
  title: text('title'),
  /** The post on Moodle. */
  url: text('url'),
  /** When it was posted (Moodle seconds). */
  created: integer('created').notNull(),
  dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt()
})

/** Who is course staff on a Moodle course (from its contacts, or a role lookup), asked once. */
export const moodlePeople = sqliteTable(
  'moodle_people',
  {
    courseId: integer('course_id').notNull(),
    userId: integer('user_id').notNull(),
    staff: integer('staff', { mode: 'boolean' }).notNull()
  },
  (p) => [primaryKey({ columns: [p.courseId, p.userId] })]
)
