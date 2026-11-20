> **About this file.** This is the original spec of the app, written by its first author for their
> own situation (a UCL neuroscience undergraduate with lectures, write-ups, a dissertation and a
> part-time job). It is kept because it explains **why** things work the way they do: the
> scheduling rules, the Claude assistant's limits, the sync designs, the update flow. It is **not**
> a list of requirements for this copy of the app. The requirements for this copy are in
> `MY-APP.md`. Wherever this file says "the user" it means the first author.

# Study Planner — Spec and Build Plan

A personal, standalone, dark-mode macOS app for planning and tracking university work (lectures and their write-ups, assignments, a dissertation and small todos) on one calendar, with a built-in Claude assistant for organisation and rescheduling.

- **Users:** one person, one Mac. Not distributed.
- **Core loop:** every piece of study work is a block on the calendar. Every block ends in an outcome (done / partial / skipped). Partial and skipped work feeds a reschedule queue the assistant can act on. Session logs and debriefs form the records the assistant reads to know what is and isn't done.
- **Assistant scope:** organisation only (planning, rescheduling, progress). It never produces coursework or dissertation content.

---

## 1. Tech stack (agreed)

| Concern | Choice |
| --- | --- |
| Shell | Electron (the Agent SDK needs Node, so no Tauri) |
| UI | React + TypeScript, Vite (e.g. electron-vite) |
| Calendar | FullCalendar (week default; day and month views) |
| Data | SQLite (e.g. better-sqlite3, optionally Drizzle) for structured data |
| Records | Markdown files per lecture / assignment / dissertation section, indexed in SQLite (human-readable, and easy for the assistant to read) |
| Icons | Lucide, outline style |
| Assistant | Claude Agent SDK (TypeScript), with in-process custom tools |
| Timetable parsing | An iCalendar parser (e.g. node-ical) |

Check current docs for FullCalendar, the Claude Agent SDK and any library before using them; don't rely on memory for their APIs.

---

## 2. Development data: demo mode (do this first)

Before any real information is imported, the app must run on **fake data** so the user can test everything.

- **Separate databases:** `demo.db` and `real.db` (plus separate records folders). Demo data must never leak into real data.
- **Demo mode is the default** during development and is clearly labelled in the UI (e.g. a small "Demo" badge in the top bar).
- **Seed script and in-app "Reset demo data"** action that regenerates everything from scratch.
- **Seed content should exercise every feature:**
  - 4 fictional modules with distinct colours, plus Social and Work categories.
  - A **fake timetable `.ics` fixture** that mimics the real UCL feed format (see §6.1), covering several weeks: lectures, practicals, workshops, a PBL session, an Assessment, a Viva, and some `[None]` events. Include a cross-listed module (same module under 3 names) to test merging.
  - Past weeks with sessions in all three outcomes (done / partial / skipped), so Backlog, Stats and the weekly total have content.
  - At least one partial block with a pending debrief, and one timed-out timer awaiting a check-in.
  - 2–3 assignments at different stages, with stages and back-scheduled blocks.
  - A fake dissertation plan (sections, milestones, a viva date), fake reading-list entries and a supervisor meeting with action items.
  - Small todos (some overdue, one recurring), and the recurring Saturday pub shift (17:00–00:00).
- **External integrations in demo mode use fakes/mocks:** the Tot adapter reads/writes a local fake "dot" text file; Google Calendar sync is off (or targets a throwaway test calendar); Zotero returns a fixture collection. The Claude assistant runs for real, but only against the demo database.
- Switching to real data happens in the **setup wizard** at the end of the build (§8).

---

## 3. UI structure and look

**Layout:** a narrow icon rail on the left; the calendar is the home screen.

- **Rail (top to bottom):** Calendar (home) · Modules · Assignments · Dissertation · Backlog · Stats · then, at the bottom, Notifications and Settings.
- **Home screen:**
  - **Top bar:** running timer (block name + elapsed), estimated work remaining today, study time this week against an optional target (right-click to add manual time).
  - **Left sidebar:** mini month with a faint band across the current week and dots on deadline days; a collapsible "Calendars" section of category toggles (collapsed by default); the small-todo list.
  - **Main:** FullCalendar week view.
  - **Claude panel:** on the right, toggled by a keyboard shortcut; it **pushes** the calendar narrower (no overlay).
