import { useEffect, useState, type CSSProperties } from 'react'
import { FileText, Pencil, Play, Repeat, Sparkles, Square, Trash2, X } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { Block, Category, Recurrence } from '@shared/types'
import { isUserMovable } from '@core/blocks'
import { describeRule, weekdayName } from '@core/recurrence'
import { formatClock, formatMinutes, minutesBetween, zoned } from '@core/time'
import { BLOCK_TYPE_ICON } from '../lib/blockTypes'
import { blockName } from '../lib/blockName'
import { call } from '../lib/api'
import {
  useAssistantStatus,
  errorMessage,
  useRecurrence,
  useRemoveOccurrence,
  useSaveDebrief,
  useStartTimer,
  useStopTimer,
  useTimer,
  useUpdateRecurrence
} from '../lib/queries'
import { debriefPrompt } from '@core/prompts'
import { CopyPromptButton } from '../timer/CopyPromptButton'
import { ColourPicker } from '../pages/modules/ColourPicker'
import { useAssistant } from '../assistant/store'
import { useQueryClient } from '@tanstack/react-query'
import { OutcomeDialog } from '../timer/OutcomeDialog'
import s from './BlockDialog.module.css'
import { TimeField } from '../ui/TimeField'
import { EventDialog } from './EventDialog'
import { LectureSlides } from './LectureSlides'
import { toast } from '../ui/toastStore'
import { canDelete, deleteBlock, deleteQuestion, hideTimetabled } from './deleteBlock'

const SOURCE_LABEL: Record<Block['source'], string> = {
  timetable: 'Timetable',
  user: 'You',
  auto: 'Auto-scheduled',
  claude: 'Claude'
}

const OUTCOME_LABEL: Record<Block['outcome'], string> = {
  none: 'Not marked yet',
  done: 'Done',
  partial: 'Partial',
  skipped: 'Skipped'
}

interface Props {
  block: Block
  category?: Category
  onClose: () => void
  /** Open straight into the editor (right-click → Edit…). */
  startEditing?: boolean
  /** Show another block on the calendar, highlighted (e.g. a lecture's write-up). */
  onShowBlock?: (block: Block) => void
}

export function BlockDialog({ block, category, onClose, startEditing, onShowBlock }: Props) {
  const [editing, setEditing] = useState(!!startEditing)
  if (editing) return <EventDialog block={block} onClose={onClose} />
  return (
    <BlockView
      block={block}
      category={category}
      onClose={onClose}
      onShowBlock={onShowBlock}
      onEdit={() => setEditing(true)}
    />
  )
}

/** Events added by hand (or by Claude) can be edited and deleted. */
const editable = (b: Block) => !b.recurrenceId && (b.source === 'user' || b.source === 'claude')

