import { useCallback, useRef, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router'
import {
  ArrowUpToLine,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderSearch,
  CalendarDays,
  CircleCheck,
  CircleExclamationPoint,
  CircleSlash,
  FileText,
  Layers,
  Merge,
  NotebookPen,
  Pencil,
  Scissors,
  Unlink,
  ListOrdered,
  Presentation,
  Lock,
  Settings2,
  Sparkles,
  Square,
  Tags,
  Shapes,
  MoreHorizontal
} from 'lucide-react'
import type { Lecture, ModuleDetail, MoodleFile, MoodleFileGroup } from '@shared/types'
import { formatClock, minutesBetween, zoned } from '@core/time'
import { KIND_NAME, SESSION_KINDS, sessionLine, type SessionKind } from '@core/session-kinds'
import { call } from '../../lib/api'
import { useNow } from '../../lib/useNow'
import { copyFile, dragFile, saveToDownloads } from '../../lib/download'
import {
  errorMessage,
  useAssistantStatus,
  useFeedNames,
  useModule,
  useModules
} from '../../lib/queries'
import { TimeField } from '../../ui/TimeField'
import { Popover } from '../../ui/Popover'
import { useAssistantScreen } from '../../assistant/store'
import { Attachments } from '../../ui/Attachments'
import { openContextMenu } from '../../ui/menuStore'
import { askText } from '../../ui/promptStore'
import { toast } from '../../ui/toastStore'
import { LectureListDialog } from './LectureListDialog'
import { ModuleSettingsPanel } from './ModuleSettingsPanel'
import { TimetableNamesPanel } from './TimetableNamesPanel'
import m from './Modules.module.css'

const LAST_KEY = 'modules.lastTab'
const STATUS_LABEL: Record<Lecture['status'], string> = {
  scheduled: 'Scheduled',
  attended: 'Attended',
  missed: 'Missed',
  'written-up': 'Written up'
}

const CONFIDENCE_LABEL = { easy: 'easy', ok: 'OK', hard: 'hard' } as const

const SECTION_TITLE: Record<SessionKind, string> = {
  lecture: 'Lectures',
  workshop: 'Workshops',
  practical: 'Practicals',
  other: 'Other sessions'
}

/** A session in a sentence: "WS1", or an other session's name. */
const nameOf = (l: Lecture) => l.label || (l.topic ? `“${l.topic}”` : 'this session')

/** 180 → "3h", 90 → "1.5h", 45 → "45m". */
const hours = (minutes: number) => (minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`)

const shortDate = (iso: string) =>
  zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

/**
 * Modules: one tab per module across the top; the selected module's lectures fill the page.
 * Settings and the timetable-name mapping open in side panels when needed.
 */
export function ModulesPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: modules = [] } = useModules()
  const { data: feedNames = [] } = useFeedNames()
  const [panel, setPanel] = useState<'settings' | 'names' | null>(null)
  const [listFor, setListFor] = useState<{ id: string; label: string } | null>(null)

  let remembered: string | null = null
  try {
    remembered = localStorage.getItem(LAST_KEY)
  } catch {
    // Storage unavailable: start on the first module.
  }
  const selected =
    modules.find((x) => x.id === id) ?? modules.find((x) => x.id === remembered) ?? modules[0]
  const unmapped = feedNames.filter((f) => f.moduleId === null && !f.hiddenOnly).length
  useAssistantScreen({ moduleId: selected?.id })

  const choose = (moduleId: string) => {
    try {
      localStorage.setItem(LAST_KEY, moduleId)
    } catch {
      // Not essential.
    }
    navigate(`/modules/${moduleId}`)
  }

  return (
    <div className={m.page}>
      <header className={m.tabsBar}>
        <nav className={m.tabs} role="tablist" aria-label="Modules">
          {modules.map((mod) => (
            <button
              key={mod.id}
              role="tab"
              aria-selected={mod.id === selected?.id}
              className={`cat ${m.tab}`}
              style={{ '--cat': mod.colour } as CSSProperties}
              title={`${mod.name} (${mod.shortLabel})`}
              onClick={() => choose(mod.id)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { heading: mod.name },
                  {
                    label: 'Rename…',
                    icon: Pencil,
                    onSelect: () => renameModule(mod, qc)
                  },
                  {
                    label: 'Settings…',
                    icon: Settings2,
                    hint: 'colour, write-ups, folder',
                    onSelect: () => {
                      choose(mod.id)
                      setPanel('settings')
                    }
                  },
                  {
                    label: 'Lecture list…',
                    icon: ListOrdered,
                    onSelect: () => setListFor({ id: mod.id, label: mod.shortLabel })
                  },
                  {
                    label: 'Organise with Claude',
                    icon: Sparkles,
                    onSelect: async () => {
                      choose(mod.id)
                      toast(`Organising ${mod.name} with Claude…`, { ms: 60_000 })
                      await call('lectures:organise', mod.id)
                      await qc.invalidateQueries()
                      toast(`${mod.name}: lectures organised.`)
                    }
                  },
                  'separator',
                  {
                    label: 'Timetable names…',
                    icon: Tags,
                    onSelect: () => setPanel('names')
                  }
                ])
              }
            >
              <span className={m.dot} />
              <span className={m.tabName}>{mod.name}</span>
            </button>
          ))}
        </nav>
        <span className={m.spacer} />
        <button
          className={`${m.toolButton} ${m.withIcon}`}
          onClick={() => setPanel('names')}
          title="Map timetable names to modules"
          aria-label="Timetable names"
        >
          <Tags size={14} /> <span className={m.toolLabel}>Timetable names</span>
          {unmapped > 0 && (
            <span className={m.alert} title={`${unmapped} not mapped`}>
              <CircleExclamationPoint size={12} /> {unmapped}
            </span>
          )}
        </button>
        {selected && (
          <button
            className={`${m.toolButton} ${m.withIcon}`}
            onClick={() => setListFor({ id: selected.id, label: selected.shortLabel })}
            title="Upload the lecture list to split 2-hour slots holding two lectures"
            aria-label="Lecture list"
          >
            <ListOrdered size={14} /> <span className={m.toolLabel}>Lecture list</span>
          </button>
        )}
        {selected && (
          <button
            className={m.iconButton}
            onClick={() => setPanel('settings')}
            title={`${selected.shortLabel} settings`}
            aria-label={`${selected.shortLabel} settings`}
          >
            <Settings2 size={16} />
          </button>
        )}
      </header>

      {selected ? (
        <ModuleView moduleId={selected.id} panel={panel} onClosePanel={() => setPanel(null)} />
      ) : (
        <p className={m.empty}>No modules yet. Map a timetable name to create one.</p>
      )}

      {panel === 'names' && <TimetableNamesPanel onClose={() => setPanel(null)} />}
      {listFor && (
        <LectureListDialog
          moduleId={listFor.id}
          moduleLabel={listFor.label}
          onClose={() => setListFor(null)}
        />
      )}
    </div>
  )
}

function ModuleView({
  moduleId,
  panel,
  onClosePanel
}: {
  moduleId: string
  panel: 'settings' | 'names' | null
  onClosePanel: () => void
}) {
  const { data: mod } = useModule(moduleId)
  const { data: moodle = [] } = useQuery({
    queryKey: ['files', 'moodle', moduleId],
    queryFn: () => call('moodle:moduleFiles', moduleId)
  })
  const qc = useQueryClient()
  const { data: organised } = useQuery({
    queryKey: ['organise', moduleId],
    queryFn: () => call('lectures:organiseStatus', moduleId)
  })
  const { data: claude } = useAssistantStatus()
  const [reviewing, setReviewing] = useState(false)
  const [organising, setOrganising] = useState(false)
  const [organiseError, setOrganiseError] = useState<string | null>(null)
  const dismissSplits = async () => {
    await call('lectures:dismissSplits', moduleId)
    await qc.invalidateQueries({ queryKey: ['organise', moduleId] })
  }
  const organise = async () => {
    setOrganising(true)
    setOrganiseError(null)
    try {
      await call('lectures:organise', moduleId)
      await qc.invalidateQueries()
    } catch (e) {
      setOrganiseError(errorMessage(e))
    } finally {
      setOrganising(false)
    }
  }
  if (!mod) return null
  const moodleIds = new Set(moodle.flatMap((g) => g.files.map((f) => f.id)))
  // The latest week with a lecture so far: its Moodle files open by default.
  const thisWeek = mod.lectures.filter((l) => l.status !== 'scheduled').at(-1)?.week ?? null
  return (
    <div className={`cat ${m.content}`} style={{ '--cat': mod.colour } as CSSProperties}>
      <div className={m.columns}>
        <div className={m.mainColumn}>
          <Summary mod={mod} />
          <div className={m.organise}>
            <button
              className={`${m.toolButton} ${m.withIcon}`}
              disabled={!organising && (!claude?.hasToken || mod.lectures.length === 0)}
              title={
                organising
                  ? 'Stop: nothing is changed'
                  : claude?.hasToken
                    ? 'Claude names the lectures, tags their slides and spots slots holding two lectures, from the timetable, the lecture list and Moodle'
                    : 'Add your Claude token in Settings first'
              }
              onClick={() =>
                organising ? void call('lectures:stopOrganise', moduleId) : void organise()
              }
            >
              {organising ? (
                <>
                  <Square size={11} /> Organising… Stop
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Organise with Claude
                </>
              )}
            </button>
            <span className={m.muted}>
              {!mod.autoOrganise
                ? 'Automatic organising is off for this module (module settings). Names and slides are yours.'
                : organised
                  ? `Last organised ${shortDate(organised.at)}, ${formatClock(organised.at)}${organised.listName ? `, with “${organised.listName}”` : ''}. Names you give and files you place stay as you set them.`
                  : 'After each Moodle sync, Claude names the lectures and tags their slides. Names you give and files you place stay as you set them.'}
            </span>
          </div>
          {organiseError && <p className={m.splitError}>{organiseError}</p>}
          {organised &&
            (organised.splits.length > 0 || (organised.continuations ?? []).length > 0) &&
            !organised.splitsDismissed && (
              <div className={m.banner}>
                <ListOrdered size={15} />
                <div className={m.grow}>
                  {organised.splits.length > 0 && (
                    <div className={m.bannerLine}>
                      <span className={m.grow}>
                        Claude thinks {organised.splits.length} timetable slot
                        {organised.splits.length === 1 ? ' holds' : 's hold'} more than one lecture.
                      </span>
                      <button className={m.toolButton} onClick={() => setReviewing(true)}>
                        Review
                      </button>
                    </div>
                  )}
                  {(organised.continuations ?? [])
                    .filter((c) => mod.lectures.some((l) => l.id === c.lectureId && !l.part))
                    .map((c) => (
                      <div key={c.lectureId} className={m.bannerLine}>
                        <span className={m.grow}>
                          L{c.number} looks like the rest of L{c.firstNumber}: make them one
                          lecture, with one write-up after both?
                        </span>
                        <button
                          className={m.toolButton}
                          onClick={() =>
                            void call('lectures:combine', c.lectureId, c.firstId).then(() =>
                              qc.invalidateQueries()
                            )
                          }
                        >
                          Combine
                        </button>
                      </div>
                    ))}
                </div>
                <button className={m.toolButton} onClick={() => void dismissSplits()}>
                  Dismiss
                </button>
              </div>
            )}
          {reviewing && organised && (
            <LectureListDialog
              moduleId={mod.id}
              moduleLabel={mod.shortLabel}
              suggested={organised.splits}
              onApplied={() => void dismissSplits()}
              onClose={() => setReviewing(false)}
            />
          )}
          {mod.timetabledSessions === null && mod.timetabledSessionCount > 0 && (
            <TimetabledSessionsBanner mod={mod} />
          )}
          <SessionSections mod={mod} moodle={moodle} />
        </div>
        <aside className={m.sideColumn}>
          {moodle.length > 0 && (
            <details className={m.fileSection} open>
              <summary className={m.filesTitle}>
                From Moodle{' '}
                <span className={`${m.muted} num`}>
                  · {moodle.reduce((n, g) => n + g.files.length, 0)}
                </span>
              </summary>
              <div className={m.moodle}>
                {moodle.map((g) => (
                  <details key={g.section} className={m.moodleGroup} open={g.week === thisWeek}>
                    <summary>
                      <span className={m.grow}>{g.section}</span>
                      <span className={`${m.muted} num`}>
                        {g.files.length} file{g.files.length === 1 ? '' : 's'}
                      </span>
                    </summary>
                    <ul>
                      {g.files.map((f) => (
                        <li
                          key={f.id}
                          className={m.moodleFileRow}
                          onContextMenu={(e) =>
                            openContextMenu(e, [
                              { heading: f.name },
                              {
                                label: 'Open',
                                icon: ExternalLink,
                                onSelect: () => call('files:open', f.id)
                              },
                              {
                                label: 'Save to Downloads',
                                icon: Download,
                                onSelect: () => saveToDownloads(f.id)
                              },
                              {
                                label: 'Copy',
                                icon: Copy,
                                onSelect: () => copyFile(f.id, f.name)
                              },
                              {
                                label: 'Show in Finder',
                                icon: FolderSearch,
                                onSelect: () => call('files:reveal', f.id)
                              },
                              'separator',
                              { heading: 'Slides for' },
                              ...mod.lectures
                                .filter((l) => !l.part || l.part.index === 1)
                                .filter((l) => g.week === null || l.week === g.week)
                                .map((l) => ({
                                  label: sessionLine(l.label, l.topic),
                                  icon: l.id === f.lectureId ? Check : undefined,
                                  onSelect: () =>
                                    call('files:setLecture', f.id, l.id).then(() =>
                                      qc.invalidateQueries()
                                    )
                                })),
                              {
                                label: g.week ? `Just week ${g.week}` : 'No lecture',
                                icon: f.lectureId ? undefined : Check,
                                onSelect: () =>
                                  call('files:setLecture', f.id, null).then(() =>
                                    qc.invalidateQueries()
                                  )
                              }
                            ])
                          }
                        >
                          <button
                            className={m.moodleFile}
                            title={`Open ${f.name} (or drag it out)`}
                            draggable
                            onDragStart={(e) => dragFile(e, f.id)}
                            onClick={() => void call('files:open', f.id)}
                          >
                            <FileText size={14} /> {f.name}
                          </button>
                          <SaveButton id={f.id} name={f.name} />
                          <CopyButton id={f.id} name={f.name} />
                          <FileLecture file={f} lectures={mod.lectures} week={g.week} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </details>
          )}
          <details className={m.fileSection} open>
            <summary className={m.filesTitle}>My files</summary>
            <Attachments
              target={{ type: 'module', id: mod.id }}
              list={{
                // Keyed on Moodle's files too: a sync that adds some must refilter this list.
                key: ['files', 'module', mod.id, 'own', [...moodleIds].sort().join(',')],
                fetch: async () =>
                  (await call('files:list', { type: 'module', id: mod.id })).filter(
                    (a) => !moodleIds.has(a.id)
                  )
              }}
              hint="Drop your own files here: notes, handbook, past papers…"
            />
          </details>
        </aside>
      </div>
      {panel === 'settings' && (
        <ModuleSettingsPanel key={JSON.stringify(mod)} mod={mod} onClose={onClosePanel} />
      )}
    </div>
  )
}

/**
 * The module's sessions, one section per kind (lectures, workshops, practicals, other
 * sessions), each with the columns that fit it. A module with only lectures shows one list,
 * as before. Kinds guessed from names wait for the user to confirm them.
 */
function SessionSections({ mod, moodle }: { mod: ModuleDetail; moodle: MoodleFileGroup[] }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const rows = mod.lectures.filter((l) => !l.part || l.part.index === 1)
  const kinds = SESSION_KINDS.filter((k) => rows.some((l) => l.kind === k))
  const onlyLectures = kinds.every((k) => k === 'lecture')
  const confirm = async (kind: SessionKind) => {
    setBusy(true)
    try {
      await call('lectures:confirmKinds', mod.id, kind)
      await qc.invalidateQueries()
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {(kinds.length ? kinds : (['lecture'] as const)).map((kind) => {
        const list = rows.filter((l) => l.kind === kind)
        const guesses = list.filter((l) => !l.kindConfirmed && kind !== 'lecture')
        const full = kind === 'lecture'
        const title = SECTION_TITLE[kind]
        return (
          <section key={kind} className={m.sessionSection}>
            {!onlyLectures && (
              <h2 className={m.sectionTitle}>
                {title} <span className={`${m.muted} num`}>· {list.length}</span>
              </h2>
            )}
            {guesses.length > 0 && (
              <div className={m.banner}>
                <Shapes size={15} />
                {kind === 'other' ? (
                  <span className={m.grow}>
                    {guesses.length === 1 ? 'This session doesn’t' : 'These sessions don’t'} look
                    like lectures, workshops or practicals, going by{' '}
                    {guesses.length === 1 ? 'its name' : 'their names'}. For each one, say whether
                    it gets a write-up, or click its “Other session?” tag if it’s something else.
                  </span>
                ) : (
                  <>
                    <span className={m.grow}>
                      {guesses.length === 1
                        ? `One session looks like a ${KIND_NAME[kind].toLowerCase()}`
                        : `${guesses.length} sessions look like ${title.toLowerCase()}`}
                      , going by {guesses.length === 1 ? 'its name' : 'their names'}. Is that right?
                      Click the tag on any that isn’t.
                    </span>
                    <button
                      className={m.toolButton}
                      disabled={busy}
                      onClick={() => void confirm(kind)}
                    >
                      {guesses.length === 1 ? 'Yes' : 'All correct'}
                    </button>
                  </>
                )}
              </div>
            )}
            <div
              className={m.lectureList}
              role="table"
              aria-label={`${mod.shortLabel} ${title.toLowerCase()}`}
              data-cols={full ? undefined : 'short'}
            >
              <div className={m.listHead} role="row">
                <span role="columnheader" className={m.spanTwo}>
                  {kind === 'other' ? 'Session' : KIND_NAME[kind]}
                </span>
                <span role="columnheader">Files</span>
                <span role="columnheader">Write-up</span>
                {full && (
                  <>
                    <span role="columnheader" className={m.center}>
                      Notes
                    </span>
                    <span role="columnheader" className={m.center}>
                      Flashcards
                    </span>
                  </>
                )}
                <span role="columnheader" aria-label="Actions" />
              </div>
              {list.map((l) => (
                <LectureRow
                  key={l.id}
                  lecture={l}
                  lectures={mod.lectures}
                  full={full}
                  slides={moodle.flatMap((g) => g.files.filter((f) => f.lectureId === l.id))}
                  weekFiles={
                    moodle.find((g) => g.week === l.week)?.files.filter((f) => !f.lectureId) ?? []
                  }
                />
              ))}
              {rows.length === 0 && (
                <p className={m.empty}>No lectures in the timetable for this module.</p>
              )}
            </div>
          </section>
        )
      })}
    </>
  )
}

/** The timetable has practicals or workshops for this module: ask once whether to list them. */
function TimetabledSessionsBanner({ mod }: { mod: ModuleDetail }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const answer = async (list: boolean) => {
    setBusy(true)
    try {
      await call('modules:update', mod.id, { timetabledSessions: list })
      await qc.invalidateQueries()
    } catch (e) {
      toast(errorMessage(e), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const n = mod.timetabledSessionCount
  return (
    <div className={m.banner}>
      <Shapes size={15} />
      <span className={m.grow}>
        The timetable also has {n} practical{n === 1 ? '' : 's'} or workshop{n === 1 ? '' : 's'} for
        this module. List {n === 1 ? 'it' : 'them'} here, with write-ups?
      </span>
      <button className={m.toolButton} disabled={busy} onClick={() => void answer(true)}>
        List {n === 1 ? 'it' : 'them'}
      </button>
      <button className={m.toolButton} disabled={busy} onClick={() => void answer(false)}>
        Not here
      </button>
    </div>
  )
}

/** The module's assessments from the timetable (exams, in-class tests): click to see one. */
function Assessments({ mod }: { mod: ModuleDetail }) {
  const navigate = useNavigate()
  const nowMs = useNow().epochMilliseconds
  const now = new Date(nowMs).toISOString()
  return (
    <div className={m.assessments}>
      <span className={m.muted}>Assessment{mod.assessments.length === 1 ? '' : 's'}:</span>
      {mod.assessments.map((a) => {
        const past = a.end < now
        const days = Math.round((Date.parse(a.start) - nowMs) / 86_400_000)
        return (
          <button
            key={a.blockId}
            className={m.assessment}
            data-past={past || undefined}
            title="Show on the calendar"
            onClick={() => navigate(`/?block=${a.blockId}`)}
          >
            <CalendarDays size={12} />
            <span className="num">
              {shortDate(a.start)}, {formatClock(a.start)}–{formatClock(a.end)}
            </span>
            {!past && (
              <span className={m.muted}>
                {days <= 0
                  ? 'today'
                  : days === 1
                    ? 'tomorrow'
                    : days < 14
                      ? `in ${days} days`
                      : `in ${Math.round(days / 7)} weeks`}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Ask for a module's new name (the short label is in its settings). */
async function renameModule(mod: { id: string; name: string }, qc: QueryClient) {
  const name = await askText({
    title: 'Rename module',
    initial: mod.name,
    placeholder: 'e.g. Neural Basis of Motivation and Learning',
    note: 'The short label (e.g. NEUR) is in the module’s settings.'
  })
  if (name === null || !name.trim() || name.trim() === mod.name) return
  try {
    await call('modules:update', mod.id, { name })
    await qc.invalidateQueries()
    toast(`Renamed to “${name.trim()}”.`)
  } catch (e) {
    toast(errorMessage(e), { tone: 'error' })
  }
}

function Summary({ mod }: { mod: ModuleDetail }) {
  const qc = useQueryClient()
  // Notes and flashcards are for lectures only (not workshops, practicals or other sessions).
  const lectures = mod.lectures.filter((l) => l.kind === 'lecture')
  const lecturesSoFar = lectures.filter((l) => l.status !== 'scheduled').length
  const flashcards = lectures.filter((l) => l.flashcards).length
  const notes = lectures.filter((l) => l.notes).length
  const writtenPct = mod.lecturesSoFar ? (mod.writtenUp / mod.lecturesSoFar) * 100 : 0
  return (
    <section className={m.summary}>
      <h1 className={m.title}>
        <button
          className={m.titleButton}
          title="Click to rename"
          onClick={() => void renameModule(mod, qc)}
        >
          {mod.name}
          <Pencil size={14} className={m.titlePencil} />
        </button>
      </h1>
      <div className={m.stats}>
        <span>
          <strong className="num">
            {mod.writtenUp}/{mod.lecturesSoFar}
          </strong>{' '}
          written up
        </span>
        {lectures.length > 0 && (
          <>
            <span>
              <strong className="num">
                {notes}/{lecturesSoFar}
              </strong>{' '}
              with notes
            </span>
            <span>
              <strong className="num">
                {flashcards}/{lecturesSoFar}
              </strong>{' '}
              with flashcards
            </span>
          </>
        )}
        <span>
          <strong className="num">
            {mod.lectures.filter((l) => l.status === 'scheduled').length}
          </strong>{' '}
          still to come
        </span>
      </div>
      <div className={m.bars}>
        <div className={m.bar} title="Written up">
          <div className={m.fill} style={{ width: `${writtenPct}%` }} />
        </div>
      </div>
      {mod.assessments.length > 0 && <Assessments mod={mod} />}
      {mod.lectures.some((l) => l.confidence) && (
        <div className={m.legend} aria-label="Confidence from reviews">
          <span className={m.muted}>Last review:</span>
          {(['easy', 'ok', 'hard'] as const).map((c) => (
            <span key={c} className={m.legendItem}>
              <span className={m.legendSwatch} data-confidence={c} /> {CONFIDENCE_LABEL[c]}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function LectureRow({
  lecture: l,
  lectures,
  slides,
  weekFiles,
  full
}: {
  lecture: Lecture
  lectures: Lecture[]
  slides: MoodleFile[]
  weekFiles: MoodleFile[]
  /** A lecture: it has Notes and Flashcards columns (other kinds don't). */
  full: boolean
}) {
  const [naming, setNaming] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await qc.invalidateQueries()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const length = minutesBetween(l.start, l.end)
  const writeUp = l.writeUp
    ? `Write-up ${shortDate(l.writeUp.start)}, ${formatClock(l.writeUp.start)}–${formatClock(l.writeUp.end)}${
        l.writeUp.outcome !== 'none' ? ` · ${l.writeUp.outcome}` : ''
      }${l.writeUp.attention ? `\n${l.writeUp.attention}` : ''}`
    : l.noWriteUp
      ? 'No write-up: you deleted it (right-click → Plan a write-up)'
      : l.beforeStart
        ? 'Before your start date: no write-up planned (it’s in the Backlog)'
        : 'No write-up slot was found within 3 working days'
  // Red dot: the write-up wasn't placed, or was placed somewhere that needs a look.
  const needsAttention =
    l.beforeStart || l.noWriteUp ? !!l.writeUp?.attention : !l.writeUp || !!l.writeUp.attention

  const toggle = async (what: 'flashcards' | 'notes') => {
    setBusy(true)
    try {
      await call(what === 'notes' ? 'lectures:setNotes' : 'lectures:setFlashcards', l.id, !l[what])
      await qc.invalidateQueries({ queryKey: ['module'] })
    } finally {
      setBusy(false)
    }
  }

  // A lecture across several sessions: its sessions in order (this row is the first).
  const sessions = l.part
    ? lectures.filter((x) => x.part?.firstId === l.id).sort((a, b) => a.part!.index - b.part!.index)
    : [l]
  const prev = previousOf(l, lectures)
  const guessed = !l.kindConfirmed && l.kind !== 'lecture'
  // An other session the user hasn't been asked about yet: is it one, and a write-up or not?
  const askOther = guessed && l.kind === 'other'
  const setKind = (kind: SessionKind | null) => change(() => call('lectures:setKind', l.id, kind))
  const answerOther = (writeUp: boolean) =>
    change(async () => {
      await call('lectures:setKind', l.id, 'other')
      if (writeUp === l.noWriteUp) await call('lectures:setNoWriteUp', l.id, !writeUp)
    })
  const kindEntries = [
    { heading: guessed ? 'What is it? (guessed from its name)' : 'What is it?' },
    ...SESSION_KINDS.map((k) => ({
      label: KIND_NAME[k],
      icon: k === l.kind ? Check : undefined,
      hint: k === l.kind ? (l.kindConfirmed ? undefined : 'guess') : undefined,
      onSelect: () => setKind(k)
    })),
    l.kindConfirmed && {
      label: 'Guess from its name',
      icon: Shapes,
      onSelect: () => setKind(null)
    }
  ]

  const menu = (e: Parameters<typeof openContextMenu>[0]) =>
    openContextMenu(e, [
      { heading: sessionLine(l.label, l.topic) },
      {
        label: l.topic ? 'Rename…' : 'Name…',
        icon: Pencil,
        onSelect: () => setNaming(true)
      },
      {
        label: 'Show on calendar',
        icon: CalendarDays,
        onSelect: () => navigate(`/?block=${l.blockId}`)
      },
      l.noWriteUp && {
        label: 'Plan a write-up',
        icon: CalendarDays,
        onSelect: () => change(() => call('lectures:setNoWriteUp', l.id, false))
      },
      l.writeUp && {
        label: 'Show write-up on calendar',
        icon: CalendarDays,
        onSelect: () => navigate(`/?block=${l.writeUp!.id}`)
      },
      'separator',
      prev && {
        label: `Merge with ${prev.label || prev.topic || 'the session before'}`,
        hint: 'same lecture',
        icon: ArrowUpToLine,
        onSelect: () => change(() => call('lectures:mergeWithPrevious', l.id))
      },
      sessions.length > 1 && {
        label: 'Unmerge sessions',
        icon: Unlink,
        onSelect: () => change(() => call('lectures:separate', l.id))
      },
      l.canSplit && {
        label: 'Split into two lectures…',
        icon: Scissors,
        onSelect: () => setSplitting(true)
      },
      l.splitPart && {
        label: 'Join split lectures',
        icon: Merge,
        onSelect: () => change(() => call('lectures:join', l.id))
      },
      'separator',
      (l.status === 'attended' || l.status === 'missed') && {
        label: l.status === 'attended' ? 'I didn’t go' : 'I went after all',
        icon: l.status === 'attended' ? CircleSlash : CircleCheck,
        onSelect: () => change(() => call('lectures:setAttended', l.id, l.status === 'missed'))
      },
      full && {
        label: l.notes ? 'Notes not made' : 'Notes made',
        icon: NotebookPen,
        onSelect: () => toggle('notes')
      },
      full && {
        label: l.flashcards ? 'Flashcards not made' : 'Flashcards made',
        icon: Layers,
        onSelect: () => toggle('flashcards')
      },
      'separator',
      ...kindEntries
    ])

  return (
    <div className={m.lectureRow} role="row" data-status={l.status} onContextMenu={menu}>
      <span
        className={`${m.lectureNo} num`}
        data-confidence={(l.label && l.confidence) || undefined}
        title={
          l.label && l.confidence ? `Last review: ${CONFIDENCE_LABEL[l.confidence]}` : undefined
        }
      >
        {/* Other sessions have no number. */}
        {l.label || <span className={m.muted}>–</span>}
      </span>
      <span className={m.whenCell}>
        {(l.topic || naming) && <LectureName lecture={l} editing={naming} setEditing={setNaming} />}
        <span className={`${m.when} num`} data-under-topic={l.topic ? true : undefined}>
          <span className={m.nowrap}>
            {shortDate(l.start)}, {formatClock(l.start)}
            <span className={m.muted}> · {length >= 60 ? `${length / 60}h` : `${length}m`}</span>
          </span>
          {guessed && (
            <button
              className={m.guessTag}
              title={`Guessed from its name: is it a ${KIND_NAME[l.kind].toLowerCase()}? Click to say what it is.`}
              onClick={(e) => openContextMenu(e, kindEntries)}
            >
              {KIND_NAME[l.kind]}?
            </button>
          )}
          {l.splitPart && (
            <span
              className={m.tag}
              title="One timetable slot holding more than one lecture, split into lectures. Join (hover or right-click) makes it one again."
            >
              Split
            </span>
          )}
          {sessions.length > 1 && (
            <span
              className={m.partNote}
              title={sessions
                .map(
                  (x) =>
                    `${shortDate(x.start)}, ${formatClock(x.start)} · ${hours(minutesBetween(x.start, x.end))}`
                )
                .join('\n')}
            >
              {sessions.length} sessions · {hours(l.part!.totalMinutes)} in all
            </span>
          )}
          {sessions.length > 1 && (
            <button
              className={`${m.splitLink} ${m.splitHover}`}
              disabled={busy}
              title="These sessions aren’t one lecture: make each its own again, with its own write-up"
              onClick={() => void change(() => call('lectures:separate', l.id))}
            >
              <Unlink size={11} /> Unmerge
            </button>
          )}
          {prev && (
            <button
              className={`${m.splitLink} ${m.splitHover}`}
              disabled={busy}
              title={`This session is the rest of ${sessionLine(prev.label, prev.topic)}: make them one, with one write-up after both`}
              onClick={() => void change(() => call('lectures:mergeWithPrevious', l.id))}
            >
              <ArrowUpToLine size={11} /> Merge with {prev.label || 'previous'}
            </button>
          )}
          {l.splitPart && (
            <button
              className={`${m.splitLink} ${m.splitHover}`}
              disabled={busy}
              title="Join the split lectures back into one"
              onClick={() => void change(() => call('lectures:join', l.id))}
            >
              <Merge size={11} /> Join
            </button>
          )}
          {!l.topic && !naming && (
            <button
              className={`${m.splitLink} ${m.splitHover}`}
              title="Name this lecture"
              onClick={() => setNaming(true)}
            >
              Name…
            </button>
          )}
          {l.canSplit && (
            <SplitButton
              lecture={l}
              disabled={busy}
              open={splitting}
              setOpen={setSplitting}
              onSplit={(cuts) => void change(() => call('lectures:split', l.id, cuts))}
            />
          )}
          {error && <span className={m.splitError}>{error}</span>}
        </span>
      </span>
      <span className={m.filesCell}>
        {slides.length + weekFiles.length > 0 && (
          <LectureFiles week={l.week} slides={slides} weekFiles={weekFiles} />
        )}
      </span>
      <span>
        {askOther ? (
          <span className={m.ask} role="group" aria-label={`Write-up for ${nameOf(l)}?`}>
            <button
              className={m.askButton}
              disabled={busy}
              title="It’s an other session (not a lecture, workshop or practical) and gets a write-up"
              onClick={() => void answerOther(true)}
            >
              Write-up
            </button>
            <button
              className={m.askButton}
              disabled={busy}
              title="It’s an other session and needs no write-up"
              onClick={() => void answerOther(false)}
            >
              None
            </button>
          </span>
        ) : l.kind === 'other' && l.noWriteUp && !l.writeUp ? (
          <span
            className={m.muted}
            title="No write-up for this session (right-click → Plan a write-up)"
          >
            No write-up
          </span>
        ) : l.status === 'attended' || l.status === 'missed' ? (
          <button
            className={m.status}
            data-status={l.status}
            data-attention={needsAttention || undefined}
            data-tip={`${writeUp}\n${l.status === 'attended' ? 'Click if you didn’t go.' : 'Click if you went after all.'}`}
            disabled={busy}
            aria-label={`${STATUS_LABEL[l.status]}. ${writeUp}. ${l.status === 'attended' ? 'Mark as not attended' : 'Mark as attended'}`}
            onClick={() =>
              void change(() => call('lectures:setAttended', l.id, l.status === 'missed'))
            }
          >
            {STATUS_LABEL[l.status]}
          </button>
        ) : (
          <span
            className={m.status}
            data-status={l.status}
            data-attention={needsAttention || undefined}
            data-tip={writeUp}
            tabIndex={0}
            aria-label={`${STATUS_LABEL[l.status]}. ${writeUp}`}
          >
            {STATUS_LABEL[l.status]}
          </span>
        )}
      </span>
      {full && (
        <>
          <span className={m.center}>
            <input
              type="checkbox"
              className={m.check}
              checked={l.notes}
              disabled={busy}
              aria-label={`Notes made for ${nameOf(l)}`}
              onChange={() => void toggle('notes')}
            />
          </span>
          <span className={m.center}>
            <input
              type="checkbox"
              className={m.check}
              checked={l.flashcards}
              disabled={busy}
              aria-label={`Flashcards made for ${nameOf(l)}`}
              onChange={() => void toggle('flashcards')}
            />
          </span>
        </>
      )}
      <span className={m.center}>
        <button
          className={m.moreButton}
          aria-label={`Actions for ${nameOf(l)}`}
          title="Rename, merge, split, what it is…"
          onClick={(e) => {
            // Open under the button (also when it's pressed with the keyboard).
            const r = e.currentTarget.getBoundingClientRect()
            menu({
              clientX: r.left,
              clientY: r.bottom + 4,
              preventDefault: () => e.preventDefault(),
              stopPropagation: () => e.stopPropagation()
            })
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      </span>
    </div>
  )
}

/** Save a copy of a file to the Downloads folder (shows on hover). */
function SaveButton({ id, name, onSaved }: { id: string; name: string; onSaved?: () => void }) {
  return (
    <button
      className={m.saveFile}
      title="Save to Downloads"
      aria-label={`Save ${name} to Downloads`}
      onClick={() => {
        onSaved?.()
        void saveToDownloads(id)
      }}
    >
      <Download size={13} />
    </button>
  )
}

/** Put a file on the clipboard (shows on hover, like Save). */
function CopyButton({ id, name, onCopied }: { id: string; name: string; onCopied?: () => void }) {
  return (
    <button
      className={m.saveFile}
      title="Copy"
      aria-label={`Copy ${name}`}
      onClick={() => {
        onCopied?.()
        void copyFile(id, name)
      }}
    >
      <Copy size={13} />
    </button>
  )
}

/** The lecture's slides from Moodle, and that week's other files (handouts, readings). */
function LectureFiles({
  week,
  slides,
  weekFiles
}: {
  week: number
  slides: MoodleFile[]
  weekFiles: MoodleFile[]
}) {
  const [open, setOpen] = useState(false)
  const item = (f: MoodleFile) => (
    <span key={f.id} className={m.moodleFileRow}>
      <button
        role="menuitem"
        className={m.moodleFile}
        title={`Open ${f.name} (or drag it out)`}
        draggable
        onDragStart={(e) => dragFile(e, f.id)}
        onClick={() => {
          setOpen(false)
          void call('files:open', f.id)
        }}
      >
        <FileText size={14} /> {f.name}
      </button>
      <SaveButton id={f.id} name={f.name} onSaved={() => setOpen(false)} />
      <CopyButton id={f.id} name={f.name} onCopied={() => setOpen(false)} />
    </span>
  )
  return (
    <span
      className={m.weekFiles}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <button
        className={m.splitLink}
        data-slides={slides.length > 0 || undefined}
        aria-expanded={open}
        title={
          slides.length
            ? 'This lecture’s slides from Moodle (and the week’s other files)'
            : `Week ${week} files from Moodle`
        }
        onClick={() => setOpen((o) => !o)}
      >
        {slides.length ? (
          <>
            <Presentation size={12} /> Slides
          </>
        ) : (
          <>
            <FileText size={12} /> {weekFiles.length}
          </>
        )}
      </button>
      {open && (
        <span className={m.weekFilesMenu} role="menu" aria-label={`Week ${week} files`}>
          {slides.length > 0 && <span className={m.menuHeading}>Slides</span>}
          {slides.map(item)}
          {weekFiles.length > 0 && slides.length > 0 && (
            <span className={m.menuHeading}>Also in week {week}</span>
          )}
          {weekFiles.map(item)}
        </span>
      )}
    </span>
  )
}

/**
 * The lecture's name: click to rename. A name you give is locked (Claude leaves it alone);
 * clearing it hands the lecture back to Claude.
 */
function LectureName({
  lecture: l,
  editing,
  setEditing
}: {
  lecture: Lecture
  editing: boolean
  setEditing: (on: boolean) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState(l.topic ?? '')
  const save = async () => {
    setEditing(false)
    const name = text.trim()
    if (name === (l.topic ?? '') && (l.topicLocked || !name)) return
    await call('lectures:rename', l.id, name || null)
    await qc.invalidateQueries()
  }
  if (editing)
    return (
      <input
        className={m.nameInput}
        value={text}
        autoFocus
        placeholder="Lecture name (empty: let Claude name it)"
        aria-label={`Name of ${nameOf(l)}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(l.topic ?? '')
            setEditing(false)
          }
        }}
      />
    )
  return (
    <button
      className={m.topic}
      title={`${l.topic}${l.topicLocked ? ' (named by you)' : ''} · click to rename`}
      onClick={() => {
        setText(l.topic ?? '')
        setEditing(true)
      }}
    >
      <span className={m.topicText}>{l.topic}</span>
      {l.topicLocked && <Lock size={10} className={m.lock} />}
    </button>
  )
}