- **Other pages:** Modules (list → module page), Assignments (list by due date → assignment page), Dissertation (plan, timeline, reading list, meetings + its own Claude panel), Backlog, Stats, Settings.
- **Notifications:** a small button that opens a list (pending debriefs, missed/overdue todos).

**Look (reference: Linear):**

- Dark mode only. Near-black neutral background, hairline borders, very little colour outside data.
- Colour = category: one colour per module (chosen in setup), plus Social and Work. Muted block fills with text in a lighter shade of the same hue.
- One blue accent for today/selection/focus. Red only for overdue.
- **Fixed events:** thicker border. **Flexible blocks:** filled, thin border. **Session type:** small Lucide icon inside the block (write-up, assignment, dissertation, etc.). No emoji anywhere.
- SF Pro or Inter, two weights, tabular figures for timers and durations. Compact density. Minimal motion (panel slide, drag feedback).

---

## 4. Domain model (sketch; refine as needed)

- **Category:** module | social | work. Name, short label, colour.
- **Module:** name(s) as they appear in the feed (several names can map to one module), short label, colour, write-up length (default 90 min), folder path on the Mac (link only; never scanned), assessment notes.
- **Block (calendar item):**
  - `kind`: fixed | flexible
  - `type`: lecture, practical, workshop, PBL, assessment, viva, write-up, assignment-stage, dissertation, meeting, pub-shift, social, other
  - start, end, category, linked entity (lecture / assignment stage / dissertation section / todo), source (timetable | user | auto | claude)
  - `outcome`: none | done | partial | skipped
- **Lecture:** module, timetable event, status (scheduled → attended → written up), linked write-up block, record file.
- **Session:** block (optional), start, end, duration, manual flag, linked entity, outcome, debrief text.
- **Assignment:** module, title, due datetime, weighting %, type, word limit, brief link, group flag, status (not started → in progress → submitted), stages[] (name, estimate, done, blocks).
- **Dissertation:** sections[] (status: not started → reading → drafting → drafted → revised; optional word count + target), milestones[] (date), viva date, reading items[] (from Zotero; status to read → read → notes done; linked sections), meetings[] (notes, action items → todos).
- **Todo:** title, done, archived, optional due date, optional linked entity, optional recurrence, source (tot | app | debrief), Tot line identity.
- **Settings:** availability rules (working hours, protected evenings, no-work-before), weekly target, timetable URL, Tot dot heading, Google calendar id, Zotero collection, etc.
- **Change log:** every mutation by the assistant is recorded with enough information to undo it.

---

## 5. Features

### 5.1 Calendar and planning

- Everything goes straight onto the calendar; there is no list-first planning step.
- Fixed events never move automatically. Flexible blocks can be dragged/resized or rescheduled by the assistant.
- **Block outcomes:** after a block ends it gets done / partial / skipped. Partial and skipped go to the reschedule queue (Backlog).
- **Availability rules** constrain all automatic placement.
- **Pub shift:** recurring fixed event, Saturdays 17:00–00:00 by default; editable per occurrence and as a series.
- **Deadlines:** in the all-day strip and as dots on the mini month.
- **Scheduling engine:** deterministic code (not the LLM) that finds free slots under the constraints. Both auto-scheduling and the assistant's tools use it. Unit-test it thoroughly.

### 5.2 Time tracking and debriefs

1. The timer starts from inside a flexible block.
2. When the planned length runs out, show **one** prompt: still working? (with an extend option).
3. No response → stop the timer; on next app use, trigger a Claude check-in, which lets the user correct the logged end time.
4. On stop, mark the outcome:
   - **Done:** optional one-line note, no questions.
   - **Partial:** Claude debrief: what was covered, what is left, anything to note. Loose ends may become todos, **only after the user approves**.
   - **Skipped:** no questions; goes to the reschedule queue.
5. The session and its debrief are appended to the linked entity's record file.

