import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { errorMessage, useImportTimetable, useLastImport, useProfile } from '../lib/queries'
import { formatClock, zoned } from '@core/time'
import s from './Page.module.css'

/** Timetable feed: where it comes from, the last import and a manual re-import. */
export function TimetableSection() {
  const { data: profile } = useProfile()
  const { data: last } = useLastImport()
  const run = useImportTimetable()
  const isDemo = profile?.active === 'demo'
  const { data: feed } = useQuery({
    queryKey: ['feedStatus'],
    queryFn: () => call('feed:status'),
    enabled: profile?.active === 'real'
  })
  const canImport = isDemo || !!feed?.connected
  const { data: hidden = 0 } = useQuery({
    queryKey: ['timetableHidden'],
    queryFn: () => call('timetable:hiddenCount')
  })
  const qc = useQueryClient()
  const restore = async () => {
    await call('timetable:restoreHidden')
    await qc.invalidateQueries()
  }
  const { data: hiddenEvents = [] } = useQuery({
    queryKey: ['timetableHiddenList', hidden],
    queryFn: () => call('timetable:listHidden'),
    enabled: hidden > 0
  })
  const restoreOne = async (uid: string) => {
    await call('timetable:restoreHiddenEvent', uid)
    await qc.invalidateQueries()
  }

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Timetable</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Source</div>
            <div className={s.muted}>
              {isDemo
                ? 'A fake feed in the university format, generated around the current week.'
                : feed?.connected
                  ? 'Your UCL timetable, checked every 3 hours. The link is kept in the Keychain; change it in setup.'
                  : 'No timetable link yet: add it in setup. It is kept in the Keychain, never in files.'}
            </div>
          </div>
          <button
            className={s.button}
            onClick={() => run.mutate()}
            disabled={!canImport || run.isPending}
          >
            {run.isPending ? 'Importing…' : 'Import now'}
          </button>
        </div>
        {hidden > 0 && (
          <div className={s.row}>
            <div className={s.grow}>
              <div>Deleted from the timetable</div>
              <div className={`${s.muted} num`}>
                {hidden === 1 ? '1 event you deleted stays' : `${hidden} events you deleted stay`}{' '}
                off your calendar.
              </div>
            </div>
            <button className={s.button} onClick={() => void restore()}>
              Restore all
            </button>
          </div>
        )}
        {hiddenEvents.slice(0, 12).map((e) => (
          <div key={e.uid} className={s.row}>
            <div className={`${s.grow} num`}>
              {e.moduleName} · {e.feedType}
              <span className={s.muted}>
                {' '}
                ·{' '}
                {zoned(e.start)
                  .toPlainDate()
                  .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                , {formatClock(e.start)}–{formatClock(e.end)}
              </span>
            </div>
            <button className={s.button} onClick={() => void restoreOne(e.uid)}>
              Restore
            </button>
          </div>
        ))}
        {feed?.lastError && (
          <div className={s.row}>
            <div className={s.errorText}>Last check failed: {feed.lastError}</div>
          </div>
        )}
        {last && (
          <div className={s.row}>
            <div className={s.grow}>
              <div>
                Last import{' '}
                <span className="num">
                  {zoned(last.at)
                    .toPlainDate()
                    .toLocaleString('en-GB', { day: 'numeric', month: 'short' })}
                  , {formatClock(last.at)}
                </span>
              </div>
              <div className={`${s.muted} num`}>
                {last.events} events: {last.added} new, {last.updated} changed, {last.removed}{' '}
                removed, {last.hidden} hidden [None]. {last.lectures} lectures,{' '}
                {last.writeUpsPlaced} write-ups placed
                {last.writeUpsNeedingAttention > 0 &&
                  `, ${last.writeUpsNeedingAttention} needing attention`}
                .
              </div>
              {last.unmappedNames.length > 0 && (
                <div className={s.errorText}>
                  Not mapped to a module: {last.unmappedNames.join(', ')}.{' '}
                  <Link to="/modules">Map them in Modules</Link>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {run.error && <p className={s.errorText}>{errorMessage(run.error)}</p>}
    </section>
  )
}
