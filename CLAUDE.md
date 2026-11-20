# Engram: guide for Claude

You are the developer for a student who is adapting this app to her own needs. **She is not
technical and has never used Claude Code before.** She is a final-year (6th year) UCL medical
student. She will talk to you in plain English and rely on you for everything technical.

This app, Engram, is a personal study planner for macOS (Electron + React + SQLite) that was built
by a UCL undergraduate for his own use. It is the skeleton her version starts from. The first
author's own spec is in `docs/ORIGINAL-SPEC.md` (read it when you need the reasoning behind a
design; it is not a list of requirements for her).

## Step zero: is the onboarding done?

1. If `MY-APP.md` does not exist, or its `Status:` line is not `onboarding complete`, **stop and
   follow `ONBOARDING.md` before anything else**, starting with her first message, whatever it
   says (a greeting is enough). Do not wait for her to ask.
2. If it is complete, read `MY-APP.md` (what she decided, what was built, what is next) and carry
   on from there. Her requests are changes to her own version of the app.

## How to work with her (always)

- **Plain English. Short messages. One question at a time.** No jargon: say "the calendar page",
  not "the CalendarPage component". When you must use a technical word, explain it in half a
  sentence. Never paste long code, logs or file lists at her.
- **Offer choices, recommend one.** Use the AskUserQuestion tool with clear options where you can,
  and say which you would pick and why in one line. She should rarely have to type an answer.
- **Do everything technical yourself:** installing, running commands, editing files, testing,
  fixing errors. Never ask her to open a terminal or run a command. The only things she does
  herself are things a person must do: click "Install" on a macOS popup, type her Mac password
  when macOS asks, sign in to her own accounts (UCL Moodle) in the window the app opens, paste a
  secret link into a field in the app. For each, tell her exactly what she will see and what to
  click, in plain words.
- **Never ask for, accept or store a password, token or private link in the chat.** Passwords go
  only into the real sign-in page or the app's own settings fields. If she pastes one by mistake,
  tell her it is fine, do not repeat it, and move on.
- **Before every change that touches how the app looks or works: say in one or two plain sentences
  what you are about to do.** After it: say what changed and how she can see it.
- **Checkpoint everything.** After each finished change run the checks (below), then `git add -A`
  and commit with a plain-English message. She can always ask "undo that": use `git revert` on the
  last commit(s); never `git reset --hard` or force anything without telling her what will be lost.
- **Check before you say "done":** `npm run typecheck` and `npm test` pass, and for anything she
  can see, run the app (`npm run dev`) and look at it yourself rather than assuming.
- **Her data is precious.** The demo profile is fake and can be reset freely. Her real profile
  (her real timetable, Moodle files, notes, reviews) never gets reset, deleted or overwritten
  without a fresh backup first (Settings → Backups, or `backup:now`) and her explicit yes. Test
  with `--user-data-dir=<temp folder>` (see the rules below), never on her real data folder.
- **Stay in this folder.** Do not touch files outside the project folder and the app's own data
  folder (`~/Library/Application Support/Engram*`), except to install tools the app needs.
- **She has her own copy.** It has no connection to GitHub or to the person who sent it, and
  nothing here is ever pushed anywhere. Do not run `git push`.
- If something fails, fix it quietly if you can. If you cannot, tell her in one plain sentence
  what is wrong and what you will try next. Never leave her with a raw error message.
- She may be tired and stressed (finals). Keep it calm, quick and kind. Do not over-explain.

## Commands

(You run these; she never does.)

- `npm install`: first time only (a few minutes).
- `npm run dev`: opens the app from source in a window, on **demo data**, with its own data folder
  (`Engram Dev`). Use this to try and to show her a change.
- `npm test`, `npm run typecheck`: the checks. Run both before every commit.
- `npm run release`: tests, builds, signs the Mac app and installs/updates the one in
  `/Applications` ("Restart to update" appears inside the app if it is open). Commit first, or it
  refuses. This is how she gets her real, daily-use app.

## The app in one page

