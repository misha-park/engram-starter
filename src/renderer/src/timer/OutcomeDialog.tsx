import { useEffect, useState } from 'react'
import { CircleCheck, CircleDashed, CircleSlash, Sparkles, X } from 'lucide-react'
import type { Block, CheckinItem, OutcomeInput } from '@shared/types'
import { atLocalTime, formatClock, formatMinutes, minutesBetween, toIso, zoned } from '@core/time'
import { debriefPrompt } from '@core/prompts'
import {
  useAssistantStatus,
  errorMessage,
  useCompleteSession,
  useMarkOutcome
} from '../lib/queries'
import { CopyPromptButton } from './CopyPromptButton'
import { useAssistant } from '../assistant/store'
import d from '../shell/Dialog.module.css'
import { TimeField } from '../ui/TimeField'

export type OutcomeMode = { kind: 'session'; item: CheckinItem } | { kind: 'block'; block: Block }

/** "Wed 19 Nov" */
const dayLabel = (iso: string) =>
  zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

const CHOICES = [
  { outcome: 'done', label: 'Done', icon: CircleCheck },
  { outcome: 'partial', label: 'Partial', icon: CircleDashed },
  { outcome: 'skipped', label: 'Skipped', icon: CircleSlash }
] as const

/**
 * Marks how a piece of work went. Used after stopping a timer, at a check-in (when the timer
 * stopped itself, the end time can be corrected) and for blocks done without a timer.
 * Partial asks for a short debrief, with a prompt to copy into the Claude chat used while revising.
 */