/** Split a long lecture at a time you choose (half way by default). */
function SplitButton({
  lecture: l,
  disabled,
  open,
  setOpen,
  onSplit
}: {
  lecture: Lecture
  disabled: boolean
  open: boolean
  setOpen: (open: boolean | ((o: boolean) => boolean)) => void
  onSplit: (cuts: number[]) => void
}) {
  const start = zoned(l.start)
  const length = minutesBetween(l.start, l.end)
  const half = start.add({ minutes: Math.round(length / 2 / 5) * 5 })
  const fmt = (z: typeof start) =>
    `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`
  const [at, setAt] = useState(fmt(half))
  const [h, mm] = at.split(':').map(Number)
  const cut = h * 60 + mm - (start.hour * 60 + start.minute)
  const ok = cut >= 15 && cut <= length - 15
  const button = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [setOpen])
  // The popover goes over the page: the row's time line is one clipped line, so a popover
  // inside it would be cut off (and the button can be clipped too when opened from the menu).
  return (
    <>
      <button
        ref={button}
        className={`${m.splitLink} ${m.splitHover}`}
        disabled={disabled}
        aria-expanded={open}
        title="Two lectures in one timetable slot: make each its own lecture, with its own write-up"
        onClick={() => setOpen((o) => !o)}
      >
        Split…
      </button>
      {open && (
        <Popover anchor={button} onClose={close} ariaLabel={`Split ${nameOf(l)}`}>
          <span className={m.muted}>Second lecture starts at</span>
          <TimeField value={at} onChange={setAt} ariaLabel="Second lecture starts at" step={5} />
          <button
            className={m.toolButton}
            disabled={!ok}
            onClick={() => {
              setOpen(false)
              onSplit([cut])
            }}
          >
            Split
          </button>
          <button className={m.toolButton} onClick={close}>
            Cancel
          </button>
        </Popover>
      )}
    </>
  )
}