- **Weekly total:** top bar, Monday–Sunday, self-study only (time in timetabled teaching doesn't count), optional target ("14h / 20h").
- **Manual time:** right-click the weekly total to add time spent outside blocks, optionally tagged to an entity so it lands in that record.
- **Today header:** estimate remaining = today's unfinished blocks; working today and time without a break come from the timers.

### 5.3 Modules and lectures

- Lectures come from the timetable feed (§6.1).
- **Automatic write-up blocks** for **Lecture** events only (other types can get one added manually). They are placed on the same day as the lecture where free time allows, otherwise the next free slot, **no later than 3 days after**. Default length 90 min, editable per module. No day of the week is special.
- A lecture is "written up" when its write-up block is marked done.
- **Module page:** lecture list with statuses, progress bar, assessment info, link to the module folder, colour and write-up length.
- **Lecture record:** session logs and debrief notes.

- **Split lectures:** the UCL feed always shows a 2-hour slot as one event, but the module's own timetable spreadsheet sometimes has two different lectures (two topics) in that slot. On the module page the user can split a lecture into two: each half gets its own lecture number and its own write-up, sized to its length, and later lectures are renumbered. Merging the halves back undoes the split. A split is stored against the event's UID, so it survives timetable re-imports.
- **Modules with no lectures yet:** at the start, 3 modules have timetabled lectures and 3 are next term's, known only by name. Setup lets the user add a module by name alone (label and colour too), with no feed name mapped. It shows as "Next term", with no lectures and no write-ups. When its lectures appear in the feed, the new feed name is offered for mapping to that module, so nothing is created twice.
- **First start (setup):** none of the lectures before the start date are written up. Their write-ups are not placed on the calendar. Instead they all go to the Backlog as overdue write-ups, to schedule from there.

### 5.4 Assignments

- Record fields as in §4. Claude suggests a **stage breakdown** from the brief, which the user edits.
- **Back-scheduling:** stage blocks are planned backwards from the deadline, aiming to finish **2 days early**.
- Progress = stages done + time logged vs estimates. Status stops at "submitted" (no marks).
- Editable due dates; blocks reschedule to match. Group work is a flag only. No risk warnings.

### 5.5 Dissertation

- 3rd-year literature project (a literature review). Writing happens in Word, never in the app.
- **Plan import:** Claude converts a short project proposal (pasted or a file) into sections and milestones; the user checks them.
- Section status + optional hand-entered word counts. **Timeline** of milestones to submission and viva with today marked (the viva date comes from the timetable feed).
- **Reading list** from a chosen Zotero collection (Zotero 7 local API), linked to sections, with read status.
- **Supervisor meetings** with notes; action items become todos.
- Session logs through the same debrief mechanism.
- **Dissertation assistant:** a separate Claude instance on this page, organisation only.

### 5.6 Todos and Tot sync

- **Small todos** have no time slot and appear in the home sidebar. Anything with an estimate becomes a flexible block instead.
- Optional link, due date (overdue → Backlog + notifications), recurrence. Todos suggested from debriefs need approval.
- **Tot sync** (plain deterministic code; the LLM is never involved in sync):
  - The source is the Tot dot whose first line is `UNI`, found by scanning all 7 dots so moving it doesn't break anything. Tot must be running; use Tot's URL scheme (`tot://<n>/content`, `tot://<n>/replace?text=…`, append) via AppleScript/`osascript`, or its Shortcuts actions.
  - A todo = a smart-bullet (checkbox) line in that dot. **Verify how Tot stores these in raw text** (probably `- [ ]` / `- [x]`) before implementing.
  - New line in Tot → new todo (name only). New todo in the app → appended as a smart-bullet line (name only).
  - Ticked in Tot ↔ done in the app, in both directions.
  - A ticked line later deleted in Tot → the todo stays done. An **unticked** line deleted → the todo is archived (not done).
  - Behind an adapter interface so demo mode can use a fake text file.

### 5.6a Files and attachments (Phase 8)

- **Drag and drop** a file (PDF, Word, text, images, anything) onto the Claude panel, the dissertation assistant, or an item's page (assignment, module, dissertation section, supervisor meeting). Plan import's dialog accepts a dropped proposal too.
- **Storage:** Engram copies the file into the active profile's data folder (`profiles/{demo,real}/files/`), never into the repo, and records it in an `attachments` table (name, type, size, path, linked item, added at). The original file is left where it was. Demo and real files never mix.
- **Linking:** dropped on an item's page → linked to that item. Dropped in a chat → Claude reads it (same readers as plan import: textutil for Word/RTF, PDFKit for PDF, plain text) and links it to the item it belongs to with a new `attach_file` tool (`mutates: true`, tracked, shown and undoable like any other change). If it can't tell, it asks.
- **Use:** Claude uses a file's content only to organise, never to summarise it or write content from it. That includes:
  - where it belongs, and dates or deadlines it states (offered as changes to approve)
  - **assignment plans from a brief** (§5.4): from a dropped brief or marking criteria, Claude suggests the assignment's details (title, module, due date, word count or format) and a stage breakdown with estimates. Like plan import, it's a draft the user edits before anything is saved; then the stages back-schedule as usual. Also available as "Plan from brief" on a new or existing assignment.
  - later questions in context: an attached brief or rubric stays readable to Claude for that item (e.g. "how long should the methods stage be, given the brief?"), through a `read_attachment` tool that answers organisation questions only.
- **UI:** each item lists its attachments (open in the default app, reveal in Finder, rename, remove). Removing an attachment deletes Engram's copy only.

### 5.7 Claude assistant

- **Auth:** Claude Agent SDK using the user's own Claude plan via an OAuth token from `claude setup-token`, provided as `CLAUDE_CODE_OAUTH_TOKEN` (store it in the macOS Keychain, not in the repo). Make sure `ANTHROPIC_API_KEY` is **unset** in the app's environment, otherwise it will be used and billed instead. Personal use only.
- **Access:** read access to all data and records, plus the current screen context ("this module", "this week").
- **Tools (custom, in-process):** e.g. get_schedule, find_free_slots, move_block, create_block, mark_outcome, reschedule_queue_items, get_records, create_todo, update_assignment_stage, update_dissertation_section, undo_change. Tools call the same domain/scheduling code as the UI.
- **Approval rule:** **small changes (e.g. moving a single block) apply automatically**. Larger changes (several blocks, a day or week reshuffle) show a before/after preview on the calendar to accept or reject. Every change is logged and undoable.
- **Constraints it must respect:** fixed events, availability rules, pub shift, 2-day assignment buffer, 3-day write-up limit.
- **Check-ins:** partial-block debriefs, timed-out timer check-ins, and a **weekly review on Sunday** (hours vs target, what slipped, next week's load) delivered as a macOS notification. No daily/morning check-ins and **no unprompted suggestions**.

### 5.8 Backlog, notifications, stats

- **Backlog page:** overdue write-ups, partial/skipped blocks, overdue assignment stages and overdue todos across everything. Drag onto the calendar, or ask Claude to schedule them.
- **Notifications button:** pending debriefs, missed/overdue todos. macOS system notifications only for the Sunday review.
- **Stats page:** hours per module and per session type, weekly totals vs target, planned vs actual time, estimate accuracy.

---

### 5.9 Focus and revision tools (Phase 6.5)

- **Menu-bar timer:** a macOS tray item that shows the running block and its elapsed time, and can start the current or next block, stop it, or extend it. It uses the same session logic as the in-app timer.
- **Focus while a timer runs:** starting a timer turns on a chosen macOS Focus mode, and stopping it turns that mode off. This works through Shortcuts (the user makes "Engram Focus On"/"Off" shortcuts once; the app runs them with `shortcuts run`). It can be switched off in Settings.
- **Spaced repetition (experimental rail tab):**
  - Each lecture that is written up gets 20-minute guided review sessions at about +1, +3, +7, +21 and +60 days, placed by `core/scheduler.ts` as flexible blocks.
  - The tab shows what's due and overdue per module, a plan for the week, and each lecture's review history.
  - Each session has a short guided flow (recall, check, rate it easy/ok/hard). The rating stretches or shortens the next interval.
  - Each session gives a **copy-prompt** button for the user's existing Claude chat on that lecture. It is only copied to the clipboard and never sent.
  - Reviews happen in the user's main Claude app, where each lecture has its own chat inside a project per module. Engram only plans the sessions, tracks them and copies prompts. It never links to slides or opens files.
  - **Whole-module review prompt:** a button per module copies one prompt for a review across that module's project, focusing on lectures rated "hard". It is not scheduled for now.
  - **Confidence heatmap:** on the Modules page, each lecture is coloured by its latest review rating, so weak lectures stand out.
  - The feature should stay easy to remove: its own page in the registry, its own tables and its own scheduler entry.
- **Evening shutdown:** a one-click end-of-day view showing what's done today, what's left and what's unfinished. Unfinished work can go to the backlog or be rescheduled in one action, and tomorrow's first block is previewed.
- **Exam-season reminder:** once term 2 ends, a large animated button appears on the rail above Notifications and Settings, prompting the user to set up exam-season mode. Term 2's end is inferred from the timetable: the last lecture between January and June, followed by 14 days with no lectures. There is no term-dates setup. The button is hidden before then, and gone for good once exam-season mode exists (until then a demo toggle can simulate it).

## 6. Integrations

### 6.1 UCL timetable (iCalendar feed, inbound, polled)

- The feed URL is a **personal key**: store it in settings/Keychain, never in code, fixtures or git.
- Take only **time, module and event type** from each event.
- `SUMMARY` format: `<Module name> Level <n> [<Event type>]`. Take the type from the **bracket**, because `CATEGORIES` is sometimes `None`.
- There are no module codes, so identify modules by name. Cross-listed modules (e.g. the same project module under Neuroscience / Pharmacology / Physiology names) are merged into one module in setup.
- Types seen: Lecture, Practical, Workshop, Presentation, Assessment, Problem Based Learning, Viva, None. Hide `None` events by default. Add Assessment and Viva events to deadlines automatically.
- Re-imports must be idempotent (key on the event UID) and must not clobber user changes to derived blocks.

### 6.2 Google Calendar (outbound only)

- Push via the Google Calendar API into a dedicated "Planner" calendar, updated within seconds of a change. It is one-way: all editing happens in the app. Needs a Google Cloud OAuth client (desktop app flow). Apple Calendar is not touched.

### 6.3 Zotero

- Zotero 7 local API; read one chosen collection for the dissertation reading list.

### 6.4 Backup

- Automatic periodic backups of the database and records folder (e.g. to iCloud Drive), with retention.

---

## 7. Parked (do not build now)

- Exam period mode (switching from write-ups to revision). The user will design it after term 2; Phase 6.5 only adds the reminder.
- Live self-modification: the in-app Claude adding features without a restart (e.g. a watched plugin folder + hot reload, changes on a git branch). **Design the architecture so this stays possible later**, e.g. a clear module/plugin boundary for UI panels and tools. Updates to the packaged app come from Claude Code chats in the repo instead (§9).

**Decided against:** term-dates setup, assignment risk warnings, mark tracking, missed-lecture status, "open folder" buttons on blocks, daily/morning check-ins, unprompted suggestions, scanning module folders.

---

## 8. Build plan (phases)

Work one phase at a time. At the end of each phase: the app runs, the user can test it on demo data, and the work is committed. Stop and check in with the user between phases.

| Phase | Goal | Done when |
| --- | --- | --- |
| 0 | Scaffold: Electron + Vite + React + TS, SQLite, dark theme tokens, app shell (rail, top bar, sidebar, empty pages), demo/real DB separation, seed + reset | App launches into the shell on seeded demo data with the "Demo" badge |
| 1 | Calendar: FullCalendar week/day/month, fixed vs flexible styling, type icons, categories + collapsible toggles, mini month with week band + deadline dots, drag/resize, availability rules, recurring pub shift | Seed data displays correctly; blocks can be moved and persist |
| 2 | Timetable import + modules: ICS parser against the fake fixture, module mapping/merging, write-up auto-scheduler (same day → ≤3 days), module pages | Importing the fixture produces correct lectures and write-up blocks; scheduler unit tests pass |
| 3 | Time tracking: timers in blocks, timeout prompt + extend, outcomes, records files, weekly total + target, manual time, today header | A full session cycle works end to end and lands in the record |
| 4 | Assignments: records, stages, back-scheduling with 2-day buffer, progress, editable due dates | Demo assignments schedule and reschedule correctly |
| 5 | Backlog, small todos (app-side), notifications list | Overdue/partial items appear and can be scheduled |
| 6 | Claude assistant: Agent SDK + auth, tools, panel with screen context, small-vs-large change rule with preview, change log + undo, debriefs, timed-out check-ins, Sunday review notification | "Skip the L7 write-up tonight" reschedules correctly and can be undone |
| 6.5 | Focus and revision tools (§5.9): menu-bar timer, Focus mode during timers, spaced-repetition tab with 20-min guided sessions and copy-prompts, module review prompt, confidence heatmap, evening shutdown, post-term-2 exam-season reminder | Timer controllable from the menu bar; reviews schedule after a write-up and reschedule from ratings; reminder appears only after the inferred term end |
| 7 | Dissertation: plan import via Claude, sections, timeline, meetings, Zotero adapter (fixture in demo), dissertation assistant | Demo dissertation fully navigable |
| 8 | Tot sync: verify raw format, adapter (fake file in demo, real Tot behind a setting), sync rules from §5.6. Files and attachments (§5.6a): drag and drop into chats and item pages, copies in the profile's data folder, Claude links files to the right item and plans assignments from a brief | Round-trip tests pass against the fake adapter; manual test with real Tot; a file dropped in the chat ends up attached to the right assignment and can be undone; a dropped brief produces an editable assignment plan |
| 9 | Google Calendar push, stats page, backups | Planner calendar mirrors the app; stats render |
| 10 | Setup wizard + switch to real data: modules (labels, merges, colours, write-up lengths, folders) → availability + pub shift → timetable URL → Tot dot → Google (move the Google Cloud OAuth app from Testing to In production: homepage + privacy pages) → Zotero → Claude sign-in → weekly target; lectures before the start date go to the Backlog as unwritten write-ups | User completes setup and works on `real.db`; demo still available |
| 11 | Packaging and updates (§9): `/Applications/Engram.app` signed with a self-signed certificate, `npm run release`, Restart to update, Roll back, dev on its own data folder | A change made in a Claude Code chat reaches the installed app through `npm run release` and Restart to update, with no Keychain or permission prompts and no reinstall by hand; Roll back restores the previous version |

**Working rules:**

- Start in plan mode: read this document, propose the project structure and the Phase 0 plan, and ask about anything ambiguous before writing code.
- Keep scheduling, ICS parsing and Tot sync logic as pure, unit-tested modules, separate from the UI.
- Never commit secrets (timetable URL, OAuth tokens, Google credentials); add a `.gitignore` early.
- Prefer clarity over cleverness. This is a personal app that will be extended later, partly by Claude itself.

---

## 9. Packaging and updates (Phase 11)

Engram keeps being changed in Claude Code chats in the repo. The installed app updates itself from local builds; it never edits its own code (an in-app developer mode was decided against: it would rebuild Claude Code inside Engram, and the assistant reads untrusted text such as Moodle posts and briefs, which must never reach a shell).

- **Dev and the installed app never share data.** `npm run dev` uses its own data folder (`~/Library/Application Support/Engram Dev`, which gets the Claude sign-in copied across once), so it never opens the real `real.db` or runs Tot, Google, Moodle syncs and backups a second time. The installed app keeps `~/Library/Application Support/Engram`.
- **Stable signature.** Signed with a certificate, not ad hoc, so Automation permissions (Tot, Shortcuts) survive updates. The Keychain needs a Team ID as well: with the self-signed "Engram Local" certificate it trusts each build's exact hash, so every update asks for "Engram Safe Storage" once. A free Apple Development certificate (Xcode → Settings → Accounts with an Apple ID; lasts a year) has a Team ID and ends the prompt; Engram is signed with one. No paid Apple Developer account, notarisation or electron-updater: the app is built on this Mac, so Gatekeeper doesn't block it.
- **`npm run release`:** typecheck and tests (nothing is installed if they fail), `electron-vite build`, `electron-builder --dir`, sign, then stage the new app in `<data folder>/updates/next/`; if Engram is closed it's installed straight away. Refuses uncommitted changes (another chat may be mid-change) unless `-- --dirty`. A chat can run it at the end of its work.
- **Restart to update:** Engram notices the staged app (checked every 30 s) and shows "Restart to update" in the top bar and Settings → Updates, with what's new (the commits since the installed build); it never swaps by itself, so a running timer is never cut off. On click it takes a backup (`backup.ts`), quits, and a small detached helper (`resources/update-swap.sh`) moves the new app into `/Applications`, keeps the old one in `updates/previous/` (not in `/Applications`, so there's never a second Engram there), and reopens it.
- **Roll back** (Settings → Updates): swaps the previous app back in (and again to return). Data stays as it is; migrations may have run on the newer version, so if the old one misbehaves, restore the backup taken before the update (Settings → Backups).
- **The first time:** the Engram installed before this was built can't restart into an update; quit it and run `npm run release -- --install`. After that, updates go through Restart to update.
- **Later, optional:** a "Request a change" box that copies a ready prompt for a Claude Code chat to the clipboard (like the other copy-prompts), or adds it to an inbox file.
