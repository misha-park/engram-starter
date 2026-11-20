import { useEffect, useRef, useState } from 'react'
import type { ProfileName } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { call } from '../lib/api'
import { useProfile, useResetDemo, useSwitchProfile } from '../lib/queries'
import { AvailabilitySection } from './AvailabilitySection'
import { ClaudeSection } from './ClaudeSection'
import { FocusSection } from './FocusSection'
import { TimetableSection } from './TimetableSection'
import { LinkedCalendarsSection } from './LinkedCalendarsSection'
import { TotSection } from './TotSection'
import { GoogleSection } from './GoogleSection'
import { MoodleSection } from './MoodleSection'
import { BackupSection } from './BackupSection'
import { UpdatesSection } from './UpdatesSection'
import s from './Page.module.css'

// Availability rules, timetable, Claude, Tot, Google, backups, the data profile and the setup
// wizard (which moves you onto real data).

/** A list of the page's sections down the right, to jump to one; the one in view is lit. */
function SettingsIndex({ page }: { page: React.RefObject<HTMLDivElement | null> }) {
  const [titles, setTitles] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const root = page.current
    if (!root) return
    const read = () => {
      const hs = [...root.querySelectorAll<HTMLHeadingElement>('section > h2')]
      setTitles(hs.map((h) => h.textContent ?? ''))
      // The last heading above the upper third of the page is the one being read.
      const top = root.getBoundingClientRect().top + root.clientHeight / 3
      const current = hs.filter((h) => h.getBoundingClientRect().top < top).pop() ?? hs[0]
      setActive(current?.textContent ?? null)
    }
    read()
    const t = setTimeout(read, 600) // sections that load their data later
    root.addEventListener('scroll', read, { passive: true })
    return () => {
      clearTimeout(t)
      root.removeEventListener('scroll', read)
    }
  }, [page])
  const go = (title: string) =>
    [...(page.current?.querySelectorAll<HTMLHeadingElement>('section > h2') ?? [])]
      .find((h) => h.textContent === title)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (titles.length < 3) return null
  return (
    <nav className={s.pageIndex} aria-label="Settings sections">
      {titles.map((t) => (
        <button key={t} aria-current={t === active || undefined} onClick={() => go(t)}>
          {t}
        </button>
      ))}
    </nav>
  )
}

export function SettingsPage() {
  const pageRef = useRef<HTMLDivElement>(null)
  const { data: profile } = useProfile()
  const reset = useResetDemo()
  const switchProfile = useSwitchProfile()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: term } = useQuery({ queryKey: ['term'], queryFn: () => call('term:status') })
  const simulateTermEnd = async (on: boolean) => {
    await call('term:simulate', on)
    await qc.invalidateQueries({ queryKey: ['term'] })
  }

  const choose = (name: ProfileName) => {
    if (!profile || profile.active === name) return
    switchProfile.mutate(name)
  }

  const resetDemo = () => {
    if (window.confirm('Delete all demo data and regenerate it from scratch?')) reset.mutate()
  }

  return (
    <div className={`${s.page} ${s.withIndex}`} ref={pageRef}>
      <header className={s.header}>
        <h1 className={s.title}>Settings</h1>
      </header>
      <SettingsIndex page={pageRef} />

      <AvailabilitySection />

      <TimetableSection />

      <LinkedCalendarsSection />

      <ClaudeSection />

      <FocusSection />

      <TotSection />

      <GoogleSection />

      <MoodleSection />

      <UpdatesSection />
      <BackupSection />

      <section className={s.section}>
        <h2 className={s.sectionTitle}>Data</h2>
        <div className={s.card}>
          <div className={s.row}>
            <div className={s.grow}>
              <div>Setup</div>
              <div className={s.muted}>
                {profile?.active === 'real'
                  ? 'Start date, timetable, modules, your week and connections, step by step.'
                  : 'Moves you onto your real data, step by step. Demo data is kept.'}
              </div>
            </div>
            <button className={s.button} onClick={() => navigate('/setup')}>
              {profile?.active === 'real' ? 'Open setup' : 'Set up real data'}
            </button>
          </div>
          <div className={s.row}>
            <div className={s.grow}>
              <div>Profile</div>
              <div className={s.muted}>
                Demo and real data live in separate databases and never mix.
              </div>
            </div>
            <div className={s.segmented} role="group" aria-label="Profile">
              {(['demo', 'real'] as const).map((name) => (
                <button
                  key={name}
                  aria-pressed={profile?.active === name}
                  onClick={() => choose(name)}
                >
                  {name === 'demo' ? 'Demo' : 'Real'}
                </button>
              ))}
            </div>
          </div>
          <div className={s.row}>
            <div className={s.grow}>
              <div>Reset demo data</div>
              <div className={s.muted}>
                {reset.data
                  ? `Regenerated ${reset.data.blocks} blocks, ${reset.data.sessions} sessions and ${reset.data.todos} todos.`
                  : 'Regenerates every demo record, with dates around the current week.'}
              </div>
            </div>
            <button
              className={s.button}
              onClick={resetDemo}
              disabled={profile?.active !== 'demo' || reset.isPending}
            >
              {reset.isPending ? 'Resetting…' : 'Reset demo data'}
            </button>
          </div>
          {profile?.active === 'demo' && (
            <div className={s.row}>
              <div className={s.grow}>
                <div>Pretend term 2 has ended</div>
                <div className={s.muted}>
                  Shows the exam-season reminder on the rail, which normally appears two weeks after
                  the last lecture of term 2.
                </div>
              </div>
              <label className={s.switch}>
                <input
                  type="checkbox"
                  checked={!!term?.simulated}
                  onChange={(e) => void simulateTermEnd(e.target.checked)}
                />
                {term?.simulated ? 'On' : 'Off'}
              </label>
            </div>
          )}
          {profile && (
            <div className={s.row}>
              <div className={s.grow}>
                <div>Database</div>
                <div className={s.mono}>{profile.dbPath}</div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
