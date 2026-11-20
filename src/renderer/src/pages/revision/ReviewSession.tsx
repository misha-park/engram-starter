import { useEffect, useState } from 'react'
import { Brain, Frown, Meh, Smile, X } from 'lucide-react'
import type { ReviewItem, ReviewRating } from '@shared/types'
import { intervalBefore, REVIEW_MINUTES } from '@core/reviews'
import { reviewPrompt } from '@core/prompts'
import { CopyPromptButton } from '../../timer/CopyPromptButton'
import d from '../../shell/Dialog.module.css'
import r from './Revision.module.css'

const RATINGS: { rating: ReviewRating; label: string; hint: string; icon: typeof Smile }[] = [
  { rating: 'easy', label: 'Easy', hint: 'Recalled it well', icon: Smile },
  { rating: 'ok', label: 'OK', hint: 'Mostly there', icon: Meh },
  { rating: 'hard', label: 'Hard', hint: 'Lots I missed', icon: Frown }
]

const STEP_TITLES = ['Recall', 'Check', 'Rate'] as const

/**
 * A guided 30-minute review: recall from memory, check with the lecture's Claude chat (prompt
 * copied, never sent), then rate it. The rating sets when the next review comes round.
 */
export function ReviewSession({
  review,
  moduleName,
  lastRating,
  onSave,
  onClose
}: {
  review: ReviewItem
  moduleName: string
  lastRating: ReviewRating | null
  onSave: (input: { rating: ReviewRating; minutes: number }) => Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState(0)
  const [rating, setRating] = useState<ReviewRating | null>(null)
  const [minutes, setMinutes] = useState(String(REVIEW_MINUTES))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const nextDays = rating ? intervalBefore(review.step + 1, rating) : null
  const save = async () => {
    if (!rating) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ rating, minutes: Number(minutes) || REVIEW_MINUTES })
      onClose()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(e)
      )
      setSaving(false)
    }
  }

  return (
    <div className={d.backdrop}>
      <div className={d.dialog} role="dialog" aria-label={`Review ${review.lectureTitle}`}>
        <header className={d.header}>
          <h2 className={d.title}>
            {review.lectureTitle} · review {review.step} of {review.steps}
          </h2>
          <button className={d.close} onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <ol className={r.steps} aria-label="Steps">
          {STEP_TITLES.map((t, i) => (
            <li
              key={t}
              aria-current={i === step ? 'step' : undefined}
              data-done={i < step || undefined}
            >
              {i + 1}. {t}
            </li>
          ))}
        </ol>
        <div className={d.body}>
          {step === 0 && (
            <>
              <p className={d.lead}>
                <Brain size={14} className={r.inlineIcon} /> Close your notes. Spend a few minutes
                recalling {review.lectureTitle}: the main ideas, key terms and how they fit
                together.
              </p>
              <p className={d.muted}>
                Jot things down on paper if it helps. Nothing here is saved.
              </p>
            </>
          )}
          {step === 1 && (
            <>
              <p className={d.lead}>
                Open your Claude chat for {review.lectureTitle} (in the {moduleName} project) and
                paste this prompt. Answer its questions, then check anything you missed against your
                notes.
              </p>
              <div className={d.row}>
                <CopyPromptButton
                  prompt={reviewPrompt({
                    lectureTitle: review.lectureTitle,
                    moduleName,
                    step: review.step,
                    steps: review.steps,
                    lastRating
                  })}
                  label="Copy review prompt"
                  title="Copy a prompt for your Claude chat on this lecture (it isn't sent anywhere)"
                />
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <p className={d.lead}>How did it go?</p>
              <div className={d.choices} role="group" aria-label="Rating">
                {RATINGS.map(({ rating: value, label, hint, icon: Icon }) => (
                  <button
                    key={value}
                    className={d.choice}
                    aria-pressed={rating === value}
                    title={hint}
                    onClick={() => setRating(value)}
                  >
                    <Icon size={18} strokeWidth={1.75} />
                    {label}
                  </button>
                ))}
              </div>
              <label className={d.field}>
                Time spent (minutes)
                <input
                  className={r.minutes}
                  type="number"
                  min={1}
                  max={180}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
              <p className={d.muted}>
                {rating === null
                  ? 'Your rating sets when this comes round again.'
                  : nextDays === null
                    ? 'That was the last review for this lecture.'
                    : `Next review in ${nextDays} day${nextDays === 1 ? '' : 's'}.`}
              </p>
            </>
          )}
          {error && <p className={d.error}>{error}</p>}
        </div>
        <div className={d.actions}>
          {step > 0 && (
            <button className={d.secondary} onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <span className={d.spacer} />
          {step < 2 ? (
            <button className={d.primary} onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className={d.primary} disabled={!rating || saving} onClick={() => void save()}>
              Save review
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