Pages (the rail on the left, defined in `src/renderer/src/pages/registry.ts`): **Calendar** (the
home page: week/day/month, drag and resize), **Modules** (each module's lectures, files, write-ups),
**Assignments** (coursework with stages, back-scheduled from the deadline, plus general deadlines),
**Revision** (spaced-repetition reviews, experimental), **Dissertation**, **Backlog** (everything
that slipped), **Stats**, **Settings**, and a **Setup** wizard. A **Claude panel** (⌘J) on the right
is an assistant that organises the planner. Everything is stored in a local SQLite database.

How a request flows: the React renderer (`src/renderer`) calls `window.api.invoke('channel', ...)`
→ the preload (`src/preload`) → a handler in `src/main/ipc.ts` → domain code in `src/main/*.ts` →
the database (`src/main/db`, Drizzle). The list of channels and their types is `src/shared/ipc.ts`;
add a channel there (type + the `IPC_CHANNELS` array) and a handler in `ipc.ts`. Planning maths
that needs no Electron or database lives in `src/core` and is unit-tested. Background jobs
(timetable feed, Moodle, Google, Tot…) are started in `src/main/index.ts`.

Key ideas to know before changing things:

- **Blocks** are the things on the calendar. A block is either *flexible* (placed by
  `src/core/scheduler.ts`: write-ups, assignment work, reviews) or *fixed* (a timetabled lecture,
  a commitment). All automatic placement goes through the scheduler, never through Claude.
- **Demo vs real data** are separate profiles in separate folders; the demo is fake and
  regenerated by `src/main/seed`. `npm run dev` never touches the installed app's data.
- **The Claude assistant** (`src/main/assistant/`) can only use the tools defined in `tools.ts`,
  each wrapped so its changes are logged and undoable. Its rules are in `prompt.ts`. **By design
  the original assistant only organises; it never writes notes, summaries or answers.** That is
  one of the first things to ask her about (see `ONBOARDING.md`), because it matters for revision.
- **Time** is stored as UTC and calculated in Europe/London with Temporal. Weeks start Monday.

## Feature map: what each feature is made of, and how to take it out

Most features are self-contained. To **remove a feature**: (1) take its entry out of
`pages/registry.ts` / `SettingsPage.tsx` / `index.ts` (so nothing shows and nothing runs),
(2) delete its files and their tests, (3) delete its handlers in `ipc.ts` and channels in
`shared/ipc.ts`, (4) run `npm run typecheck` and follow the errors until it is clean, then
`npm test`. **Never drop database tables or edit old migrations**: leave the tables in
`src/main/db/schema.ts` (empty tables cost nothing) unless she asks, and then write a safe
migration (see the migrations rule below). Prefer *hiding* over deleting when you are unsure; it is
reversible. After removing something, search the assistant (`prompt.ts`, `tools.ts`) and the demo
seed (`src/main/seed`) for leftovers, because Claude and the demo still mention it otherwise.

| Feature | Where it lives | Notes |
|---|---|---|
| **Calendar** (core, keep) | `pages/CalendarPage.tsx`, `calendar/`, `main/calendar.ts`, `core/scheduler.ts`, `core/availability.ts`, `core/recurrence.ts` | FullCalendar v7. The heart of the app. |
| **Modules and lectures** (core) | `pages/modules/`, `main/timetable.ts`, `main/lectures`-related code in `main/moodle/lectures.ts`, `core/lectures.ts` | Lecture rows, write-ups, split/merged lectures, files per lecture. Built around "lectures with write-ups"; a med student on placements may need a different shape. |
| **Assignments and deadlines** | `pages/Assignments*.tsx`, `main/assignments.ts`, `main/deadlines.ts`, `core/backschedule.ts` | Stages back-scheduled from a due date. Could be reshaped for portfolios, SSCs, audits, exams. |
| **Backlog, todos, notifications** (core) | `pages/BacklogPage.tsx`, `main/backlog.ts`, `main/todos.ts` | |
| **Timer, sessions, check-ins** (core) | `main/sessions.ts`, `core/timer.ts`, `main/tray.ts` (menu-bar timer) | A running timer is a session with no end. |
| **Revision / spaced repetition** | `pages/revision/`, `main/reviews.ts`, `core/reviews.ts`, table `reviews`, the `afterOutcome` call in `main/sessions.ts` | Unfinished/experimental. Reviews are scheduled 1, 3, 7, 21, 60 days after a lecture is written up, 20-30 minutes each, rated easy/ok/hard. It only plans sessions; the studying happens elsewhere. **Her priority feature: expect to extend it a lot.** |
| **Claude assistant** | `main/assistant/`, `shell/ClaudePanel.tsx` | Uses the student's own Claude plan through a token entered in Settings → Claude. |
| **Files** | `main/attachments.ts`, `ui/Attachments.tsx`, `main/documents.ts`, `main/pdf-background.ts` | Files are copied into the profile's `files/` folder. PDFs get a white page baked in so they read on a dark GoodNotes board. |
| **UCL timetable feed** | `main/feed.ts`, `main/timetable.ts`, `core/ics.ts`, `pages/TimetableSection.tsx` | Polls the student's personal UCL timetable iCal link every 3 hours. The link is a secret kept encrypted. Parsing is specific to UCL's format (see rules below). Hard-coded UCL term dates are in `core/terms.ts` (2026-27 only). |
| **Moodle** | `main/moodle/` (`auth.ts`, `source.ts`, `sync.ts`, `lectures.ts`, `forums.ts`), `core/moodle.ts`, `pages/MoodleSection.tsx`, tables `moodle_*` | Signs in the way the Moodle phone app does, downloads module files and assignment briefs, organises lectures with Claude, notifies about forum posts. **Currently only syncs the current academic year's courses** (`isCurrentCourse` in `core/moodle.ts`); she needs material from the last three years. |
| **Dissertation** (probably not needed) | `pages/dissertation/`, `main/dissertation.ts`, `main/assistant/plan.ts`, tools and prompt mode "dissertation" in `main/assistant`, IPC `diss:`/`plan:`, tables `dissertation`, `diss_*`, `meetings`, `meeting_actions` | Includes the reading list (Zotero) below. |
| **Zotero reading list** | `main/zotero.ts`, `main/reading-pdfs.ts`, `pages/dissertation/ReadingTab.tsx`, `reading_items` | Part of Dissertation. Reads Zotero 7's local API. |
| **Tot sync** | `main/tot.ts`, `core/tot.ts`, `pages/TotSection.tsx`, table `tot_links` | Two-way sync of todos with the Tot app. Only useful if she uses Tot. |
| **Google Calendar push** | `main/google/`, `core/gcal.ts`, `pages/GoogleSection.tsx`, table `gcal_events` | Needs her own Google Cloud project and OAuth client: technical, so only do it if she really wants it. |
| **iCloud / linked calendars** | `main/linked-calendars.ts`, `core/calendar-feed.ts`, `core/linked-events.ts`, `pages/LinkedCalendarsSection.tsx` | Shows another calendar (a public iCal link) read-only on the calendar. |
| **Focus mode** | `main/focus.ts`, `pages/FocusSection.tsx` | Turns a macOS Focus on while a timer runs, via the user's Shortcuts. |
| **Evening shutdown, exam-season button** | `main/shutdown.ts`, `shell/ShutdownDialog.tsx`, `main/term.ts`, `shell/ExamSeasonButton.tsx` | The exam-season button is tied to UCL term dates and is a natural place to build her exam-period mode. |
| **Stats** | `pages/stats/`, `main/stats.ts`, `core/stats.ts` | Hours per module, planned vs actual. |
| **Backups and updates** | `main/backup.ts`, `main/updates.ts`, `scripts/release.ts`, `resources/update-swap.sh` | Daily backups to iCloud Drive; `npm run release` + "Restart to update". Keep. |

## How to make common changes

- **A new page:** write the component in `src/renderer/src/pages/`, add one entry to `registry.ts`.
- **A new table:** edit `src/main/db/schema.ts`, then `npm run db:generate` (creates a SQL migration in
  `drizzle/`). Existing databases are migrated when the app opens. Read the migrations rule below.
- **A new IPC call:** the type in `src/shared/ipc.ts`, the channel in its list, the handler in
  `src/main/ipc.ts`; the renderer calls it with `call('channel', ...)` from `src/renderer/src/lib/api.ts`.
- **A new thing Claude can do:** a tool in `src/main/assistant/tools.ts` (set `mutates: true` if it
  changes data, and add the table to `TRACKED_TABLES` so it can be undone), plus a line in `prompt.ts`.
- **Change what Claude is allowed to do** (for example writing flashcards from her own slides):
  `src/main/assistant/prompt.ts` holds the rules in plain sentences. Change them only on her
  explicit say-so, and tell her plainly what the change means.
- **Anything with dates:** use `src/core/time.ts` (Temporal, Europe/London), never raw `Date`.
- **Tests:** put a `*.test.ts` next to the code. Pure logic in `src/core` is the easiest to test.
- **UCL-specific bits you may need to adapt:** `core/terms.ts` (hard-coded 2026-27 term and reading
  week dates), `core/moodle.ts` (course-year filter, week numbering from September), `main/timetable.ts`
  and `core/ics.ts` (the shape of UCL's timetable feed), the "write-up within 3 working days" rule in
  `core/scheduler.ts`, and the wording throughout.

## Reference from the original author

The rest of this file is the original author's working notes, kept because they are accurate and detailed. In them "the user" means whoever uses the app; in this copy that is her. "Phase N" refers to the build phases in `docs/ORIGINAL-SPEC.md`.

### All commands

- `npm run dev`: run the app from source (Electron + Vite, with HMR for the renderer), with its own data folder (`Engram Dev`)
- `npm run release`: test, build and sign the Mac app, and hand it to the installed one in `/Applications` ("Restart to update"; installed straight away if Engram is closed, and put there for the first time if it isn't installed yet). Refuses uncommitted changes unless `-- --dirty` (so commit first); `-- --install` installs a staged update. `npm run package` only builds `dist/mac-arm64/Engram.app`
- `npm test`: Vitest, run through Electron's Node (`ELECTRON_RUN_AS_NODE=1`) so better-sqlite3 matches the app's native build
- `npm run typecheck`: type-check both the node and web projects
- `npm run seed`: re-seed the **demo** profile from the CLI (it refuses to touch real data)
- `npm run eval:assistant`: the assistant's scripted requests against the real Claude (see `assistant/evals/`)
- `npm run db:generate`: after editing `src/main/db/schema.ts`, generate a new SQL migration in `drizzle/`

### Layout (detailed reference)

- `src/core/`: pure logic: time, totals, recurrence, availability, ICS parsing (`ics.ts`), the scheduling engine (`scheduler.ts`), review intervals (`reviews.ts`), the term-2 end (`term.ts`), Tot sync planning (`tot.ts`), Google Calendar events and push plans (`gcal.ts`), stats sums (`stats.ts`), backup naming and retention (`backup.ts`), how far off a deadline is (`due.ts`: days, late once the due time has passed, the label and colour used by the cards, the Deadlines list and the sidebar), lecture-list matching (`lecture-list.ts`) and Moodle helpers (`moodle.ts`: UCL teaching weeks, this year's courses, course-to-module suggestions). No Electron, DB or React imports. Unit-test everything here.
- `src/shared/`: types and the IPC contract (`ipc.ts`), shared by main, preload and renderer.
- `src/main/`: the Electron main process. It owns all side effects.
  - `calendar.ts`: calendar mutations (move, recurrences, availability) plus the change log. The UI and the assistant both use these.
  - `timetable.ts`: timetable import and reconciliation, lectures, write-up placement, module and feed-name mapping, split lectures (`lecture_splits`: one feed event that is really several lectures, keyed on the event UID, cut points in minutes from its start; the first part keeps the original block and lecture) and the start date (lectures before it get no write-up and wait in the Backlog)
  - `feed.ts`: the real UCL timetable feed (Phase 10). The link is checked by importing from it, then kept encrypted (`secrets/timetable.bin`) and polled every 3 hours; errors and status never contain it
  - `linked-calendars.ts`: linked calendars such as iCloud (Settings → iCloud calendar): a calendar's public iCal link, read every 30 minutes (`core/calendar-feed.ts`: repeating events expanded, cancelled ones left out, all-day ones kept as dates). Each is a `categories` row (`kind: 'calendar'`), so it gets a toggle in the Calendars list; the link is kept encrypted (`secrets/calendars.bin`, real profile only, never in the DB, results or errors) and the events in the `linkedCalendarEvents` setting. They are for looking at only: drawn as outlined read-only events (`kind: 'linked'` in `EventContent`; double-click copies one into a New event, and one already copied drops off, `core/linked-events.ts`; right-click deletes one from the view only, kept in the `linkedCalendarHidden` setting), never blocks, so nothing plans around them, Google Calendar never gets them and Claude never sees them. Nothing is ever written back to the calendar
  - `lecture-list.ts`: a module's lecture list (booklet or spreadsheet) read by Claude into lectures and times; `core/lecture-list.ts` matches it against the timetable (by date when this year's, otherwise in order) to suggest splits; nothing changes until the user ticks them
  - `moodle/`: UCL Moodle. `auth.ts` signs in the way the Moodle app does (Moodle's launch page in a window of Engram's own, `window.ts`, catching the `moodlemobile://token=` link and checking its signature against the sign-in's passport); the key is kept encrypted (`secrets/moodle.bin`) and sent only in POST bodies, only to Moodle's own address. `source.ts` has the real client and the demo's `FixtureMoodle` (`resources/fixtures/moodle-demo.json`, sections relative to the current week). `sync.ts` (`MoodleSync`, every 6 hours) fetches documents from this year's courses matched to modules (`moodle_courses`) into the module's files and assignment briefs (description + attached files) into the matching assignment, or the module with a notification; `moodle_items` makes each file come once, be replaced when Moodle's copy changes, and never come back after the user deletes it. It never adds deadlines or assignments. After a sync, `lectures.ts` (`organiseModule`, Organise lectures) gives Claude a module's three sources together (timetable lectures, the lecture list found among its files, Moodle sections and files) and applies what plain code validates: lecture names and slide tags (`moodle_items.lecture_id`); splits are only suggested (banner on the module page; `organise:<moduleId>` setting). It runs when its inputs change (a hash), or from the module page's Organise with Claude; a module's `autoOrganise` switch turns the automatic run off. Names the user gives (`lectures.title_locked`) and files the user places (`moodle_items.lecture_locked`) are never changed by it or by lecture lists. UCL's `mod_assign_get_assignments` fails server-side, so briefs come from course contents and `mod_assign_get_submission_status`. `forums.ts`: forum notifications (each synced module's forums, unless its `forumNotifications` switch is off). Filtering is `core/forum.ts`: Announcements (news) posts always count, students' posts never (only their ids are kept), staff (course contacts, or a role looked up once in `moodle_people`) replies with no hint of a change are dropped, and the other staff posts are classified by Claude with a one-line title (without Claude: staff discussions with hints). A forum's first sync only sets its `baseline`, so old posts never notify; turning a module's switch back on starts afresh. Notifications open the post on Moodle; nothing is ever posted or sent
  - `setup.ts`: the setup wizard's settings: weekly target, weekly commitments (e.g. a pub shift; creates the Work/Social category when needed), setup completion
  - `sessions.ts`: timers (a running timer is a session with no end; `tickTimer` runs every 15 s from `index.ts`), outcomes, check-ins, debriefs, manual time
  - `assignments.ts`: assignments and stages (a submitted one can get a `mark` and `feedback`, the user's own); deleting an assignment or a stage is tracked like Claude's changes, so its toast can Undo (`assignments:undoDelete`); `rescheduleAssignment` is the one place stage blocks get (re)planned (idempotent, keeps hand-moved and finished blocks); an assignment with `planned` off gets nothing placed (`setPlanned` takes all its future blocks off); `setTotalEstimate` rescales the stages not done yet
  - `backlog.ts`: Backlog items, scheduling them (drop time or next free slot), notifications list
  - `deadlines.ts`: general deadlines (Assignments page → Deadlines): anything with a due date that isn't an assignment; open ones join `repo.listDeadlines` (`kind: 'deadline'`), so they show on the calendar, Google Calendar, the sidebar countdown and the assignments timeline. Nothing is planned for them
  - `todos.ts`: small todos (a recurring todo creates its next instance when ticked, once: `todos.next_id`). Open todos with a due date join `repo.listDeadlines` (`kind: 'todo'`, due 23:59) so they show on the calendar's all-day row, but never go to Google Calendar
  - `assistant/`: the Claude assistant (Agent SDK). `runner.ts` runs turns (only Engram's own tools, no user settings, OAuth token, never an API key); `tools.ts` defines the tools (plain zod definitions, testable without the SDK); `placement.ts` holds the rules every placement must follow; `changes.ts` snapshots tracked tables around each changing tool call, saves a turn as one batch (one visible change = applied, more = pending review) and undoes batches; `auth.ts` keeps the token encrypted with safeStorage; `review.ts` is the Sunday review
  - `reviews.ts`: spaced repetition (experimental; own table, page and module so it's easy to remove). `afterOutcome` (called from `sessions.ts`) starts reviews when a write-up is done and finishes them when their block is
  - `dissertation.ts`: the dissertation (Phase 7): settings, sections, milestones, the reading list (`syncReading` keeps statuses and section links), supervisor meetings (action items become todos due a week later), sessions and `applyPlan`
  - `zotero.ts`: the reading list's source. The real profile reads Zotero 7's local API (`localhost:23119`, read-only); the demo reads `resources/fixtures/zotero-demo.json`. A collection includes all its subcollections (each item once), and every list is read page by page (the API sends 25 at a time by default)
  - `reading-pdfs.ts`: a paper's PDF from Zotero, to drag out of the Reading tab into GoodNotes or Finder (a PDF handle on each row: hover gets it ready, drag starts a real file drag, click opens it). `LocalZotero.pdfFile` lists the item's children, picks the main PDF (`pickPdf`: not the supplementary material, one Zotero holds itself rather than a link) and takes its `file://` address (the attachment's `links.enclosure`, else the redirect from `/items/KEY/file`). Zotero's own file is only read: `ReadingPdfs` works on a copy in the temp folder named "Authors (Year) Title.pdf", with the white background baked in (`pdf-background.ts`). The demo (`FixtureZotero`) has no PDFs
  - `assistant/memory.ts`: what the user asked Claude to remember (`assistantMemory` setting, tracked so it undoes): shown in every conversation's dynamic prompt, listed and edited in Settings → Claude; Claude saves them with `remember` / `forget`
  - `assistant/find.ts` (`find`: anything by name, so Claude gets ids) and `assistant/time-off.ts` (`take_time_off`: a fixed "Time off" block over each day's available hours, then the flexible work on those days moves to the first times `placementProblems` accepts; work that can't stays put and is reported)
  - `assistant/evals/`: typical requests sent to the real assistant on a fresh demo DB, checking the DB afterwards (`npm run eval:assistant` with `CLAUDE_CODE_OAUTH_TOKEN`, or `ENGRAM_EVAL_LOGIN=1` to use this Mac's Claude Code login). Not part of `npm test`; uses the user's plan, so run by hand after changing the prompt or tools
  - `assistant/conversations.ts`: conversations kept in the profile DB (`conversations` table: the panel's messages as JSON, the Agent SDK session to resume, whether it's an open tab). The renderer saves as they change (`conversations:save`) and restores open tabs at launch; History reopens or deletes them (`assistant:forget`). A saved session that's gone is replaced by a fresh one
  - `assistant/plan.ts`: plan import. Reads the proposal (textutil for Word/RTF, PDFKit via osascript for PDF) and asks Claude for sections and milestones as structured output; the user checks the draft before `applyPlan`
  - `tot.ts`: Tot sync (Phase 8). `RealTot` reads the UNI dot through Tot's URL scheme (`tot://N/content` via osascript, only while Tot runs, never launching it). It writes only when the user turns on writing back, through their shortcut with Tot's "Set Dot" action (`shortcuts run <name> -i <file>`), only to the dot that shortcut is set to, and every write is read back and checked (a mismatch turns writing off). Never write with the URL scheme's replace/append: it switches the dot to plain text (a monospaced font). Without the shortcut, sync is one-way (`readOnly` in `core/tot.ts`); `FileTot` is the demo's stand-in (`profiles/demo/tot-demo.txt`). `TotSync` runs every 20 s and shortly after todo-changing IPC calls (`TODO_CHANGES` in `ipc.ts`); `tot_links` holds each linked line's last-synced state
  - `attachments.ts`: files (Phase 8). Copies go in the profile's `files/` folder, named by id; the original is never touched. A file dropped in a chat is unfiled until Claude (`attach_file`) or the user places it
  - `documents.ts`: text from Word/RTF/Pages (textutil), PDF (PDFKit), Excel `.xlsx` (unzip + the sheets' XML; whole-number serials become dates and fractions times) and plain text, for plan import, attachments, briefs and lecture lists
  - `pdf-background.ts`: every stored PDF gets a white page baked in behind its content (a PDF has no paper colour of its own, so a transparent one is unreadable on a black GoodNotes whiteboard). Done in the background when a PDF arrives (`addFiles`, Moodle replacements), for PDFs already stored shortly after launch (`whitenStoredPdfs`), and awaited before a file is handed on (`readyAttachmentPath`: open, reveal, download, copy, drag). One filled rectangle is drawn first on each page and nothing else is touched; the catalogue key `EngramWhiteBackground` marks it done; an encrypted or unreadable file is left alone
  - `assistant/brief.ts`: Plan from brief: Claude suggests an assignment's details and stages from its brief; the user edits the draft before `applyBriefPlan` (re-planning keeps stages already started)
  - `google/`: Google Calendar push (Phase 9). `auth.ts` signs in (desktop loopback + PKCE, scope `calendar.app.created` only; the user's own OAuth client and the refresh token are kept encrypted via `secrets.ts`); `calendar.ts` has the REST client and the demo's `FileCalendar`; `sync.ts` (`GcalSync`) mirrors blocks and deadlines from 2 weeks back to 4 months ahead into Engram's own calendar, one way, shortly after any change (non-read IPC calls and `data:changed`) and every 5 minutes, recording each event in `gcal_events`
  - `stats.ts`: the Stats page's numbers
  - `updates.ts`: updates to the installed app (docs/ORIGINAL-SPEC.md §9). `scripts/release.ts` stages a build in `<userData>/updates/next/` (with `notes.json`: commit subjects since the installed build); this polls for it every 30 s (`update:changed`), and Restart to update (top bar, Settings → Updates) backs up, then hands over to `resources/update-swap.sh`, which waits for Engram to quit, swaps the app, keeps the replaced one in `updates/previous/` (Roll back) and reopens it. Builds carry `Resources/build.json` (`scripts/build-info.ts`; `core/update.ts`)
  - `backup.ts`: daily backups (SQLite online backup + records + files) to iCloud Drive by default, `<folder>/<profile>/<YYYY-MM-DD HHmm>/`, pruned by `core/backup.ts`; restoring backs up the current state first (`AppContext.restoreFrom`)
  - `secrets.ts`: `EncryptedJson`, small secrets encrypted with safeStorage in `<userData>/secrets/`
  - `tray.ts` (menu-bar timer: brain icon + elapsed time), `focus.ts` (runs the user's Focus shortcuts via `shortcuts run`), `shutdown.ts` (evening wrap-up), `term.ts` (exam-season reminder)
  - `records.ts`: Markdown record files (append-only; paths fixed in `records_index`)
  - `seed/demo-timetable.ts`: generates the fake UCL feed that the demo seed imports
  - `profile.ts`: demo/real paths
  - `app-context.ts`: opens the active profile's DB and handles switching and resetting
  - `db/`: Drizzle schema and the client
  - `repo.ts`: read queries
  - `seed/`: demo data
  - `ipc.ts`: handlers
- `src/preload/`: exposes the typed `window.api.invoke(channel, ...args)`, plus `on(event)`.
- `src/renderer/src/`: React UI.
  - `pages/registry.tsx`: rail entries and routes. Add a page here.
  - `pages/setup/`: the setup wizard (`/setup`). It opens by itself once per launch while the real profile isn't set up (`useOpenSetup` in `App.tsx`), and from Settings. Steps reuse Settings' own sections
  - `shell/`: the app frame
  - `theme/`: CSS tokens (the category palette is `shared/palette.ts`; stored colours from an older palette are moved by a migration, e.g. `drizzle/0025`)
  - `ui/`: shared controls. Right-click menus: `openContextMenu(e, entries)` from `ui/menuStore.ts` (items can `confirm` in the menu; errors become toasts), drawn by `ContextMenuHost`; `toast()` from `ui/toastStore.ts` (one at a time, optional Undo action); `askText()` from `ui/promptStore.ts` for a one-line answer. `ui/undoStore.ts` feeds the calendar toolbar's Undo button: every toast with an "Undo" action adds itself, as do calendar drags/resizes and new single events (`pushUndo`). Stores live in their own `.ts` files (fast refresh), and keep their names distinct from the components (`toastStore.ts`, not `toast.ts` next to `Toast.tsx`: the disk is case-insensitive). Calendar blocks get their menu from `calendar/blockMenu.ts` via `useBlockMenu`
  - Calendar bubbles show `Block.heading` (the module's name, or the assignment) and `Block.detail` (the lecture as "L12. Ion channels", "Write-up · L12", or the stage), filled in by `withDisplay` in `repo.ts`
  - Styling uses CSS Modules (`*.module.css`) plus the variables in `theme/tokens.css`.

### Rules and gotchas (keep following them)

- **Never commit secrets** (the timetable URL, OAuth tokens, Google credentials, the Moodle key). They go to the Keychain via Electron `safeStorage`, never into the repo, the DB or fixtures. The timetable link must never appear in settings, logs or error messages either.
- **Demo and real data never mix.** Data lives in `~/Library/Application Support/Engram/profiles/{demo,real}/`, and seeding or resetting only ever touches `demo`. `npm run dev` (and `npm run seed`) use `~/Library/Application Support/Engram Dev/` instead, so dev never opens the installed app's data, and dev makes no automatic backups; an explicit `--user-data-dir` wins.
- **The SQLite DB is the source of truth.** Record `.md` files are written by the app as append-only logs and are never parsed back.
- **Time:** store instants as UTC ISO strings, and do the maths in `Europe/London` with Temporal (`temporal-polyfill`). Weeks start on Monday and times use the 24h format.
- **Imports:** node-side code (main, preload, core, shared, scripts) uses relative imports. The renderer may use the `@renderer`, `@shared` and `@core` aliases.
- **FullCalendar v7** (`@fullcalendar/react/*` entrypoints, forma theme recoloured in `calendar/fc-theme.css`): there are no `fc-*` classes, so style events through `eventContent` and our own classes. The header toolbar is our own, driven by `useCalendarController`. Some options were renamed from v6 (e.g. `slotHeaderFormat`, `nonBusinessHoursClass`).
- **Scheduling:** all automatic placement goes through `core/scheduler.ts`, never the LLM. "No work before" is a hard limit. When nothing fits, placement may run past the end of the working day and into protected evenings, and the block gets an `attention` note (shown in red).
- **Timetable feed format** (checked against the real UCL feed): every event uses `TZID=Europe/London`. Cross-listed modules appear inside one SUMMARY as comma-separated names ("A, A, A" is collapsed by `collapseRepeatedName`; a list of different names stays one feed name). `[Viva]` events are cohort-wide viva sessions, so they become per-day deadlines, never blocks.
- **Write-up limit:** 3 *working* days (Monday to Friday) after the lecture (`writeUpLimit` in `core/scheduler.ts`); weekend days in between can hold a write-up but don't count.
- **Lecture list** (Modules page): one even row per lecture: name and time line (details on one line, hover actions clipped when narrow), Files, Write-up (attended blue, missed red, a red dot when the write-up needs a look, not for lectures before the start date), Notes and Flashcards ticks (`notes_at`, `flashcards_at`).
- **Session kinds** (`core/session-kinds.ts`): the feed calls some workshops and practicals [Lecture] (Investigative Methods), so a lecture row's kind (lecture, workshop, practical, other) is `lectures.kind` once the user confirms it, else guessed from its name. The Modules page lists each kind in its own section (Notes and Flashcards only for lectures), asks to confirm guesses, and asks per other session whether it gets a write-up (`no_write_up`). Labels are numbered per kind ("WS1", "P2"; other sessions have none) by `sessionInfo` in `timetable.ts`; `lectures.number` still runs through all of a module's sessions, because Claude's Organise refers to it. The feed's own [Practical]/[Workshop] events become rows (with write-ups) only where `modules.timetabled_sessions` is on; the module page asks once.
- **Write-up length** is stored per module as minutes per hour of lecture (default 60), scaled by `writeUpMinutesFor`.
- **Split lectures:** the feed gives a 2-hour slot as one event even when it holds two lectures; never merge feed events. A split part's feed events still point at the first part's block (`laterParts` in `reconcileTimetable`), so find a part's split by module and time (`splitEventsOf`).
- **One lecture across several sessions** (`lectures.continues_id`, `combineLectures`; in the UI "Merge with L4", i.e. `mergeWithPrevious`, and "Unmerge"): later sessions share the first's number ("part 2") and aren't counted; the first part gets one write-up after the last part, sized for all parts (`lectureGroups` in `timetable.ts`). The Modules page shows such a lecture as one row (the first session's date, "2 sessions · 3h in all", the times in its tooltip); `separateLecture` on the first session unmerges them all.
- **Repeating events** added by hand are series (`recurrences`), like weekly commitments: `createRecurringEvent` (or `createBlock` with `repeat`).
- **Typed briefs** are kept as `.txt` attachments (`addText`, `files:addText`), so everything that reads a brief works on them.
- **Start date:** lectures before it never get a write-up placed automatically; Engram's own untouched ones are removed when it's set. They show in the Backlog as unscheduled write-ups.
- **Migrations:** never let drizzle-kit rebuild a table that has `ON DELETE CASCADE` children. Its `DROP TABLE` runs inside the migrator's transaction, where `PRAGMA foreign_keys=OFF` has no effect, so it cascade-deletes the children. Hand-write a safe migration instead (see `drizzle/0006`). Before applying new migrations to an existing database, `openDatabase` keeps a copy as `app.db.before-update`.
- **UI controls:** use `ui/DateField` and `ui/TimeField`, never native `type="date"`/`"time"` inputs (they clash with the theme).
- **Testing the real app:** launch Electron with `--user-data-dir=<temp folder>` so automated runs never touch the user's demo data or clash with a copy they have open. Turn backups off first thing (`backup:set { enabled: false }`): the backup folder is the real iCloud one whatever the data folder, and the first backup runs a minute after launch. Set `ENGRAM_DOWNLOADS_DIR` to a temp folder too, so Save to Downloads (`files:download`) never writes to the real Downloads folder.
- **Prompts for the user's own Claude chat** (e.g. the debrief summary in `core/prompts.ts`) are only copied to the clipboard. The app never sends them anywhere.
- **Google Calendar** is one-way and only touches the calendar Engram created. Never ask for a broader scope than `calendar.app.created`. Events carry `extendedProperties.private.engram = <key>` so they can be found again; no reminders. Google sign-in needs the student's own Google Cloud app (see the feature map above). The original author's was published "In production" so sign-ins don't expire after 7 days; a new one in "Testing" mode expires every 7 days.
- **Tot sync** is deterministic code, never the LLM. Lines are `○ name` (open) and `● name` (ticked); Tot's other default bullet pairs work too. Never write to the real Tot dot through its URL scheme (it switches the dot to plain text); real writes go only through the user's "Set Dot" shortcut. Never launch Tot.
- **Files** dropped anywhere go through `files:add` (main copies them). Claude only uses a file's text to organise it (where it belongs, dates, structure). The one summary allowed is an assignment's `summary`: what the brief asks for (task, what to hand in, format, marking), never ideas, arguments, answers or a structure for the work (`summariseBrief` in `assistant/brief.ts`; Plan from brief, Moodle briefs and the assignment page's Summarise brief).
- **Dissertation assistant:** its conversation has the fixed id `dissertation` and lives on the Dissertation page, not in the side panel. Like everything else, it organises only and never writes dissertation content.
- **Assistant changes** go through tools that call domain code, wrapped by `ChangeTracker`. Tracked tables keyed by something other than `id` are listed in `KEY` in `changes.ts` (e.g. `lecture_splits.uid`, `moodle_items.key`). A new tool that changes data sets `mutates: true`; a new table the assistant can change goes in `TRACKED_TABLES`. Tool output is kept short (a long schedule fills the conversation): leave out defaults, same-day ends as HH:mm (`blockView`). A tool may be async (`organise_lectures`); `ChangeTracker.track` records its changes once it settles. Claude never places work that breaks `placementProblems`, with one exception: when the user explicitly asks for a write-up past its 3-working-day limit, `past_limit_requested` places it with a red `LATE_WRITE_UP_NOTE` (cleared by the next move).
- **Testing the assistant for real:** copy only `secrets/claude-token.bin` from the real data folder into the temp `--user-data-dir`.
- **Timer changes** from anywhere (IPC, menu bar, timeouts) go through `timerChanged` in `index.ts`, so the menu bar and Focus mode stay in step.
- **Packaging (Phase 10):** the Agent SDK's native `claude` binary and `resources/trayTemplate*.png` must stay outside the asar. Signing: this copy has no certificate configured, so `scripts/ensure-signed.cjs` (run by `npm run package`) signs ad hoc (fine on the Mac it's built on). The one side effect is that macOS may ask once after an update to let Engram use its saved secrets ("Engram Safe Storage"). The original author avoided this with a free Apple Development certificate made in Xcode (`identity: Apple Development` and `sign: scripts/sign-mac.cjs` in `electron-builder.yml`, see the comment there); offer that only if the prompts bother the student.
- **Updates (Phase 11, docs/ORIGINAL-SPEC.md §9):** the installed app never swaps itself without the user's click (a running timer is never cut off), and never edits its own code. Test the swap only against a copy outside `/Applications` (`ENGRAM_APP`, `ENGRAM_DATA_DIR`, `--user-data-dir`).
- **Deleting blocks** goes through `removeBlock` (`remove-block.ts`): a write-up sets `lectures.no_write_up` (never re-placed; Plan a write-up clears it), assignment work lowers its stage's estimate, a series occurrence is removed alone. `blocks:delete` tracks it with `ChangeTracker` so `blocks:undoDelete` can `revertChanges`.
- **Deleting timetabled events** hides their feed events (`timetable_events.hidden`), so re-imports leave them out; Settings → Timetable restores them. Never delete the event rows themselves.
- **Hand-edited blocks** (`detached`) are never moved by series edits or timetable re-imports.
- **Docs:** check the current docs for FullCalendar (v7), the Claude Agent SDK and other libraries before using their APIs.
- Prefer clarity over cleverness.
