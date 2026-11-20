import { useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Check, CircleExclamationPoint, ListOrdered, Settings2, Tags, X } from 'lucide-react'
import type { CommitmentInput, ModuleWithDetails } from '@shared/types'
import { Temporal } from 'temporal-polyfill'
import { TZ } from '@core/time'
import { call } from '../../lib/api'
import {
  errorMessage,
  useFeedNames,
  useLastImport,
  useModule,
  useModules,
  useProfile,
  useSwitchProfile
} from '../../lib/queries'
import { DateField } from '../../ui/DateField'
import { TimeField } from '../../ui/TimeField'
import { AvailabilitySection } from '../AvailabilitySection'
import { ClaudeSection } from '../ClaudeSection'
import { GoogleSection } from '../GoogleSection'
import { MoodleSection } from '../MoodleSection'
import { TotSection } from '../TotSection'
import { LectureListDialog } from '../modules/LectureListDialog'
import { ModuleSettingsPanel } from '../modules/ModuleSettingsPanel'
import { TimetableNamesPanel } from '../modules/TimetableNamesPanel'
import p from '../Page.module.css'
import w from './Setup.module.css'

/**
 * The setup wizard (Phase 10): moves the user onto their real data. It opens by itself when
 * the real profile hasn't been set up, and from Settings any time later. Every step saves as
 * it goes, so it can be left and picked up again; steps that Settings already has reuse
 * Settings' own sections.
 */
const STEPS = [
  { id: 'start', label: 'Start date' },
  { id: 'timetable', label: 'Timetable' },
  { id: 'modules', label: 'Modules' },
  { id: 'week', label: 'Your week' },
  { id: 'tot', label: 'Tot' },
  { id: 'google', label: 'Google Calendar' },
  { id: 'zotero', label: 'Zotero and dissertation' },
  { id: 'claude', label: 'Claude' },
  { id: 'finish', label: 'Finish' }
] as const
type StepId = (typeof STEPS)[number]['id']

const useSetup = () => useQuery({ queryKey: ['setup'], queryFn: () => call('setup:get') })
const useFeedStatus = () =>
  useQuery({ queryKey: ['feedStatus'], queryFn: () => call('feed:status') })

