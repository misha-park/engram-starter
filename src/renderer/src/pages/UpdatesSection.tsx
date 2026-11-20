import { useState } from 'react'
import { buildLabel } from '@core/update'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import { restartToUpdate, useUpdateStatus } from '../lib/updates'
import { when } from '../lib/when'
import s from './Page.module.css'

/** The installed app's version, a staged update (Restart to update) and Roll back (docs/ORIGINAL-SPEC.md §9). */
export function UpdatesSection() {
  const { data: status } = useUpdateStatus()
  const [busy, setBusy] = useState<'update' | 'rollback' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!status) return null

  const run = async (what: 'update' | 'rollback', fn: () => Promise<unknown>) => {
    setBusy(what)
    setError(null)
    try {
      // On success Engram quits, so the busy label stays until then.
      if ((await fn()) === false) setBusy(null)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Updates</h2>
      <div className={s.card}>
        {!status.packaged ? (
          <div className={s.row}>
            <div className={s.grow}>
              <div>Running from source</div>
              <div className={s.muted}>
                This is <code>npm run dev</code>, with its own data. To update the installed Engram,
                run <code>npm run release</code> in the repo.
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className={s.row}>
              <div className={s.grow}>
                <div>This version</div>
                <div className={s.muted}>
                  {status.current
                    ? `${buildLabel(status.current)}, built ${when(status.current.builtAt)}`
                    : 'Installed before updates were added.'}
                </div>
              </div>
            </div>
            {status.ready ? (
              <div className={s.row}>
                <div className={s.grow}>
                  <div>Update ready</div>
                  <div className={s.muted}>
                    {buildLabel(status.ready.build)}, built {when(status.ready.build.builtAt)}.
                    Engram backs up, closes and reopens on it.
                  </div>
                  {status.ready.notes.changes.length > 0 && (
                    <ul className={s.muted}>
                      {status.ready.notes.changes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                      {status.ready.notes.more > 0 && <li>… and {status.ready.notes.more} more</li>}
                    </ul>
                  )}
                </div>
                <button
                  className={s.button}
                  disabled={!!busy}
                  onClick={() => void run('update', restartToUpdate)}
                >
                  {busy === 'update' ? 'Restarting…' : 'Restart to update'}
                </button>
              </div>
            ) : (
              <div className={s.row}>
                <div className={s.grow}>
                  <div className={s.muted}>
                    Up to date. A new version from <code>npm run release</code> shows up here within
                    a minute.
                  </div>
                </div>
              </div>
            )}
            {status.previous && (
              <div className={s.row}>
                <div className={s.grow}>
                  <div>Previous version</div>
                  <div className={s.muted}>
                    {status.previous.build
                      ? `${buildLabel(status.previous.build)}, built ${when(status.previous.build.builtAt)}`
                      : 'The version installed before updates were added.'}
                  </div>
                </div>
                <button
                  className={s.button}
                  disabled={!!busy}
                  onClick={() =>
                    window.confirm(
                      'Go back to the previous version? Engram closes and reopens on it, and this version becomes the previous one (so you can come back).\n\nYour data stays as it is. If this version changed the database and the old one misbehaves, restore the backup made before the update (Backups, below).'
                    ) && void run('rollback', () => call('update:rollback'))
                  }
                >
                  {busy === 'rollback' ? 'Restarting…' : 'Roll back'}
                </button>
              </div>
            )}
          </>
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