/** Which lecture a Moodle file is the slides for (your choice is kept). */
function FileLecture({
  file,
  lectures,
  week
}: {
  file: MoodleFile
  lectures: Lecture[]
  week: number | null
}) {
  const qc = useQueryClient()
  // That week's lectures first, then the rest; a merged lecture once (its first session).
  const sorted = lectures
    .filter((l) => !l.part || l.part.index === 1)
    .sort((a, b) => Number(b.week === week) - Number(a.week === week) || a.number - b.number)
  return (
    <select
      className={m.fileLecture}
      aria-label={`Lecture for ${file.name}`}
      value={file.lectureId ?? ''}
      onChange={(e) =>
        void call('files:setLecture', file.id, e.target.value || null).then(() =>
          qc.invalidateQueries()
        )
      }
    >
      <option value="">{week ? `Just week ${week}` : 'Not a lecture’s'}</option>
      {sorted.map((l) => (
        <option key={l.id} value={l.id}>
          {sessionLine(l.label, l.topic)}
        </option>
      ))}
    </select>
  )
}

/**
 * The lecture just before this one (its first session, for a lecture across several), to
 * merge with: the same rule as `previousLecture` in the main process.
 */
function previousOf(l: Lecture, lectures: Lecture[]): Lecture | null {
  const before = lectures
    .filter((x) => x.start < l.start && (x.part?.firstId ?? x.id) !== l.id)
    .sort((a, b) => a.start.localeCompare(b.start))
  const last = before[before.length - 1]
  if (!last) return null
  const rootId = last.part?.firstId ?? last.id
  return lectures.find((x) => x.id === rootId) ?? last
}
