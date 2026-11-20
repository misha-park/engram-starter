import { useState, type CSSProperties } from 'react'
import {
  Check,
  CircleAlert,
  CircleArrowUp,
  Moon,
  PanelRight,
  RefreshCw,
  Square,
  Timer
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { SyncResult } from '@shared/types'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import { formatMinutes } from '@core/time'
import { useProfile, useStopTimer, useTimer, useTodaySummary } from '../lib/queries'
import { useNow } from '../lib/useNow'
import { ManualTimePopover } from '../timer/ManualTimePopover'
import { restartToUpdate, useUpdateStatus } from '../lib/updates'
import { ShutdownDialog } from './ShutdownDialog'
import s from './TopBar.module.css'

interface Props {
  claudeOpen: boolean
  onToggleClaude: () => void
}

export function TopBar({ claudeOpen, onToggleClaude }: Props) {
  const { data: summary } = useTodaySummary()
  const { data: profile } = useProfile()
  const [manualOpen, setManualOpen] = useState(false)
  const [shutdownOpen, setShutdownOpen] = useState(false)

  return (
    <header className={s.bar}>
      <TimerChip />

      <div className={s.spacer} />

      {summary && (
        <>
          <div className={s.stat} title="Logged today, and unfinished planned work left today">
            <span className={s.statLabel}>Today</span>
            <span className="num">
              {formatMinutes(summary.workedTodayMinutes)} worked ·{' '}
              {formatMinutes(summary.remainingTodayMinutes)} left
            </span>
          </div>
          {summary.unbrokenMinutes >= 60 && (
            <div className={s.stat} title="Continuous work without a break">
              <span className={s.statLabel}>No break for</span>
              <span className="num">{formatMinutes(summary.unbrokenMinutes)}</span>
            </div>
          )}
          <div className={s.anchor}>
            <button
              className={s.statButton}
              title="Self-study this week (Mon–Sun) against your target. Right-click to add time."
              onContextMenu={(e) => {
                e.preventDefault()
                setManualOpen(true)
              }}
            >
              <span className={s.statLabel}>Week</span>
              <span className="num">
                {formatMinutes(summary.weekMinutes)}
                {summary.weekTargetMinutes ? ` / ${formatMinutes(summary.weekTargetMinutes)}` : ''}
              </span>
            </button>
            {manualOpen && <ManualTimePopover onClose={() => setManualOpen(false)} />}
          </div>
        </>
      )}

      <UpdateButton />

      <SyncButton />

      <button
        className={s.iconButton}
        onClick={() => setShutdownOpen(true)}
        title="Wrap up the day"
        aria-label="Wrap up the day"
      >
        <Moon size={15} strokeWidth={1.75} />
      </button>

      {profile?.active === 'demo' && <span className={s.demo}>Demo</span>}

      <button
        className={s.iconButton}
        onClick={onToggleClaude}
        aria-pressed={claudeOpen}
        title="Claude (⌘J)"
        aria-label="Claude assistant"
      >
        <PanelRight size={16} strokeWidth={1.75} />
      </button>
      {shutdownOpen && <ShutdownDialog onClose={() => setShutdownOpen(false)} />}
    </header>
  )
}

/** Shown once `npm run release` has staged a new version: back up, quit, reopen on it. */
function UpdateButton() {
  const { data: status } = useUpdateStatus()
  const [busy, setBusy] = useState(false)
  const ready = status?.ready
  if (!ready) return null
  const { changes, more } = ready.notes
  const title = changes.length
    ? `What's new:\n${changes.map((c) => `• ${c}`).join('\n')}${more ? `\n… and ${more} more` : ''}`
    : 'A new version of Engram is ready.'
  const run = async () => {
    setBusy(true)
    try {
      if (!(await restartToUpdate())) setBusy(false)
    } catch (e) {
      setBusy(false)
      window.alert(errorMessage(e))
    }
  }
  return (
    <button className={s.update} disabled={busy} onClick={() => void run()} title={title}>
      <CircleArrowUp size={14} strokeWidth={1.75} />
      {busy ? 'Restarting…' : 'Restart to update'}
    </button>
  )
}

/** The running timer: block name, elapsed time (ticking every second) and a stop button. */
function TimerChip() {
  const { data: timer } = useTimer()
  const stop = useStopTimer()
  const now = useNow(1000)
  if (!timer) {
    return (
      <div className={s.timer} title="No timer running. Start one from a flexible block.">
        <Timer size={14} strokeWidth={1.75} />
        <span>No timer</span>
      </div>
    )
  }
  const total = Math.max(0, Math.floor((now.epochMilliseconds - Date.parse(timer.start)) / 1000))
  const [h, m, sec] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
  return (
    <div
      className={`cat ${s.running}`}
      style={{ '--cat': timer.colour ?? undefined } as CSSProperties}
    >
      <span className={s.pulse} />
      <span className={s.runningTitle}>{timer.title}</span>
      <span className={`${s.elapsed} num`}>
        {h}:{String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')}
      </span>
      <button
        className={s.stop}
        onClick={() => stop.mutate()}
        title="Stop timer"
        aria-label="Stop timer"
        disabled={stop.isPending}
      >
        <Square size={11} />
      </button>
    </div>
  )
}

/**
 * Sync everything now: the timetable, Tot, Moodle and Google Calendar (each that's set up).
 * Shows each one's result in a small popover; red when one failed.
 */
function SyncButton() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<SyncResult[] | null>(null)
  const [open, setOpen] = useState(false)
  const failed = results?.some((r) => !r.ok)
  const run = async () => {
    setBusy(true)
    setOpen(false)
    try {
      setResults(await call('sync:all'))
    } catch (e) {
      setResults([{ name: 'Timetable', ok: false, detail: errorMessage(e) }])
    } finally {
      setBusy(false)
      setOpen(true)
      await qc.invalidateQueries()
    }
  }
  return (
    <div
      className={s.anchor}
      onMouseLeave={() => setOpen(false)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
    >
      <button
        className={s.iconButton}
        data-failed={failed || undefined}
        disabled={busy}
        onClick={() => void run()}
        onMouseEnter={() => results && !busy && setOpen(true)}
        title={
          busy
            ? 'Syncing…'
            : results
              ? undefined
              : 'Sync now: timetable, Tot, Moodle and Google Calendar'
        }
        aria-label="Sync now"
      >
        <RefreshCw size={15} strokeWidth={1.75} className={busy ? s.spin : undefined} />
      </button>
      {open && results && (
        <div className={s.syncPopover} role="status">
          {results.length === 0 && <p className={s.syncEmpty}>Nothing is connected yet.</p>}
          {results.map((r) => (
            <div key={r.name} className={s.syncRow} data-ok={r.ok || undefined}>
              {r.ok ? <Check size={13} /> : <CircleAlert size={13} />}
              <span className={s.syncName}>{r.name}</span>
              <span className={s.syncDetail}>{r.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
