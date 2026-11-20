import { useMemo, useState } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import {
  READING_STATUSES,
  type DissertationOverview,
  type ReadingItem,
  type ReadingStatus
} from '@shared/types'
import { call } from '../../lib/api'
import { errorMessage } from '../../lib/queries'
import { toast } from '../../ui/toastStore'
import { READING_LABEL } from './labels'
import { useDissAction } from './useDissertation'
import d from './Dissertation.module.css'

/** The reading list from Zotero: read status and the sections each item is used in. */
export function ReadingTab({
  data,
  onSettings
}: {
  data: DissertationOverview
  onSettings: () => void
}) {
  const action = useDissAction()
  const [status, setStatus] = useState<ReadingStatus | 'all'>('all')
  const [section, setSection] = useState<string>('all')
  const [result, setResult] = useState<string | null>(null)
  const s = data.settings

  const items = useMemo(
    () =>
      data.reading.filter(
        (r) =>
          (status === 'all' || r.status === status) &&
          (section === 'all' ||
            (section === 'none' ? r.sectionIds.length === 0 : r.sectionIds.includes(section)))
      ),
    [data.reading, status, section]
  )
  const count = (st: ReadingStatus) =>
    data.reading.filter((r) => !r.missing && r.status === st).length

  const sync = async () => {
    setResult(null)
    const r = await action.run(() => call('zotero:sync'))
    if (r) {
      setResult(
        `Synced: ${r.added} new, ${r.updated} updated${r.missing ? `, ${r.missing} no longer in the collection` : ''}.`
      )
    }
  }

  return (
    <div className={d.stack}>
      <div className={d.toolbar}>
        <span className={d.muted}>
          {s.zoteroCollectionName ? (
            <>
              Zotero: <strong className={d.strong}>{s.zoteroCollectionName}</strong>
              {data.zoteroSyncedAt &&
                ` · synced ${new Date(data.zoteroSyncedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
            </>
          ) : (
            <>
              No Zotero collection chosen.{' '}
              <button className={d.link} onClick={onSettings}>
                Choose one
              </button>
            </>
          )}
        </span>
        <span className={d.spacer} />
        {s.zoteroCollectionKey && (
          <button className={d.button} disabled={action.busy} onClick={() => void sync()}>
            <RefreshCw size={13} className={action.busy ? d.spin : undefined} /> Sync from Zotero
          </button>
        )}
      </div>
      {result && <p className={d.muted}>{result}</p>}
      {action.error && <p className={d.error}>{action.error}</p>}

      <div className={d.filters}>
        <div className={d.segmented} role="group" aria-label="Filter by status">
          <button aria-pressed={status === 'all'} onClick={() => setStatus('all')}>
            All <span className={d.muted}>{data.reading.filter((r) => !r.missing).length}</span>
          </button>
          {READING_STATUSES.map((st) => (
            <button key={st} aria-pressed={status === st} onClick={() => setStatus(st)}>
              {READING_LABEL[st]} <span className={d.muted}>{count(st)}</span>
            </button>
          ))}
        </div>
        <select
          className={d.select}
          value={section}
          aria-label="Filter by section"
          onChange={(e) => setSection(e.target.value)}
        >
          <option value="all">All sections</option>
          <option value="none">Not linked to a section</option>
          {data.sections.map((sec) => (
            <option key={sec.id} value={sec.id}>
              {sec.title}
            </option>
          ))}
        </select>
      </div>

      <div className={d.table} role="table" aria-label="Reading list">
        {items.length === 0 && <p className={d.emptyRow}>Nothing here.</p>}
        {items.map((r) => (
          <ReadingRow key={r.id} item={r} data={data} action={action} />
        ))}
      </div>
    </div>
  )
}

function ReadingRow({
  item: r,
  data,
  action
}: {
  item: ReadingItem
  data: DissertationOverview
  action: ReturnType<typeof useDissAction>
}) {
  const [adding, setAdding] = useState(false)
  const linked = data.sections.filter((s) => r.sectionIds.includes(s.id))
  const unlinked = data.sections.filter((s) => !r.sectionIds.includes(s.id))
  const setSections = (ids: string[]) =>
    void action.run(() => call('diss:updateReading', r.id, { sectionIds: ids }))
  return (
    <div className={d.readingRow} role="row" data-missing={r.missing || undefined}>
      <div className={d.readingMain}>
        <div className={d.readingTitle}>{r.title}</div>
        <div className={d.muted}>
          {r.creators}
          {r.year ? ` (${r.year})` : ''}
          {r.publication ? ` · ${r.publication}` : ''}
          {r.missing ? ' · no longer in the Zotero collection' : ''}
        </div>
        <div className={d.chips}>
          {linked.map((s) => (
            <span key={s.id} className={d.chip}>
              {s.title}
              <button
                aria-label={`Unlink ${s.title}`}
                onClick={() => setSections(r.sectionIds.filter((x) => x !== s.id))}
              >
                ×
              </button>
            </span>
          ))}
          {adding ? (
            <select
              className={d.chipSelect}
              autoFocus
              value=""
              aria-label="Link to a section"
              onBlur={() => setAdding(false)}
              onChange={(e) => {
                setAdding(false)
                if (e.target.value) setSections([...r.sectionIds, e.target.value])
              }}
            >
              <option value="">Link to section…</option>
              {unlinked.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          ) : (
            unlinked.length > 0 && (
              <button className={d.chipAdd} onClick={() => setAdding(true)}>
                + section
              </button>
            )
          )}
        </div>
      </div>
      <button
        className={d.pdfHandle}
        draggable
        title="Drag the PDF from Zotero into GoodNotes or Finder; click to open it"
        aria-label={`PDF of ${r.title}`}
        // Getting it ready on hover means the drag starts the moment it's picked up.
        onMouseEnter={() => void call('zotero:preparePdf', r.id).catch(() => undefined)}
        onDragStart={(e) => {
          e.preventDefault()
          call('zotero:startDrag', r.id).catch((err) => toast(errorMessage(err), { tone: 'error' }))
        }}
        onClick={() =>
          void call('zotero:openPdf', r.id).catch((err) =>
            toast(errorMessage(err), { tone: 'error' })
          )
        }
      >
        <FileText size={13} /> PDF
      </button>
      <select
        className={d.statusSelect}
        data-reading={r.status}
        value={r.status}
        aria-label={`Status of ${r.title}`}
        onChange={(e) =>
          void action.run(() =>
            call('diss:updateReading', r.id, { status: e.target.value as ReadingStatus })
          )
        }
      >
        {READING_STATUSES.map((st) => (
          <option key={st} value={st}>
            {READING_LABEL[st]}
          </option>
        ))}
      </select>
    </div>
  )
}
