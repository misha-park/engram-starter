import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen } from 'lucide-react'
import { call } from '../lib/api'
import { formatSize } from '../lib/files'
import { errorMessage } from '../lib/queries'
import { when } from '../lib/when'
import s from './Page.module.css'

/** iCloud Drive's long path, shortened for display. */
const shortPath = (p: string) =>
  p
    .replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/, 'iCloud Drive')
    .replace(/^\/Users\/[^/]+/, '~')

/** Daily backups of this profile's data, with retention, and restoring one. */
export function BackupSection() {
  const qc = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['backup'], queryFn: () => call('backup:status') })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  if (!status) return null

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
      await qc.invalidateQueries({ queryKey: ['backup'] })
    }
  }
  const list = showAll ? status.backups : status.backups.slice(0, 3)

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Backups</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Back up every day</div>
            <div className={s.muted}>
              The database, records and attached files, while Engram is open. Every backup from the
              last day is kept, then one a day for two weeks and one a week for eight weeks.
            </div>
          </div>
          <label className={s.switch}>
            <input
              type="checkbox"
              checked={status.enabled}
              onChange={(e) =>
                void run('enable', () => call('backup:set', { enabled: e.target.checked }))
              }
            />
            {status.enabled ? 'On' : 'Off'}
          </label>
        </div>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Where</div>
            <div className={s.muted} title={status.profileFolder}>
              {shortPath(status.profileFolder)}
            </div>
          </div>
          <button
            className={s.button}
            onClick={() => void run('reveal', () => call('backup:reveal'))}
          >
            <FolderOpen size={13} /> Show
          </button>
          <button
            className={s.button}
            onClick={() => void run('folder', () => call('backup:chooseFolder'))}
          >
            Change…
          </button>
          {!status.usingDefault && (
            <button
              className={s.button}
              onClick={() => void run('default', () => call('backup:set', { folder: null }))}
            >
              Use iCloud Drive
            </button>
          )}
        </div>
        <div className={s.row}>
          <div className={s.grow}>
            {status.lastError ? (
              <div className={s.bad}>{status.lastError}</div>
            ) : (
              <div className={s.muted}>
                {status.lastBackupAt
                  ? `Last backup ${when(status.lastBackupAt)}`
                  : status.backups.length
                    ? `Newest backup ${when(status.backups[0].at)}`
                    : 'No backup yet.'}
              </div>
            )}
          </div>
          <button
            className={s.button}
            disabled={!!busy}
            onClick={() => void run('now', () => call('backup:now'))}
          >
            {busy === 'now' ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
        {list.map((b) => (
          <div key={b.name} className={s.row}>
            <div className={s.grow}>
              <div className="num">{when(b.at)}</div>
              <div className={s.muted}>{formatSize(b.bytes)} database</div>
            </div>
            <button
              className={s.button}
              onClick={() => void run('show', () => call('backup:reveal', b.name))}
            >
              Show in Finder
            </button>
            <button
              className={s.button}
              disabled={!!busy}
              onClick={() =>
                window.confirm(
                  `Restore the backup from ${when(b.at)}? Everything since then is replaced (a backup of how things are now is made first, so this can be undone).`
                ) && void run('restore', () => call('backup:restore', b.name))
              }
            >
              Restore
            </button>
          </div>
        ))}
        {status.backups.length > 3 && (
          <div className={s.row}>
            <button className={s.link} onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${status.backups.length} backups`}
            </button>
          </div>
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
