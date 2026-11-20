import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GraduationCap, X } from 'lucide-react'
import { call } from '../lib/api'
import d from './Dialog.module.css'
import s from './Rail.module.css'

/**
 * Appears on the rail once term 2 has ended (inferred from the timetable), prompting the
 * set-up of exam-season mode. It goes for good once that mode exists.
 */
export function ExamSeasonButton() {
  const { data: term } = useQuery({ queryKey: ['term'], queryFn: () => call('term:status') })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!term?.termTwoEnded) return null
  const last = term.lastLecture
    ? new Date(`${term.lastLecture}T12:00:00`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'long'
      })
    : null

  return (
    <>
      <button
        className={s.examButton}
        onClick={() => setOpen(true)}
        title="Term 2 is over: set up exam season"
        aria-label="Set up exam season"
      >
        <GraduationCap size={20} strokeWidth={1.75} />
      </button>
      {open && (
        <div className={d.backdrop} onMouseDown={() => setOpen(false)}>
          <div
            className={d.dialog}
            role="dialog"
            aria-label="Exam season"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className={d.header}>
              <h2 className={d.title}>Time for exam season</h2>
              <button className={d.close} onClick={() => setOpen(false)} title="Close (Esc)">
                <X size={14} />
              </button>
            </header>
            <div className={d.body}>
              <p className={d.lead}>
                {term.simulated
                  ? 'The demo is pretending term 2 has ended.'
                  : `Term 2 looks finished: the last lecture was on ${last}, and none have followed for two weeks.`}
              </p>
              <p>
                Exam-season mode will switch your planning from write-ups to revision. It isn’t
                built yet: you’ll design it now that term 2 is over. This button stays here until it
                exists.
              </p>
            </div>
            <div className={d.actions}>
              <span className={d.spacer} />
              <button className={d.primary} onClick={() => setOpen(false)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
