import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, RefreshCw } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { formatClock, TZ, zoned } from '@core/time'
import { call } from '../lib/api'
import { errorMessage, useModules } from '../lib/queries'
import s from './Page.module.css'

const when = (iso: string) => {
  const date = zoned(iso).toPlainDate()
  return Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO(TZ)) === 0
    ? formatClock(iso)
    : `${date.toLocaleString('en-GB', { day: 'numeric', month: 'short' })}, ${formatClock(iso)}`
}

/**
 * Moodle (UCL): sign in the way the Moodle app does, match this year's courses to modules,
 * and Engram fetches their slides, handouts and assignment briefs every few hours. The demo
 * uses a stand-in.
 */
export function MoodleSection() {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['moodle'],
    queryFn: () => call('moodle:status'),
    refetchInterval: 30_000
  })
  const { data: courses = [] } = useQuery({
    queryKey: ['moodleCourses'],
    queryFn: () => call('moodle:listCourses'),
    enabled: !!status?.connected
  })
  const { data: modules = [] } = useModules()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
      await qc.invalidateQueries({ queryKey: ['moodle'] })
      await qc.invalidateQueries({ queryKey: ['moodleCourses'] })
    }
  }

  // The first time it's connected, fetch the course list to match.
  const needsCourses = !!status?.connected && courses.length === 0 && !status.lastSyncedAt
  useEffect(() => {
    if (needsCourses)
      void call('moodle:refreshCourses').then(() =>
        qc.invalidateQueries({ queryKey: ['moodleCourses'] })
      )
  }, [needsCourses, qc])

  if (!status) return null
  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Moodle</h2>
      <div className={s.card}>
        {!status.connected ? (
          <div className={s.row}>
            <div className={s.grow}>
              <div>Connect Moodle</div>
              <div className={s.muted}>
                Opens UCL Moodle’s sign-in in a small window. Sign in there as usual: Engram never
                sees your password, only the key Moodle gives its app, which is kept in the
                Keychain. Engram then fetches lecture slides, handouts and assignment briefs.
              </div>
            </div>
            <button
              className={s.button}
              disabled={!!busy}
              onClick={() => void run('signIn', () => call('moodle:signIn'))}
            >
              {busy === 'signIn' ? 'Waiting for Moodle…' : 'Connect Moodle'}
            </button>
          </div>
        ) : (
          <>
            <div className={s.row}>
              <Check size={16} className={s.ok} />
              <div className={s.grow}>
                <div>{status.demo ? 'Demo stand-in for Moodle' : 'Connected to UCL Moodle'}</div>
                <div className={s.muted}>
                  Slides, handouts and briefs from the courses matched below, every 6 hours.
                  {status.lastSyncedAt && ` Last checked ${when(status.lastSyncedAt)}.`}
                </div>
                {status.lastError && <div className={s.errorText}>{status.lastError}</div>}
              </div>
              <button
                className={s.button}
                disabled={!!busy}
                onClick={() => void run('sync', () => call('moodle:syncNow'))}
              >
                {busy === 'sync' ? 'Fetching…' : 'Sync now'}
              </button>
              {!status.demo && (
                <button
                  className={s.button}
                  disabled={!!busy}
                  onClick={() => void run('signOut', () => call('moodle:signOut'))}
                >
                  Disconnect
                </button>
              )}
            </div>
            {courses.map((c) => (
              <div key={c.id} className={s.row}>
                <div className={s.grow}>
                  <div>
                    {c.code && <strong>{c.code} </strong>}
                    {c.title}
                  </div>
                  <div className={`${s.muted} num`}>
                    {!c.moduleId
                      ? 'Not synced'
                      : c.files || status.lastSyncedAt
                        ? `${c.files} file${c.files === 1 ? '' : 's'} fetched`
                        : 'Fetched at the next sync'}
                  </div>
                </div>
                <select
                  className={s.input}
                  aria-label={`Module for ${c.code ?? c.title}`}
                  value={c.moduleId ?? ''}
                  onChange={(e) =>
                    void run('match', () =>
                      call('moodle:setCourseModule', c.id, e.target.value || null)
                    )
                  }
                >
                  <option value="">Don’t sync</option>
                  {modules.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.shortLabel} · {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className={s.row}>
              <div className={`${s.grow} ${s.muted}`}>
                {courses.length
                  ? 'This year’s courses. Engram matched them by name; change any that are wrong.'
                  : 'Looking for this year’s courses…'}
              </div>
              <button
                className={s.button}
                disabled={!!busy}
                title="Look for new courses"
                onClick={() => void run('courses', () => call('moodle:refreshCourses'))}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </>
        )}
      </div>
      {error && <p className={s.errorText}>{error}</p>}
    </section>
  )
}