export function SetupPage() {
  const { data: profile } = useProfile()
  const { data: setup } = useSetup()
  const qc = useQueryClient()
  const [step, setStep] = useState<StepId>('start')
  const index = STEPS.findIndex((s) => s.id === step)
  // Steps that are really done get a tick (not just the ones you've been past).
  const { data: feed } = useFeedStatus()
  const { data: modules = [] } = useModules()
  const { data: feedNames = [] } = useFeedNames()
  const { data: claude } = useQuery({
    queryKey: ['assistantStatus'],
    queryFn: () => call('assistant:status')
  })
  const done = new Set<StepId>(
    [
      setup?.startDate && 'start',
      feed?.connected && 'timetable',
      modules.length > 0 &&
        feedNames.every((f) => f.moduleId !== null || f.hiddenOnly) &&
        'modules',
      setup?.weeklyTargetMinutes && 'week',
      claude?.hasToken && 'claude'
    ].filter((x): x is StepId => !!x)
  )
  const next = async () => {
    // The start date field shows today until you pick one: going on means today.
    if (step === 'start' && setup && !setup.startDate) {
      await call('setup:setStartDate', Temporal.Now.plainDateISO(TZ).toString())
      await qc.invalidateQueries()
    }
    setStep(STEPS[index + 1].id)
  }

  if (profile && profile.active !== 'real') return <SwitchToReal />

  return (
    <div className={w.page}>
      <nav className={w.steps} aria-label="Setup steps">
        <h1 className={w.title}>Set up Engram</h1>
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                className={w.stepButton}
                aria-current={s.id === step ? 'step' : undefined}
                data-done={done.has(s.id) || undefined}
                onClick={() => setStep(s.id)}
              >
                <span className={`${w.stepNo} num`}>
                  {done.has(s.id) ? <Check size={11} strokeWidth={3} /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <p className={w.note}>Everything saves as you go. You can come back from Settings.</p>
      </nav>
      <div className={w.content}>
        {step === 'start' && <StartStep />}
        {step === 'timetable' && <TimetableStep />}
        {step === 'modules' && <ModulesStep />}
        {step === 'week' && <WeekStep />}
        {step === 'tot' && (
          <Step title="Tot" lead="Your UNI dot in Tot and Engram’s todos stay in step.">
            <TotSection />
          </Step>
        )}
        {step === 'google' && <GoogleStep />}
        {step === 'zotero' && <ZoteroStep />}
        {step === 'claude' && (
          <Step
            title="Claude"
            lead="The assistant organises your work (it never writes coursework). It uses your Claude plan through a token, kept in the Keychain."
          >
            <ClaudeSection />
          </Step>
        )}
        {step === 'finish' && <FinishStep goTo={setStep} />}
        {step !== 'finish' && (
          <footer className={w.footer}>
            {index > 0 && (
              <button className={p.button} onClick={() => setStep(STEPS[index - 1].id)}>
                Back
              </button>
            )}
            <span className={w.spacer} />
            <button className={w.primary} onClick={() => void next()}>
              Next: {STEPS[index + 1].label}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}

function Step({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <>
      <h2 className={w.stepTitle}>{title}</h2>
      <p className={w.lead}>{lead}</p>
      {children}
    </>
  )
}

function SwitchToReal() {
  const switchProfile = useSwitchProfile()
  return (
    <div className={w.switch}>
      <h1 className={w.title}>Set up Engram</h1>
      <p className={w.lead}>
        Setup moves you onto your real data: your timetable, modules and week. You’re on demo data
        now; it stays as it is, and you can switch back any time in Settings.
      </p>
      <button
        className={w.primary}
        disabled={switchProfile.isPending}
        onClick={() => switchProfile.mutate('real')}
      >
        Switch to real data and start
      </button>
    </div>
  )
}

// --- 1. Start date ------------------------------------------------------------------------

function StartStep() {
  const qc = useQueryClient()
  const { data: setup } = useSetup()
  const today = Temporal.Now.plainDateISO(TZ).toString()
  const [error, setError] = useState<string | null>(null)
  const save = async (date: string) => {
    setError(null)
    try {
      await call('setup:setStartDate', date)
      await qc.invalidateQueries()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Step
      title="When are you starting?"
      lead="Lectures before this day aren’t written up yet. Engram won’t squeeze their write-ups into the next few days: they wait in the Backlog, to schedule when you’re ready. From this day on, write-ups are planned after each lecture as usual."
    >
      <div className={p.card}>
        <div className={p.row}>
          <div className={p.grow}>Start date</div>
          <DateField
            value={setup?.startDate ?? today}
            onChange={(d) => void save(d)}
            ariaLabel="Start date"
          />
          {!setup?.startDate && (
            <button className={p.button} onClick={() => void save(today)}>
              Start today
            </button>
          )}
        </div>
      </div>
      {setup?.startDate && <p className={w.saved}>Saved.</p>}
      {error && <p className={p.errorText}>{error}</p>}
    </Step>
  )
}

// --- 2. Timetable -------------------------------------------------------------------------

function TimetableStep() {
  const qc = useQueryClient()
  const { data: status } = useFeedStatus()
  const { data: last } = useLastImport()
  const [link, setLink] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setLink('')
      setReplacing(false)
      await qc.invalidateQueries()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const showForm = !status?.connected || replacing
  return (
    <Step
      title="Your timetable"
      lead={
        <>
          Paste your UCL timetable’s calendar link (the iCal or “subscribe” link). It’s a personal
          key, so Engram keeps it in the Keychain and never shows it again. The timetable is checked
          every 3 hours.
        </>
      }
    >
      <div className={p.card}>
        {showForm ? (
          <div className={p.row}>
            <input
              className={`${p.input} ${p.grow}`}
              type="password"
              placeholder="https://… or webcal://…"
              aria-label="Timetable link"
              value={link}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' && link && void run(() => call('feed:connect', link))
              }
            />
            <button
              className={w.primary}
              disabled={!link || busy}
              onClick={() => void run(() => call('feed:connect', link))}
            >
              {busy ? 'Importing…' : 'Connect'}
            </button>
            {replacing && (
              <button className={p.button} onClick={() => setReplacing(false)}>
                Cancel
              </button>
            )}
          </div>
        ) : (
          <div className={p.row}>
            <Check size={16} className={p.ok} />
            <div className={p.grow}>
              <div>Connected</div>
              {status?.lastError && <div className={p.errorText}>{status.lastError}</div>}
            </div>
            <button
              className={p.button}
              disabled={busy}
              onClick={() => void run(() => call('timetable:import'))}
            >
              {busy ? 'Importing…' : 'Import now'}
            </button>
            <button className={p.button} onClick={() => setReplacing(true)}>
              Use another link
            </button>
          </div>
        )}
        {last && !showForm && (
          <div className={p.row}>
            <div className={`${p.muted} num`}>
              {last.events} events, {last.lectures} lectures, {last.writeUpsPlaced} write-ups
              placed.
              {last.unmappedNames.length > 0 &&
                ` ${last.unmappedNames.length} timetable names to map to modules: that’s the next step.`}
            </div>
          </div>
        )}
      </div>
      {error && <p className={p.errorText}>{error}</p>}
    </Step>
  )
}

// --- 3. Modules ---------------------------------------------------------------------------

function ModulesStep() {
  const { data: modules = [] } = useModules()
  const { data: feedNames = [] } = useFeedNames()
  const [names, setNames] = useState(false)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [listFor, setListFor] = useState<ModuleWithDetails | null>(null)
  const unmapped = feedNames.filter((f) => f.moduleId === null && !f.hiddenOnly)

  return (
    <Step
      title="Modules"
      lead="The timetable has no module codes, only names. Map each name to a module: several names for one module (a cross-listed project) merge it. Then give each module its short label, colour, write-up length and folder, and drop in its lecture list so 2-hour slots holding two lectures are split. Match each Moodle course to its module, and its slides and briefs come in by themselves."
    >
      <div className={p.card}>
        <div className={p.row}>
          {unmapped.length > 0 ? (
            <CircleExclamationPoint size={16} className={p.errorText} />
          ) : (
            <Check size={16} className={p.ok} />
          )}
          <div className={p.grow}>
            {feedNames.length === 0
              ? 'No timetable names yet: connect the timetable first.'
              : unmapped.length > 0
                ? `${unmapped.length} timetable name${unmapped.length === 1 ? '' : 's'} not mapped yet`
                : 'Every timetable name is mapped'}
          </div>
          <button
            className={`${p.button} ${w.withIcon}`}
            disabled={!feedNames.length}
            onClick={() => setNames(true)}
          >
            <Tags size={14} /> Map timetable names
          </button>
        </div>
        {modules.map((mod) => (
          <div
            key={mod.id}
            className={`cat ${p.row}`}
            style={{ '--cat': mod.colour } as CSSProperties}
          >
            <span className={w.dot} />
            <div className={p.grow}>
              <div>
                <strong>{mod.shortLabel}</strong> {mod.name}
              </div>
              <div className={`${p.muted} num`}>
                Write-up {mod.writeUpMinutes} min per hour of lecture
                {mod.folderPath ? ' · folder linked' : ' · no folder'}
              </div>
            </div>
            <button
              className={`${p.button} ${w.withIcon}`}
              onClick={() => setListFor(mod)}
              title="Upload the lecture list to split 2-hour slots holding two lectures"
            >
              <ListOrdered size={14} /> Lecture list
            </button>
            <button className={`${p.button} ${w.withIcon}`} onClick={() => setSettingsFor(mod.id)}>
              <Settings2 size={14} /> Settings
            </button>
          </div>
        ))}
      </div>
      <div className={w.gap} />
      <MoodleSection />
      {names && <TimetableNamesPanel onClose={() => setNames(false)} />}
      {settingsFor && <ModuleSettings id={settingsFor} onClose={() => setSettingsFor(null)} />}
      {listFor && (
        <LectureListDialog
          moduleId={listFor.id}
          moduleLabel={listFor.shortLabel}
          onClose={() => setListFor(null)}
        />
      )}
    </Step>
  )
}

function ModuleSettings({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: mod } = useModule(id)
  if (!mod) return null
  return <ModuleSettingsPanel key={JSON.stringify(mod)} mod={mod} onClose={onClose} />
}

// --- 4. Your week -------------------------------------------------------------------------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const EMPTY: CommitmentInput = {
  title: '',
  kind: 'work',
  byWeekday: [],
  startTime: '17:00',
  endTime: '00:00'
}

function WeekStep() {
  const qc = useQueryClient()
  const { data: setup } = useSetup()
  const [target, setTarget] = useState<string | null>(null)
  const [draft, setDraft] = useState<CommitmentInput>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const shownTarget =
    target ?? (setup?.weeklyTargetMinutes ? String(setup.weeklyTargetMinutes / 60) : '')

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await qc.invalidateQueries()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    }
  }
  const saveTarget = () => {
    const hours = Number(shownTarget)
    void run(() =>
      call('setup:setWeeklyTarget', shownTarget.trim() ? Math.round(hours * 60) : null)
    ).then((ok) => ok && setTarget(null))
  }
  const add = () =>
    void run(() => call('setup:addCommitment', draft)).then((ok) => ok && setDraft(EMPTY))

  return (
    <Step
      title="Your week"
      lead="When Engram may place work, the fixed things it plans around, and how much self-study you aim for each week."
    >
      <AvailabilitySection />

      <section className={p.section}>
        <h3 className={p.sectionTitle}>Regular commitments</h3>
        <div className={p.card}>
          {setup?.commitments.map((c) => (
            <div key={c.id} className={p.row}>
              <div className={p.grow}>
                <div>{c.title}</div>
                <div className={`${p.muted} num`}>
                  {c.byWeekday.map((d) => WEEKDAYS[d - 1]).join(', ')} · {c.startTime}–{c.endTime} ·{' '}
                  {c.kind === 'work' ? 'Work' : 'Social'}
                </div>
              </div>
              <button
                className={w.iconButton}
                title={`Stop “${c.title}” from today`}
                aria-label={`Remove ${c.title}`}
                onClick={() => void run(() => call('setup:endCommitment', c.id))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <div className={`${p.row} ${w.addRow}`}>
            <div className={w.addLine}>
              <input
                className={`${p.input} ${p.grow}`}
                placeholder="Add one, e.g. Pub shift"
                aria-label="Commitment name"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <div className={p.segmented} role="group" aria-label="Kind">
                {(['work', 'social'] as const).map((k) => (
                  <button
                    key={k}
                    aria-pressed={draft.kind === k}
                    onClick={() => setDraft({ ...draft, kind: k })}
                  >
                    {k === 'work' ? 'Work' : 'Social'}
                  </button>
                ))}
              </div>
            </div>
            <div className={w.addLine}>
              <div className={p.dayToggles} role="group" aria-label="Days">
                {WEEKDAYS.map((d, i) => (
                  <button
                    key={d}
                    aria-pressed={draft.byWeekday.includes(i + 1)}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        byWeekday: draft.byWeekday.includes(i + 1)
                          ? draft.byWeekday.filter((x) => x !== i + 1)
                          : [...draft.byWeekday, i + 1]
                      })
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
              <span className={w.spacer} />
              <TimeField
                value={draft.startTime}
                onChange={(v) => setDraft({ ...draft, startTime: v })}
                ariaLabel="Starts"
              />
              <span className={p.muted}>–</span>
              <TimeField
                value={draft.endTime}
                onChange={(v) => setDraft({ ...draft, endTime: v })}
                ariaLabel="Ends"
              />
              <button
                className={p.button}
                disabled={!draft.title.trim() || !draft.byWeekday.length}
                onClick={add}
              >
                Add
              </button>
            </div>
          </div>
        </div>
        <p className={w.hint}>
          An end at or before the start runs past midnight (17:00–00:00 ends at midnight).
        </p>
      </section>

      <section className={p.section}>
        <h3 className={p.sectionTitle}>Weekly target</h3>
        <div className={p.card}>
          <div className={p.row}>
            <div className={p.grow}>
              <div>Self-study hours a week</div>
              <div className={p.muted}>Shown in the top bar against what you’ve logged.</div>
            </div>
            <input
              className={`${p.input} ${w.hours}`}
              inputMode="decimal"
              aria-label="Weekly target in hours"
              value={shownTarget}
              placeholder="none"
              onChange={(e) => setTarget(e.target.value)}
              onBlur={saveTarget}
              onKeyDown={(e) => e.key === 'Enter' && saveTarget()}
            />
            <span className={p.muted}>h</span>
          </div>
        </div>
      </section>
      {error && <p className={p.errorText}>{error}</p>}
    </Step>
  )
}

// --- 6. Google ----------------------------------------------------------------------------

function GoogleStep() {
  return (
    <Step
      title="Google Calendar"
      lead="Engram mirrors your plan into its own Google calendar, one way, so you can see it on your phone."
    >
      <GoogleSection />
    </Step>
  )
}

// --- 7. Zotero and dissertation -----------------------------------------------------------

function ZoteroStep() {
  const navigate = useNavigate()
  const zotero = useQuery({
    queryKey: ['zoteroCollections'],
    queryFn: () => call('zotero:collections'),
    retry: false
  })
  return (
    <Step
      title="Zotero and your dissertation"
      lead="The dissertation’s reading list comes from a Zotero collection. Engram reads it from the Zotero app (read-only) while Zotero is open."
    >
      <div className={p.card}>
        <div className={p.row}>
          {zotero.isSuccess ? (
            <Check size={16} className={p.ok} />
          ) : (
            <CircleExclamationPoint size={16} className={p.bad} />
          )}
          <div className={p.grow}>
            {zotero.isPending
              ? 'Looking for Zotero…'
              : zotero.isSuccess
                ? `Zotero is open: ${zotero.data.length} collection${zotero.data.length === 1 ? '' : 's'}.`
                : errorMessage(zotero.error)}
          </div>
          <button className={p.button} onClick={() => void zotero.refetch()}>
            Check again
          </button>
        </div>
        <div className={p.row}>
          <div className={p.grow}>
            <div>Dissertation</div>
            <div className={p.muted}>
              Title, submission date, word target and the Zotero collection, in the dissertation’s
              settings. You can also import your proposal there.
            </div>
          </div>
          <button className={p.button} onClick={() => navigate('/dissertation')}>
            Open dissertation
          </button>
        </div>
      </div>
    </Step>
  )
}

// --- 9. Finish ----------------------------------------------------------------------------

function FinishStep({ goTo }: { goTo: (step: StepId) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: setup } = useSetup()
  const { data: feed } = useFeedStatus()
  const { data: modules = [] } = useModules()
  const { data: feedNames = [] } = useFeedNames()
  const { data: claude } = useQuery({
    queryKey: ['assistantStatus'],
    queryFn: () => call('assistant:status')
  })
  const unmapped = feedNames.filter((f) => f.moduleId === null && !f.hiddenOnly).length
  const checks: { ok: boolean; label: string; step: StepId }[] = [
    {
      step: 'start',
      ok: !!setup?.startDate,
      label: setup?.startDate
        ? `Starting ${Temporal.PlainDate.from(setup.startDate).toLocaleString('en-GB', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          })}`
        : 'No start date'
    },
    {
      step: 'timetable',
      ok: !!feed?.connected,
      label: feed?.connected ? 'Timetable connected' : 'Timetable not connected'
    },
    {
      step: 'modules',
      ok: modules.length > 0 && unmapped === 0,
      label: `${modules.length} module${modules.length === 1 ? '' : 's'}${unmapped ? `, ${unmapped} timetable names not mapped` : ''}`
    },
    {
      step: 'week',
      ok: !!setup?.weeklyTargetMinutes,
      label: setup?.weeklyTargetMinutes
        ? `Weekly target ${setup.weeklyTargetMinutes / 60}h`
        : 'No weekly target'
    },
    {
      step: 'claude',
      ok: !!claude?.hasToken,
      label: claude?.hasToken ? 'Claude connected' : 'Claude not connected'
    }
  ]
  const finish = async () => {
    await call('setup:complete')
    await qc.invalidateQueries()
    navigate('/')
  }
  return (
    <Step
      title={checks.every((c) => c.ok) ? 'All set' : 'Nearly there'}
      lead={
        checks.every((c) => c.ok)
          ? 'Backups run daily to iCloud Drive. Anything here can be changed later in Settings or on the module pages.'
          : 'You can finish now and do the rest later from Settings, but Engram can only plan around a timetable it has. Backups run daily to iCloud Drive.'
      }
    >
      <div className={p.card}>
        {checks.map((c) => (
          <div key={c.label} className={p.row}>
            {c.ok ? (
              <Check size={16} className={p.ok} />
            ) : (
              <CircleExclamationPoint size={16} className={p.bad} />
            )}
            <div className={p.grow}>{c.label}</div>
            {!c.ok && (
              <button className={p.button} onClick={() => goTo(c.step)}>
                Set up
              </button>
            )}
          </div>
        ))}
      </div>
      <footer className={w.footer}>
        <span className={w.spacer} />
        <button className={w.primary} onClick={() => void finish()}>
          {setup?.completedAt ? 'Done' : 'Finish setup'}
        </button>
      </footer>
    </Step>
  )
}