export function OutcomeDialog({
  mode,
  onClose,
  categoryName = null
}: {
  mode: OutcomeMode
  onClose: () => void
  /** For block mode: the block's calendar name, used in the debrief prompt. */
  categoryName?: string | null
}) {
  const [outcome, setOutcome] = useState<OutcomeInput['outcome'] | null>(null)
  const [note, setNote] = useState('')
  const [debrief, setDebrief] = useState('')
  const complete = useCompleteSession()
  const mark = useMarkOutcome()
  const error = complete.error ?? mark.error

  const timedOut = mode.kind === 'session' && mode.item.kind === 'timed-out'
  const start = mode.kind === 'session' ? mode.item.start : mode.block.start
  const loggedEnd = mode.kind === 'session' ? mode.item.end : mode.block.end
  const [endTime, setEndTime] = useState(formatClock(loggedEnd))
  const planned = mode.kind === 'block' ? minutesBetween(mode.block.start, mode.block.end) : 0
  const [minutes, setMinutes] = useState(String(planned))
  const title =
    mode.kind === 'session'
      ? mode.item.title
      : mode.block.detail
        ? `${mode.block.heading} · ${mode.block.detail}`
        : (mode.block.heading ?? mode.block.title)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** The corrected end, read on the day the timer stopped (so a midnight-crossing session works). */
  const correctedEnd = (): string => toIso(atLocalTime(zoned(loggedEnd).toPlainDate(), endTime))

  const assistant = useAssistant()
  const { data: claude } = useAssistantStatus()
  const blockId = mode.kind === 'session' ? mode.item.blockId : mode.block.id

  /**
   * Save the outcome. `withClaude` saves partial work with the debrief left for Claude, or
   * skipped work and asks Claude to find it a new time.
   */
  const save = (withClaude = false) => {
    if (!outcome) return
    const input: OutcomeInput =
      outcome === 'done'
        ? { outcome, note }
        : outcome === 'partial'
          ? { outcome, debrief: withClaude ? '' : debrief }
          : { outcome }
    const onSuccess = () => {
      onClose()
      if (!withClaude) return
      if (outcome === 'partial') assistant.startDebrief(blockId, title)
      if (outcome === 'skipped') {
        assistant.ask(
          `I skipped “${title}” (planned ${dayLabel(start)} ${formatClock(start)}–${formatClock(loggedEnd)}). Find it a new time that fits its rules.`
        )
      }
    }
    // mutateAsync, not mutate's own onSuccess: saving can remove this dialog (the check-in it
    // shows is gone), and React Query skips mutate callbacks once the component unmounts.
    const saved =
      mode.kind === 'session'
        ? complete.mutateAsync({
            sessionId: mode.item.sessionId,
            input,
            correctedEnd: timedOut ? correctedEnd() : undefined
          })
        : mark.mutateAsync({
            blockId: mode.block.id,
            input: { ...input, minutes: outcome === 'skipped' ? undefined : Number(minutes) }
          })
    saved.then(onSuccess, () => {
      // Shown in the dialog from the mutation's error.
    })
  }

  const lead =
    mode.kind === 'block'
      ? `Planned ${formatClock(mode.block.start)}–${formatClock(mode.block.end)}. No timer was running.`
      : timedOut
        ? `Your timer stopped itself at ${formatClock(loggedEnd)} because nobody answered “still working?”.`
        : `Logged ${formatClock(start)}–${formatClock(loggedEnd)} (${formatMinutes(minutesBetween(start, loggedEnd))}).`

  return (
    <div className={d.backdrop}>
      <div className={d.dialog} role="dialog" aria-label={`How did ${title} go?`}>
        <header className={d.header}>
          <h2 className={d.title}>{title}</h2>
          <button className={d.close} onClick={onClose} title="Later (Esc)">
            <X size={14} />
          </button>
        </header>
        <div className={d.body}>
          <p className={d.lead}>{lead}</p>
          {timedOut && (
            <label className={d.field}>
              When did you actually stop?
              <TimeField value={endTime} onChange={setEndTime} ariaLabel="Stopped at" />
            </label>
          )}
          <div className={d.choices} role="group" aria-label="Outcome">
            {CHOICES.map(({ outcome: o, label, icon: Icon }) => (
              <button
                key={o}
                className={d.choice}
                aria-pressed={outcome === o}
                onClick={() => setOutcome(o)}
              >
                <Icon size={18} strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </div>
          {mode.kind === 'block' && outcome && outcome !== 'skipped' && (
            <label className={d.field}>
              Time spent (minutes)
              <input
                className={d.input}
                type="number"
                min={1}
                max={720}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </label>
          )}
          {outcome === 'done' && (
            <label className={d.field}>
              Note (optional)
              <input
                className={d.input}
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                placeholder="One line, if anything"
              />
            </label>
          )}
          {outcome === 'partial' && (
            <>
              <label className={d.field}>
                Debrief: where you got to and what’s left
                <textarea
                  className={`${d.textarea} ${d.debriefBox}`}
                  value={debrief}
                  onChange={(e) => setDebrief(e.target.value)}
                  placeholder="Paste the summary from your revision chat, or write a few lines"
                />
              </label>
              <div className={d.row}>
                <CopyPromptButton
                  prompt={debriefPrompt({
                    title,
                    categoryName: mode.kind === 'session' ? mode.item.categoryName : categoryName,
                    start,
                    end:
                      mode.kind === 'session'
                        ? timedOut
                          ? correctedEnd()
                          : loggedEnd
                        : mode.block.end,
                    minutes:
                      mode.kind === 'session'
                        ? minutesBetween(start, timedOut ? correctedEnd() : loggedEnd)
                        : Number(minutes) || undefined
                  })}
                />
                {claude?.hasToken && (
                  <button
                    className={`${d.secondary} ${d.withIcon}`}
                    disabled={!!debrief.trim() || complete.isPending || mark.isPending}
                    title="Save as partial and talk the debrief through with Claude"
                    onClick={() => save(true)}
                  >
                    <Sparkles size={13} /> Debrief with Claude
                  </button>
                )}
                <span className={d.muted}>Leave it empty to debrief later.</span>
              </div>
            </>
          )}
          {outcome === 'skipped' && (
            <div className={d.row}>
              <span className={d.muted}>No questions. It goes to the Backlog.</span>
              {claude?.hasToken && (
                <button
                  className={`${d.secondary} ${d.withIcon}`}
                  disabled={complete.isPending || mark.isPending || assistant.state.busyId !== null}
                  title="Save as skipped and ask Claude to find it a new time"
                  onClick={() => save(true)}
                >
                  <Sparkles size={13} /> Skip and re-plan with Claude
                </button>
              )}
            </div>
          )}
          {error && <p className={d.error}>{errorMessage(error)}</p>}
        </div>
        <div className={d.actions}>
          {timedOut && claude?.hasToken && mode.kind === 'session' && (
            <button
              className={`${d.secondary} ${d.withIcon}`}
              title="Tell Claude when you stopped and how it went"
              onClick={() => {
                onClose()
                assistant.startCheckin(mode.item.sessionId, title)
              }}
            >
              <Sparkles size={13} /> Talk it through with Claude
            </button>
          )}
          <button className={d.secondary} onClick={onClose}>
            Later
          </button>
          <span className={d.spacer} />
          <button
            className={d.primary}
            disabled={!outcome || complete.isPending || mark.isPending}
            onClick={() => save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
