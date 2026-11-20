import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Temporal } from 'temporal-polyfill'
import type { DissertationOverview, DissertationSettings } from '@shared/types'
import { atLocalTime, formatClock, toIso, zoned } from '@core/time'
import { call } from '../../lib/api'
import { errorMessage, useModules } from '../../lib/queries'
import { SidePanel } from '../../shell/SidePanel'
import { DateField } from '../../ui/DateField'
import { TimeField } from '../../ui/TimeField'
import { useDissAction } from './useDissertation'
import d from './Dissertation.module.css'

const dayLabel = (date: string) =>
  Temporal.PlainDate.from(date).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })

/** Title, module, submission date, your viva, word target, start date and Zotero collection. */
export function SettingsPanel({
  data,
  onClose
}: {
  data: DissertationOverview
  onClose: () => void
}) {
  const s = data.settings
  const action = useDissAction()
  const { data: modules = [] } = useModules()
  const collections = useQuery({
    queryKey: ['zoteroCollections'],
    queryFn: () => call('zotero:collections'),
    retry: false
  })
  const [title, setTitle] = useState(s.title)
  const [target, setTarget] = useState(s.wordTarget ? String(s.wordTarget) : '')
  const save = (patch: Partial<DissertationSettings>) =>
    void action.run(() => call('diss:updateSettings', patch))
  const custom = !!s.vivaDate && !data.vivaDays.includes(s.vivaDate)
  const [vivaMode, setVivaMode] = useState<'feed' | 'custom'>(
    custom || data.vivaDays.length === 0 ? 'custom' : 'feed'
  )

  return (
    <SidePanel title="Dissertation settings" onClose={onClose}>
      <div className={d.setting}>
        <label className={d.settingLabel} htmlFor="diss-title">
          Title
        </label>
        <input
          id="diss-title"
          className={d.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== s.title && save({ title })}
        />
      </div>

      <div className={d.setting}>
        <div className={d.settingLabel}>Module</div>
        <select
          className={d.select}
          value={s.moduleId ?? ''}
          aria-label="Module"
          onChange={(e) => save({ moduleId: e.target.value || null })}
        >
          <option value="">None</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.shortLabel} · {m.name}
            </option>
          ))}
        </select>
        <p className={d.hint}>Sessions take its colour.</p>
      </div>

      <div className={d.setting}>
        <div className={d.settingLabel}>Submission</div>
        <div className={d.formRow}>
          <DateField
            value={s.submissionDue ? zoned(s.submissionDue).toPlainDate().toString() : ''}
            ariaLabel="Submission date"
            onChange={(v) =>
              save({
                submissionDue: toIso(
                  atLocalTime(v, s.submissionDue ? formatClock(s.submissionDue) : '12:00')
                )
              })
            }
          />
          {s.submissionDue && (
            <TimeField
              value={formatClock(s.submissionDue)}
              ariaLabel="Submission time"
              onChange={(v) =>
                save({
                  submissionDue: toIso(atLocalTime(zoned(s.submissionDue!).toPlainDate(), v))
                })
              }
            />
          )}
        </div>
      </div>

      <div className={d.setting}>
        <div className={d.settingLabel}>Your viva</div>
        {data.vivaDays.length > 0 && (
          <div className={d.segmented} role="group" aria-label="Viva date from">
            <button aria-pressed={vivaMode === 'feed'} onClick={() => setVivaMode('feed')}>
              From the timetable
            </button>
            <button aria-pressed={vivaMode === 'custom'} onClick={() => setVivaMode('custom')}>
              Another date
            </button>
          </div>
        )}
        <div className={d.formRow}>
          {vivaMode === 'feed' ? (
            <select
              className={d.select}
              value={s.vivaDate && data.vivaDays.includes(s.vivaDate) ? s.vivaDate : ''}
              aria-label="Viva day"
              onChange={(e) => save({ vivaDate: e.target.value || null })}
            >
              <option value="">Choose your day</option>
              {data.vivaDays.map((day) => (
                <option key={day} value={day}>
                  {dayLabel(day)}
                </option>
              ))}
            </select>
          ) : (
            <DateField
              value={s.vivaDate ?? ''}
              ariaLabel="Viva date"
              onChange={(v) => save({ vivaDate: v })}
            />
          )}
          <TimeField
            value={s.vivaTime ?? '09:00'}
            ariaLabel="Viva time"
            onChange={(v) => save({ vivaTime: v })}
          />
        </div>
        <p className={d.hint}>
          The timetable lists the cohort’s viva sessions; your own slot is the one you enter here.
        </p>
      </div>

      <div className={d.setting}>
        <label className={d.settingLabel} htmlFor="diss-target">
          Word target
        </label>
        <input
          id="diss-target"
          className={`${d.input} ${d.short}`}
          value={target}
          inputMode="numeric"
          onChange={(e) => setTarget(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => {
            const n = target ? Number(target) : null
            if (n !== s.wordTarget) save({ wordTarget: n })
          }}
        />
      </div>

      <div className={d.setting}>
        <div className={d.settingLabel}>Timeline starts</div>
        <DateField
          value={s.startedOn ?? ''}
          ariaLabel="Timeline start"
          onChange={(v) => save({ startedOn: v })}
        />
      </div>

      <div className={d.setting}>
        <div className={d.settingLabel}>Zotero collection</div>
        {collections.isError ? (
          <p className={d.error}>{errorMessage(collections.error)}</p>
        ) : (
          <select
            className={d.select}
            value={s.zoteroCollectionKey ?? ''}
            aria-label="Zotero collection"
            onChange={(e) => {
              const c = collections.data?.find((x) => x.key === e.target.value)
              save({ zoteroCollectionKey: c?.key ?? null, zoteroCollectionName: c?.path ?? null })
            }}
          >
            <option value="">{collections.isLoading ? 'Loading…' : 'Choose a collection'}</option>
            {collections.data?.map((c) => (
              <option key={c.key} value={c.key}>
                {'\u2003'.repeat(c.depth)}
                {c.name} ({c.numItems})
              </option>
            ))}
          </select>
        )}
        <p className={d.hint}>
          Read from Zotero on this Mac (Zotero must be open). Choose your dissertation’s main
          folder: its subfolders are included. The reading list syncs from it; the app never changes
          your library.
        </p>
      </div>
      {action.error && <p className={d.error}>{action.error}</p>}
    </SidePanel>
  )
}