function BlockView({
  block,
  category,
  onClose,
  onEdit,
  onShowBlock
}: Props & { onEdit: () => void }) {
  const Icon = BLOCK_TYPE_ICON[block.type]
  const { data: recurrence } = useRecurrence(block.recurrenceId)
  const qc = useQueryClient()
  // Module work takes its module's colour; anything else can have its own.
  const ownColour = block.source !== 'timetable' && category?.kind !== 'module'
  const [colour, setColour] = useState<string | null>(block.colour)
  const [colourError, setColourError] = useState<string | null>(null)
  const changeColour = async (next: string | null) => {
    const prev = colour
    setColour(next)
    setColourError(null)
    try {
      await call('blocks:setColour', block.id, next)
      await qc.invalidateQueries({ queryKey: ['blocks'] })
      await qc.invalidateQueries({ queryKey: ['backlog'] })
    } catch (e) {
      setColour(prev)
      setColourError(errorMessage(e))
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const start = zoned(block.start)
  return (
    <div className={s.backdrop} onMouseDown={onClose}>
      <div
        className={`cat ${s.dialog}`}
        role="dialog"
        aria-label={
          block.detail ? `${block.heading} · ${block.detail}` : (block.heading ?? block.title)
        }
        style={{ '--cat': colour ?? category?.colour } as CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.header}>
          <span className={s.swatch} />
          <h2 className={s.title}>
            {block.heading ?? block.title}
            {block.detail && <span className={s.subtitle}>{block.detail}</span>}
          </h2>
          {editable(block) && (
            <button className={s.close} onClick={onEdit} title="Edit" aria-label="Edit event">
              <Pencil size={13} />
            </button>
          )}
          <button className={s.close} onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>

        <dl className={s.fields}>
          <dt>When</dt>
          <dd className="num">
            {start
              .toPlainDate()
              .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            , {formatClock(block.start)}–{formatClock(block.end)}{' '}
            <span className={s.muted}>
              ({formatMinutes(minutesBetween(block.start, block.end))})
            </span>
          </dd>
          <dt>Type</dt>
          <dd className={s.type}>
            <Icon size={13} /> {block.type.replace('-', ' ')} ·{' '}
            {block.kind === 'fixed' ? 'Fixed' : 'Flexible'}
          </dd>
          {category && (
            <>
              <dt>Calendar</dt>
              <dd>{category.name}</dd>
            </>
          )}
          {ownColour && (
            <>
              <dt>Colour</dt>
              <dd className={s.colourRow}>
                <ColourPicker value={colour ?? category?.colour ?? ''} onChange={changeColour} />
                {colour && (
                  <button className={s.linkButton} onClick={() => void changeColour(null)}>
                    {category ? `Use ${category.name}’s` : 'Reset'}
                  </button>
                )}
                {block.recurrenceId && <span className={s.muted}>Whole series</span>}
                {colourError && <span className={s.error}>{colourError}</span>}
              </dd>
            </>
          )}
          {block.notes && (
            <>
              <dt>Notes</dt>
              <dd className={s.notes}>{block.notes}</dd>
            </>
          )}
          {block.lecture && <LectureSlides lecture={block.lecture} />}
          {block.type === 'lecture' && block.lecture && onShowBlock && (
            <WriteUpLink
              lectureId={block.lecture.id}
              onShow={(b) => {
                onClose()
                onShowBlock(b)
              }}
            />
          )}
          <dt>Source</dt>
          <dd>{SOURCE_LABEL[block.source]}</dd>
          <dt>Outcome</dt>
          <dd>
            {OUTCOME_LABEL[block.outcome]}
            {block.debriefPending && <span className={s.muted}> · debrief pending</span>}
          </dd>
        </dl>

        {block.attention && <p className={s.attention}>{block.attention}</p>}

        {!isUserMovable(block) && (
          <p className={s.note}>
            Timetabled events come from the university feed and can’t be moved.
          </p>
        )}

        {block.source === 'timetable' && <DeleteTimetabled block={block} onDone={onClose} />}
        {canDelete(block) && block.source !== 'user' && block.source !== 'claude' && (
          <DeletePlaced block={block} onDone={onClose} />
        )}

        {block.kind === 'flexible' && (
          <WorkActions block={block} categoryName={category?.name} onClose={onClose} />
        )}

        {recurrence && <SeriesEditor block={block} recurrence={recurrence} onDone={onClose} />}
      </div>
    </div>
  )
}

/** Timer, outcome, debrief and record actions for a flexible block. */
function WorkActions({
  block,
  categoryName,
  onClose
}: {
  block: Block
  categoryName?: string
  onClose: () => void
}) {
  const { data: timer } = useTimer()
  const start = useStartTimer()
  const stop = useStopTimer()
  const [marking, setMarking] = useState(false)
  const [recordError, setRecordError] = useState<string | null>(null)
  const runningHere = timer?.blockId === block.id
  const started =
    Temporal.Instant.compare(Temporal.Instant.from(block.start), Temporal.Now.instant()) <= 0
  const error = start.error ?? stop.error

  if (marking) {
    return (
      <OutcomeDialog
        mode={{ kind: 'block', block }}
        categoryName={categoryName}
        onClose={onClose}
      />
    )
  }

  return (
    <section className={s.work}>
      {block.debriefPending && (
        <DebriefForm block={block} categoryName={categoryName} onDone={onClose} />
      )}
      <div className={s.actions}>
        {runningHere ? (
          <button
            className={s.primary}
            onClick={() => stop.mutate(undefined, { onSuccess: onClose })}
          >
            <Square size={12} /> Stop timer
          </button>
        ) : (
          block.outcome === 'none' && (
            <button
              className={s.primary}
              disabled={!!timer || start.isPending}
              title={timer ? `A timer is running for ${timer.title}` : undefined}
              onClick={() => start.mutate(block.id, { onSuccess: onClose })}
            >
              <Play size={12} /> Start timer
            </button>
          )
        )}
        {block.outcome === 'none' && !runningHere && started && (
          <button className={s.secondary} onClick={() => setMarking(true)}>
            Mark outcome…
          </button>
        )}
        <span className={s.spacer} />
        <button
          className={s.secondary}
          title="Open the record file"
          onClick={() =>
            call('records:open', block.id).then(
              () => setRecordError(null),
              (e) => setRecordError(errorMessage(e))
            )
          }
        >
          <FileText size={13} /> Record
        </button>
      </div>
      {(error || recordError) && (
        <p className={s.error}>{error ? errorMessage(error) : recordError}</p>
      )}
    </section>
  )
}

/** The debrief for a partial block: one box, plus a prompt to copy into the revision chat. */
function DebriefForm({
  block,
  categoryName,
  onDone
}: {
  block: Block
  categoryName?: string
  onDone: () => void
}) {
  const [debrief, setDebrief] = useState('')
  const save = useSaveDebrief()
  const assistant = useAssistant()
  const { data: claude } = useAssistantStatus()
  return (
    <div className={s.debrief}>
      <div className={s.seriesTitle}>Debrief</div>
      <textarea
        placeholder="Where you got to and what’s left. Paste the summary from your revision chat."
        value={debrief}
        onChange={(e) => setDebrief(e.target.value)}
      />
      {save.error && <p className={s.error}>{errorMessage(save.error)}</p>}
      <div className={s.actions}>
        <CopyPromptButton
          className={s.secondary}
          label="Copy prompt"
          title="Copy a prompt for your revision chat in Claude, then paste its summary here"
          prompt={debriefPrompt({
            title: blockName(block),
            categoryName,
            start: block.start,
            end: block.end
          })}
        />
        {claude?.hasToken && (
          <button
            className={s.secondary}
            title="Talk the debrief through with Engram’s assistant"
            onClick={() => {
              onDone()
              assistant.startDebrief(block.id, blockName(block))
            }}
          >
            <Sparkles size={13} /> With Claude
          </button>
        )}
        <span className={s.spacer} />
        <button
          className={s.primary}
          disabled={!debrief.trim() || save.isPending}
          onClick={() => save.mutate({ blockId: block.id, debrief }, { onSuccess: onDone })}
        >
          Save debrief
        </button>
      </div>
    </div>
  )
}

function SeriesEditor({
  block,
  recurrence,
  onDone
}: {
  block: Block
  recurrence: Recurrence
  onDone: () => void
}) {
  const [weekday, setWeekday] = useState(recurrence.rule.byWeekday[0])
  const [startTime, setStartTime] = useState(recurrence.rule.startTime)
  const [endTime, setEndTime] = useState(recurrence.rule.endTime)
  const update = useUpdateRecurrence()
  const remove = useRemoveOccurrence()
  const error = update.error ?? remove.error

  const unchanged =
    weekday === recurrence.rule.byWeekday[0] &&
    startTime === recurrence.rule.startTime &&
    endTime === recurrence.rule.endTime

  const save = () =>
    update.mutate(
      { id: recurrence.id, rule: { freq: 'weekly', byWeekday: [weekday], startTime, endTime } },
      { onSuccess: onDone }
    )

  const removeThis = () => {
    if (window.confirm('Remove this occurrence only? The rest of the series stays.')) {
      remove.mutate(block.id, { onSuccess: onDone })
    }
  }
  const qc = useQueryClient()
  const [ending, setEnding] = useState<string | null>(null)
  const endAfter = async () => {
    if (!window.confirm('Make this the last one? Later occurrences you haven’t changed go.')) return
    try {
      await call('blocks:endSeriesAfter', block.id)
      await qc.invalidateQueries()
      onDone()
    } catch (e) {
      setEnding(errorMessage(e))
    }
  }

  return (
    <section className={s.series}>
      <div className={s.seriesTitle}>
        <Repeat size={13} /> Repeats {describeRule(recurrence.rule)}
      </div>
      {block.detached && (
        <p className={s.note}>
          This occurrence was edited on its own, so series changes won’t move it.
        </p>
      )}
      <div className={s.seriesForm}>
        <select
          value={weekday}
          onChange={(e) => setWeekday(Number(e.target.value))}
          aria-label="Day"
        >
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <option key={d} value={d}>
              {weekdayName(d)}s
            </option>
          ))}
        </select>
        <TimeField value={startTime} onChange={setStartTime} ariaLabel="Start" />
        <span className={s.muted}>to</span>
        <TimeField value={endTime} onChange={setEndTime} ariaLabel="End" />
      </div>
      <p className={s.hint}>
        Updates future occurrences; past ones and ones you’ve moved individually keep their times.
        Drag a single occurrence on the calendar to change just that one.
      </p>
      {error && <p className={s.error}>{cleanError(error)}</p>}
      {ending && <p className={s.error}>{ending}</p>}
      <div className={s.actions}>
        <button className={s.secondary} onClick={removeThis} disabled={remove.isPending}>
          Remove this occurrence
        </button>
        <button className={s.secondary} onClick={() => void endAfter()}>
          Stop after this one
        </button>
        <span className={s.spacer} />
        <button className={s.primary} onClick={save} disabled={unchanged || update.isPending}>
          Update series
        </button>
      </div>
    </section>
  )
}

