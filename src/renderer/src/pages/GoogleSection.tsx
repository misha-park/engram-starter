import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { GoogleStatus } from '@shared/types'
import { formatClock, TZ, zoned } from '@core/time'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import s from './Page.module.css'

const when = (iso: string) => {
  const date = zoned(iso).toPlainDate()
  return Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO(TZ)) === 0
    ? formatClock(iso)
    : `${date.toLocaleString('en-GB', { day: 'numeric', month: 'short' })}, ${formatClock(iso)}`
}

/**
 * Google Calendar: Engram keeps its own "Engram" calendar in Google up to date (one way).
 * The demo pushes to a file instead.
 */
export function GoogleSection() {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['google'],
    queryFn: () => call('google:status'),
    refetchInterval: 15_000
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!status) return null
  const demo = status.source === 'file'

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
      await qc.invalidateQueries({ queryKey: ['google'] })
    }
  }

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Google Calendar</h2>
      <div className={s.card}>
        {!demo && !status.hasClient ? (
          <ClientSetup run={run} busy={busy} />
        ) : !demo && !status.signedIn ? (
          <div className={s.row}>
            <div className={s.grow}>
              <div>Sign in to Google</div>
              <div className={s.muted}>
                Your browser opens Google’s sign-in. Engram only asks to make its own calendar and
                change events on it: it can’t see your other calendars.
              </div>
            </div>
            <button
              className={s.button}
              disabled={!!busy}
              onClick={() => void run('signIn', () => call('google:signIn'))}
            >
              {busy === 'signIn' ? 'Waiting for Google…' : 'Sign in with Google'}
            </button>
            <button
              className={s.button}
              disabled={!!busy}
              onClick={() => void run('forget', () => call('google:forget'))}
            >
              Change client
            </button>
          </div>
        ) : (
          <SignedIn status={status} demo={demo} run={run} busy={busy} />
        )}
        {error && (
          <div className={s.row}>
            <div className={s.bad}>{error}</div>
          </div>
        )}
      </div>
    </section>
  )
}

function SignedIn({
  status,
  demo,
  run,
  busy
}: {
  status: GoogleStatus
  demo: boolean
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>
  busy: string | null
}) {
  return (
    <>
      <div className={s.row}>
        <div className={s.grow}>
          <div>Keep an “Engram” calendar in Google up to date</div>
          <div className={s.muted}>
            {demo
              ? 'In the demo, Engram writes to a local file instead of Google.'
              : 'Every block and deadline from two weeks ago to four months ahead, within seconds of a change. It only goes one way: edit in Engram, not in Google.'}
          </div>
        </div>
        <label className={s.switch}>
          <input
            type="checkbox"
            checked={status.enabled}
            onChange={(e) => void run('enable', () => call('google:setEnabled', e.target.checked))}
          />
          {status.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className={s.row}>
        <div className={s.grow}>
          {status.lastError ? (
            <div className={s.bad}>{status.lastError}</div>
          ) : status.lastSyncedAt ? (
            <div className={s.muted}>
              Updated {when(status.lastSyncedAt)} · {status.events} events
              {demo && status.demoEvents !== null ? ` in the demo file` : ''}
            </div>
          ) : (
            <div className={s.muted}>Not updated yet.</div>
          )}
        </div>
        {!demo && (
          <button
            className={s.button}
            onClick={() => void run('open', () => call('google:openCalendar'))}
          >
            <ExternalLink size={13} /> Open Google Calendar
          </button>
        )}
        <button
          className={s.button}
          disabled={!!busy}
          onClick={() => void run('sync', () => call('google:syncNow'))}
        >
          <RefreshCw size={13} /> {busy === 'sync' ? 'Updating…' : 'Update now'}
        </button>
        {!demo && (
          <button
            className={s.button}
            disabled={!!busy}
            onClick={() =>
              window.confirm(
                'Sign out of Google? The Engram calendar stays in Google but stops being updated.'
              ) && void run('signOut', () => call('google:signOut'))
            }
          >
            Sign out
          </button>
        )}
      </div>
    </>
  )
}

/** First step: the user's own Google Cloud OAuth client ("Desktop app"). */
function ClientSetup({
  run,
  busy
}: {
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>
  busy: string | null
}) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const json = id.trim().startsWith('{')
  return (
    <div className={s.row}>
      <div className={s.grow}>
        <div>Connect Google Calendar</div>
        <div className={s.muted}>
          Engram needs your own Google Cloud OAuth client: a Google Cloud project with the Google
          Calendar API turned on, an OAuth consent screen (External, published “In production” so
          the sign-in doesn’t expire after 7 days) and an OAuth client of type “Desktop app”. Paste
          the client’s downloaded JSON, or its ID and secret. They’re kept in the macOS Keychain.
        </div>
        <div className={s.stackedInputs}>
          <textarea
            className={s.input}
            rows={json ? 4 : 1}
            value={id}
            placeholder="Client ID, or the whole client JSON"
            aria-label="Client ID or JSON"
            onChange={(e) => setId(e.target.value)}
          />
          {!json && (
            <input
              className={s.input}
              type="password"
              value={secret}
              placeholder="Client secret"
              aria-label="Client secret"
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
        </div>
      </div>
      <button
        className={s.button}
        disabled={!!busy || !id.trim() || (!json && !secret.trim())}
        onClick={() => void run('client', () => call('google:setClient', id, secret))}
      >
        Save
      </button>
    </div>
  )
}
