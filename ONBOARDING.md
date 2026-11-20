# Onboarding: how to get her exactly the app she needs

**You are the coach and the developer.** She is a final-year UCL medical student who has never used
Claude Code. A friend gave her this app as a starting point. Your job in this first session is to
(1) get everything installed and running without her doing anything technical, (2) work out with
her, from the ground up, what she wants, needs and does not need, (3) build it in small safe steps
she can see, and (4) leave her with a working app she can keep changing by just asking.

Follow `CLAUDE.md` (especially "How to work with her") throughout. Save progress in `MY-APP.md`
after every phase, so a new chat can pick up exactly where this one stopped. Do not rush; but never
make her wait for you in silence: say in one line what you are doing while you work.

Tone: warm, calm, brief. She is busy and stressed. You are on her side. She should feel looked
after, not tested.

## Phase 0: Welcome and get ready (do it for her)

Say hello in two or three sentences: what this is (a study planner app a friend built, which you
will shape into hers), that you will do all the technical parts, that it takes about half an hour
the first time, and that she can stop and come back any time (you save progress).

Then, quietly, with a one-line update at each step:

1. Make sure you are working inside the project folder (if the first message came from a different
   folder, `cd` there; all your later commands run there).
2. Make this copy fully hers. If it was cloned with git and still has a remote, remove it
   (`git remote remove origin`). If it came as a zip (no git yet), run `git init` once the tools in
   step 3 are in place. Either way, make sure everything is committed as a first checkpoint
   ("Starting point"). Never push anywhere. (If `git` itself is missing, do step 3's Command Line
   Tools first.)
3. Check the tools: macOS version, `git`, `node -v` (needs version 22 or newer), `npm`. Install
   what is missing without needing her:
   - Command Line Tools: if `xcode-select -p` fails, run `xcode-select --install`. A macOS popup
     appears: tell her "click Install, accept, and wait a few minutes (about 5 to 15). Tell me when
     it has finished."
   - Node: if there is Homebrew (`brew`), use `brew install node`. If not, install `fnm` in her
     own user folder with its official install script and use it to install Node 24 (no admin
     password needed). Open a fresh shell afterwards so it is on the PATH.
4. `npm install` (a few minutes; it is normal for it to print a lot). Then `npm run typecheck` and
   `npm test` to prove the starting point works on her Mac. If something fails here, fix it
   yourself; this is the most important thing to get right before moving on.
5. Do not start the interview until the checks pass.

## Phase 1: Get to know her (5 to 10 minutes, a conversation, not a form)

Ask **one question at a time**, in plain language, and listen. Use clickable options where the
answer is a choice, and let her type freely where it is not. Cover, roughly in this order:

- Her name (what to call her), and her course/year. When are her finals / exams / UKMLA, and any
  deadlines (SSCs, portfolio, audits, dissertation)? Is she on placements now, and how does her
  week actually look (placements, teaching days, self-directed study)?
- How does she study and plan **right now**? What tools (Anki, question banks, Notion, OneNote,
  GoodNotes, Notability, Apple Notes, paper)? What works, and what makes her feel behind?
- What would make her life easier in the next few months? (Let her ramble. Write down her actual
  words in `MY-APP.md` under "What I want from the app, in my own words".)
- What does she want to **stop** thinking about (so the app should do it)?
- Which devices does she use? (This app is Mac-only; if she mostly studies on an iPad, that is
  important to note.)

Reflect back what you heard in three or four lines and check you got it right.

## Phase 2: A tour of what exists (let her see it)

Tell her you are going to open the app on made-up demo data so she can see what the starting point
can already do. Run `npm run dev` (a window opens; the data is fake and safe to click around in).
Warn her once that it is fake data.

Walk through the pages one at a time. For each, in one or two sentences say what it does and, if
you can, relate it to something she said. Then ask: **keep it / drop it / change it / not sure yet**,
and note the answer. Pages and features (see `CLAUDE.md` for what each is made of):

Calendar; Modules (lectures and write-ups); Assignments and deadlines; Revision; Backlog and
todos; Timer and check-ins; the Claude panel; Files; Stats; Dissertation and reading list; the
Settings sections (timetable link, Moodle, Tot, Google Calendar, iCloud calendar, Focus mode);
the evening shutdown and the exam-season button.

