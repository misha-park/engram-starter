import { useMemo, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Brain, CalendarClock, CalendarDays, Play } from 'lucide-react'
import type { ReviewItem, ReviewRating } from '@shared/types'
import { formatClock, zoned } from '@core/time'
import { moduleReviewPrompt } from '@core/prompts'
import { call } from '../../lib/api'
import { errorMessage, useModules } from '../../lib/queries'
import { CopyPromptButton } from '../../timer/CopyPromptButton'
import { ReviewSession } from './ReviewSession'
import { openContextMenu } from '../../ui/menuStore'
import r from './Revision.module.css'

// Spaced repetition (experimental): what's due, this week's plan, and each lecture's history.
// Reviews happen in the user's own Claude chats; Engram plans them, tracks them and copies
// prompts.

const day = (iso: string) =>
  zoned(iso)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const dateLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })

const RATING_LABEL: Record<ReviewRating, string> = { easy: 'Easy', ok: 'OK', hard: 'Hard' }

export function RevisionPage() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['reviews'], queryFn: () => call('reviews:overview') })
  const { data: modules = [] } = useModules()
  const [active, setActive] = useState<ReviewItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const moduleName = (id: string) => modules.find((m) => m.id === id)?.name ?? ''

  const navigate = useNavigate()
  const menu = (e: React.MouseEvent, item: ReviewItem) =>
    openContextMenu(e, [
      { heading: `${item.lectureTitle} · review ${item.step}` },
      { label: 'Start review', icon: Play, onSelect: () => setActive(item) },
      {
        label: item.block ? 'Move to the next free 30 minutes' : 'Plan 30 minutes',
        icon: CalendarClock,
        onSelect: () => reschedule(item)
      },
      item.block && {
        label: 'Show on calendar',
        icon: CalendarDays,
        onSelect: () => navigate(`/?block=${item.block!.id}`)
      }
    ])
  const lastRating = (review: ReviewItem): ReviewRating | null =>
    data?.lectures
      .find((l) => l.lectureId === review.lectureId)
      ?.reviews.filter((x) => x.rating)
      .at(-1)?.rating ?? null

  const refresh = () => qc.invalidateQueries()
  const reschedule = async (review: ReviewItem) => {
    setError(null)
    try {
      await call('reviews:reschedule', review.id)
      await refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const weekByDay = useMemo(() => {
    const groups = new Map<string, ReviewItem[]>()
    for (const item of data?.week ?? []) {
      const key = day(item.block!.start)
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    return [...groups.entries()]
  }, [data])

  const byModule = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof data>['lectures']>()
    for (const l of data?.lectures ?? [])
      groups.set(l.moduleId, [...(groups.get(l.moduleId) ?? []), l])
    return [...groups.entries()]
  }, [data])

  return (
    <div className={r.page}>
      <header className={r.header}>
        <h1 className={r.title}>Revision</h1>
        <span className={r.badge}>Experimental</span>
        <span className={r.subtitle}>
          30-minute reviews after each write-up, at about +1, +3, +7, +21 and +60 days.
        </span>
      </header>
      {error && <p className={r.error}>{error}</p>}

      <section className={r.section}>
        <h2 className={r.sectionTitle}>
          Due now <span className={r.count}>{data?.due.length ?? 0}</span>
        </h2>
        <div className={r.card}>
          {data?.due.length === 0 && <p className={r.empty}>Nothing due. Nice.</p>}
          {data?.due.map((item) => (
            <div
              key={item.id}
              className={`cat ${r.row}`}
              style={{ '--cat': item.colour } as CSSProperties}
              onContextMenu={(e) => menu(e, item)}
            >
              <span className={r.dot} />
              <div className={r.grow}>
                <div>
                  {item.lectureTitle}{' '}
                  <span className={r.muted}>
                    · review {item.step} of {item.steps}
                  </span>
                </div>
                <div className={r.muted} data-overdue={item.status === 'overdue' || undefined}>
                  {item.status === 'overdue' ? `Overdue since ${dateLabel(item.due)}` : 'Due today'}
                  {' · '}
                  {item.block && item.block.outcome === 'none'
                    ? `planned ${day(item.block.start)}, ${formatClock(item.block.start)}`
                    : 'not planned'}
                </div>
              </div>
              <button
                className={r.button}
                onClick={() => void reschedule(item)}
                title="Find a new 30 minutes for it"
              >
                <CalendarClock size={13} /> {item.block ? 'Move' : 'Plan'}
              </button>
              <button className={r.primary} onClick={() => setActive(item)}>
                <Play size={12} /> Start
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className={r.section}>
        <h2 className={r.sectionTitle}>This week</h2>
        <div className={r.card}>
          {weekByDay.length === 0 && <p className={r.empty}>No reviews planned this week.</p>}
          {weekByDay.map(([label, items]) => (
            <div key={label} className={r.dayGroup}>
              <div className={r.dayLabel}>{label}</div>
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`cat ${r.weekRow}`}
                  style={{ '--cat': item.colour } as CSSProperties}
                  onContextMenu={(e) => menu(e, item)}
                >
                  <span className={`${r.time} num`}>{formatClock(item.block!.start)}</span>
                  <span className={r.dot} />
                  <span className={r.grow}>
                    {item.lectureTitle} <span className={r.muted}>· review {item.step}</span>
                  </span>
                  {item.block?.attention && (
                    <span className={r.attention} title={item.block.attention}>
                      outside hours
                    </span>
                  )}
                  <button className={r.link} onClick={() => setActive(item)}>
                    Start
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className={r.section}>
        <h2 className={r.sectionTitle}>Lectures</h2>
        {byModule.length === 0 && (
          <div className={r.card}>
            <p className={r.empty}>
              <Brain size={16} /> Reviews start once a write-up is marked done.
            </p>
          </div>
        )}
        {byModule.map(([moduleId, lectures]) => {
          const label = modules.find((m) => m.id === moduleId)
          const hard = lectures
            .filter((l) => l.reviews.filter((x) => x.rating).at(-1)?.rating === 'hard')
            .map((l) => l.lectureTitle)
          return (
            <div
              key={moduleId}
              className={`cat ${r.moduleCard}`}
              style={{ '--cat': label?.colour } as CSSProperties}
            >
              <div className={r.moduleHeader}>
                <span className={r.dot} />
                <strong>{label?.name ?? moduleId}</strong>
                <span className={r.spacer} />
                <CopyPromptButton
                  prompt={moduleReviewPrompt({
                    moduleName: label?.name ?? moduleId,
                    hardLectures: hard,
                    lectureCount: lectures.length
                  })}
                  label="Copy module review prompt"
                  title="A prompt for a review across this module's Claude project, focused on lectures rated hard"
                />
              </div>
              {lectures.map((l) => {
                const next = l.reviews.find((x) => !x.doneAt)
                return (
                  <div key={l.lectureId} className={r.lectureRow}>
                    <span className={`${r.lectureNo} num`}>{l.lectureTitle}</span>
                    <span className={r.history} aria-label="Review history">
                      {l.reviews.map((x) => (
                        <span
                          key={x.id}
                          className={r.pip}
                          data-rating={x.rating ?? (x.doneAt ? 'ok' : undefined)}
                          data-open={!x.doneAt || undefined}
                          title={
                            x.doneAt
                              ? `Review ${x.step}: ${x.rating ? RATING_LABEL[x.rating] : 'done'} (${day(x.doneAt)})`
                              : `Review ${x.step} due ${dateLabel(x.due)}`
                          }
                        />
                      ))}
                    </span>
                    <span className={r.muted}>
                      {next ? `Next: ${dateLabel(next.due)}` : 'All reviews done'}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </section>

      {active && (
        <ReviewSession
          review={active}
          moduleName={moduleName(active.moduleId)}
          lastRating={lastRating(active)}
          onClose={() => setActive(null)}
          onSave={async (input) => {
            await call('reviews:rate', active.id, input)
            await refresh()
          }}
        />
      )}
    </div>
  )
}
