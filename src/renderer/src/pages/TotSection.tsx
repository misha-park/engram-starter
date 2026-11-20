import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, RefreshCw } from 'lucide-react'
import type { TotStatus } from '@shared/types'
import { Temporal } from 'temporal-polyfill'
import { formatClock, TZ, zoned } from '@core/time'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import s from './Page.module.css'

const when = (iso: string) => {
  const date = zoned(iso).toPlainDate()
  const today = Temporal.Now.plainDateISO(TZ)
  return Temporal.PlainDate.compare(date, today) === 0
    ? formatClock(iso)
    : `${date.toLocaleString('en-GB', { day: 'numeric', month: 'short' })}, ${formatClock(iso)}`
}

/**
 * Tot sync: the todos in the Tot dot whose first line is "UNI". The demo uses a text file in
 * its profile folder instead of Tot.
 */
export function TotSection() {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['tot'],
    queryFn: () => call('tot:status'),
    refetchInterval: 20_000
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!status) return null
  const demo = status.source === 'file'

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      await qc.invalidateQueries()
    }
  }

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Tot</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Sync todos with Tot</div>
            <div className={s.muted}>
              {demo
                ? 'In the demo, a text file stands in for Tot’s UNI dot. Edit it and the todos follow within 20 seconds.'
                : 'Uses the dot whose first line is “UNI”. Each ○ line becomes a todo, and ticking it (●) in Tot ticks the todo. Tot must be running.'}
              {!demo &&
                (status.oneWay
                  ? ' Right now Engram only reads the dot, so todos added or ticked in Engram stay in Engram. Turn on writing back below to sync both ways.'
                  : ' Todos added or ticked in Engram are written back through your shortcut.')}
            </div>
          </div>
          <label className={s.switch}>
            <input
              type="checkbox"
              checked={status.enabled}
              onChange={(e) => void run(() => call('tot:setEnabled', e.target.checked))}
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
                Synced {when(status.lastSyncedAt)}
                {status.dot && !demo ? ` · dot ${status.dot}` : ''} · {status.linked} todos linked
              </div>
            ) : (
              <div className={s.muted}>Not synced yet.</div>
            )}
            {error && <div className={s.bad}>{error}</div>}
          </div>
          {demo && (
            <button className={s.button} onClick={() => void run(() => call('tot:openDemoFile'))}>
              Open the demo Tot file
            </button>
          )}
          <button
            className={s.button}
            disabled={busy}
            onClick={() => void run(() => call('tot:syncNow'))}
          >
            <RefreshCw size={13} /> Sync now
          </button>
        </div>
        {!demo && <WriteBack status={status} run={run} />}
      </div>
    </section>
  )
}

/**
 * Real Tot: writing back goes through a shortcut the user makes with Tot's "Set Dot" action.
 * (Tot's URL scheme would switch the dot to plain text, a monospaced font; Shortcuts doesn't.)
 */
function WriteBack({
  status,
  run
}: {
  status: TotStatus
  run: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const [name, setName] = useState(status.writeShortcut)
  const save = (patch: Partial<Pick<TotStatus, 'twoWay' | 'writeShortcut' | 'writeDot'>>) =>
    void run(() =>
      call('tot:setWriting', {
        twoWay: status.twoWay,
        writeShortcut: status.writeShortcut,
        writeDot: status.writeDot,
        ...patch
      })
    )
  return (
    <>
      <div className={s.row}>
        <div className={s.grow}>
          <div>Write back to Tot through a shortcut</div>
          <div className={s.muted}>
            In Shortcuts, make a shortcut named “{status.writeShortcut}” with one action: Tot’s{' '}
            <strong>Set Dot</strong>, with its dot set to {status.writeDot} and its text set to{' '}
            <em>Shortcut Input</em>. Run it once by hand to allow it. Engram only writes when the
            UNI list is in that dot, and checks every write.
          </div>
        </div>
        <label className={s.switch}>
          <input
            type="checkbox"
            checked={status.twoWay}
            onChange={(e) => save({ twoWay: e.target.checked })}
          />
          {status.twoWay ? 'On' : 'Off'}
        </label>
      </div>
      <div className={s.row}>
        <div className={s.grow}>
          <div>Shortcut</div>
        </div>
        {status.shortcutFound !== undefined &&
          (status.shortcutFound ? (
            <CircleCheck size={14} className={s.ok} aria-label="Found in Shortcuts" />
          ) : (
            <CircleX size={14} className={s.bad} aria-label="Not found in Shortcuts" />
          ))}
        <input
          className={s.input}
          value={name}
          aria-label="Shortcut name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== status.writeShortcut && save({ writeShortcut: name })}
        />
        <select
          className={s.input}
          value={status.writeDot}
          aria-label="The dot the shortcut writes to"
          onChange={(e) => save({ writeDot: Number(e.target.value) })}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <option key={d} value={d}>
              Dot {d}
            </option>
          ))}
        </select>
      </div>
    </>
  )
}