function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** The lecture's write-up: shown (and highlighted) on the calendar, made first if it has none. */
function WriteUpLink({ lectureId, onShow }: { lectureId: string; onShow: (b: Block) => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const show = async () => {
    setBusy(true)
    setError(null)
    try {
      const { blockId, created } = await call('lectures:ensureWriteUp', lectureId)
      if (created) await qc.invalidateQueries()
      const wu = await call('blocks:get', blockId)
      if (!wu) throw new Error('The write-up couldn’t be found.')
      onShow(wu)
      if (created) {
        const at = zoned(wu.start)
        toast(
          `There was no write-up session, so one was added: ${at
            .toPlainDate()
            .toLocaleString('en-GB', {
              weekday: 'short',
              day: 'numeric',
              month: 'short'
            })}, ${formatClock(wu.start)}.`,
          {
            action: {
              label: 'Undo',
              run: async () => {
                await call('blocks:delete', blockId)
                await qc.invalidateQueries()
              }
            }
          }
        )
      }
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <>
      <dt>Write-up</dt>
      <dd>
        <button className={s.linkButton} disabled={busy} onClick={() => void show()}>
          Show write-up session
        </button>
        {error && <span className={s.error}> {error}</span>}
      </dd>
    </>
  )
}

/** Delete something Engram placed (a write-up, assignment work, a review…), with Undo. */
function DeletePlaced({ block, onDone }: { block: Block; onDone: () => void }) {
  const qc = useQueryClient()
  return (
    <section className={s.work}>
      <div className={s.actions}>
        <span className={s.spacer} />
        <button
          className={s.danger}
          onClick={() => {
            if (!window.confirm(deleteQuestion(block))) return
            onDone()
            void deleteBlock(block, qc)
          }}
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </section>
  )
}

/** Delete a timetabled event; later imports leave it out (Settings → Timetable brings it back). */
function DeleteTimetabled({ block, onDone }: { block: Block; onDone: () => void }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (
      !window.confirm(
        `Delete “${blockName(block)}” from your calendar?\n\nLater timetable imports leave it out. A lecture’s write-up goes with it, unless you’ve moved or marked it. You can bring it back in Settings → Timetable.`
      )
    )
      return
    try {
      await hideTimetabled(block, qc)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <section className={s.work}>
      <div className={s.actions}>
        <span className={s.spacer} />
        <button className={s.danger} onClick={() => void remove()}>
          <Trash2 size={13} /> Delete from calendar
        </button>
      </div>
      {error && <p className={s.error}>{error}</p>}
    </section>
  )
}