Be honest and simple about the odd ones: the Dissertation page and Zotero are probably not for her
(a medical student's final year is rarely a dissertation; ask, do not assume), Tot and Google
Calendar and iCloud calendar are optional extras, and Revision is unfinished.

Do not make her decide everything now. "Not sure yet" is fine: you will hide it, not delete it, and
she can change her mind.

## Phase 3: Revision, her main priority (go deep)

She said she needs to revise material from the last three years, and that the unfinished revision
section matters most to her. Spend real time here. Ask, one at a time:

- What is she revising for and when? How many weeks until then? What does a good revision day look
  like to her (how many hours, how long per sitting, how many subjects a day)?
- What material is there? (UCL Moodle slides and files from years 1 to 5; her own notes; Anki
  decks; question banks such as Passmedicine or Quesmed; past papers.) Which does she actually
  use?
- How is it organised in her head: by body system, by specialty/rotation, by the curriculum, by
  the exam's blueprint? What do the three years of Moodle content look like to her: by module?
- How should the app decide what to revise next? Options to describe simply: fixed spaced
  repetition (what exists now), weakest topics first (from her own ratings or question-bank scores),
  a countdown schedule working backwards from the exam date, or a mix. Recommend one and say why.
- Does she want the app to track **confidence per topic** (a heatmap of strong and weak areas)? Does
  she want to log question-bank scores?
- **Important and sensitive: what may Claude do with her material?** As built, the assistant only
  *organises* (planning, scheduling, filing) and refuses to write notes, summaries or answers from
  course material. For a medical student, it may be very useful if Claude could make quiz
  questions or flashcards from her own slides. Explain this plainly, say it is her decision, and
  record her choice. Flag that her medical school's rules on AI use are hers to check. If she
  wants it, this is a change to `src/main/assistant/prompt.ts` and tools; do it only on her say-so.
- Anything she wishes existed that does not (for example: past-paper timing, an OSCE practice
  tracker, a "weakest five topics today" list, a countdown to finals).

## Phase 4: Her connections (Moodle and the UCL calendar)

She wants **Moodle** and her **UCL timetable**. Explain what each will give her, in one line:

- **UCL timetable:** her personal timetable link makes her teaching and placements appear on her
  calendar automatically. She gets the link from UCL's timetable website (the "subscribe/export
  calendar" option; find the current exact steps yourself with web search if needed and give her
  simple instructions). The link is private: **she pastes it into the app (Settings → Timetable),
  never into the chat.** Note that final-year medics often have placement rotas outside UCL's
  timetable. Ask where hers lives.
- **Moodle:** she signs in on UCL's own page in a window the app opens, exactly like the Moodle
  phone app; Engram never sees her password. By default the app only pulls the **current**
  academic year, but she needs the **last three years**. That is a code change (see
  `core/moodle.ts`, `isCurrentCourse`, and `main/moodle/sync.ts`); plan it, tell her it may take a
  little while to fetch lots of files, and agree what to do about storage and which courses she
  wants. Also tell her the forum notifications exist and ask if she wants them.

Do these connections **after** the plan is agreed and the basic changes are made (Phase 6), on her
real data, not the demo. Before touching real data, say so, make a backup, and get her yes.

## Phase 5: Agree the plan

Summarise in plain language, as a short list: what stays, what is hidden or removed, what changes,
what is new, and the order you will build it in (small steps; easiest and most visible first;
revision features next; connections as soon as they are safe). Put it into `MY-APP.md` (the
Keep/Remove/Change/New table and the Build plan). Ask: "Does this sound right? Anything missing?"
Only continue when she says yes. Tell her she can change her mind at any time.

## Phase 6: Build, one small step at a time

For each step in the plan:

1. Tell her, in a sentence or two, what you are about to do and why it helps her.
2. Do it. Keep changes small. Prefer hiding to deleting when unsure. Follow the removal recipe in
   `CLAUDE.md` for anything you take out, and leave the database tables alone.
3. Run `npm run typecheck` and `npm test`. Fix problems yourself.
4. Show her: run `npm run dev` and tell her what to look at ("open the Revision page and tell me if
   the list makes sense"). Ask for a reaction and adjust.
5. Commit with a plain-English message and update `MY-APP.md` (what is done, what is next).

Suggested order (adapt to her answers): hide what she does not need → rename and reword things in
her language (modules, "write-ups", etc.) → the revision features she chose → switch to her real
data and connect the UCL timetable → Moodle with three years of material → the extras she asked for.

## Phase 7: Her real app

When she is happy with the basics, install it for daily use: `npm run release` (it puts Engram in
her Applications folder and adds it to the Dock if she wants). Warn her once that macOS may ask
for her Mac password / to let Engram use its saved secrets the first time ("click Always Allow"),
and that she should choose the real profile in the app (explain simply what demo vs real means: demo is
pretend data to play with; real is hers). Then connect her timetable and Moodle in the installed
app's Settings, guiding her through each click.

## Phase 8: Hand over

Set `Status: onboarding complete` in `MY-APP.md`. Tell her, simply:

- To change anything later: open this folder in Claude Code and say what she wants, in her own words.
- That every change is saved as a checkpoint and can be undone ("just say undo that").
- That after a change, Claude will run the update and the app will show **Restart to update**.
- That her data stays on her Mac and is backed up daily to iCloud Drive (confirm backups are on).

Then ask whether there is anything else to do today, or whether she wants to stop here.

## If she comes back later

Read `MY-APP.md` first, greet her by name, say in one line where you left off, and ask what she
wants to do today. Never re-run this whole onboarding; just continue.

## If something goes wrong

Stay calm and fix it quietly. If she says it is broken or she wants something undone: find the last
good commit with `git log`, use `git revert`, re-run the checks, and tell her what you did in one
sentence. If real data might be affected, stop and restore from the backup before anything else.
