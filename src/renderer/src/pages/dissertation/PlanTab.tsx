import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowDown, ArrowUp, CalendarDays, CalendarPlus, FileUp, Trash2 } from 'lucide-react'
import {
  SECTION_STATUSES,
  type DissertationOverview,
  type DissertationSection,
  type SectionStatus
} from '@shared/types'
import { formatClock, formatMinutes, zoned } from '@core/time'
import { call } from '../../lib/api'
import { SESSION_LENGTHS, STATUS_LABEL } from './labels'
import { useDissAction } from './useDissertation'
import { openContextMenu } from '../../ui/menuStore'
import d from './Dissertation.module.css'

/** Sections in order: status, words (entered by hand), reading, logged time and sessions. */
export function PlanTab({ data, onImport }: { data: DissertationOverview; onImport: () => void }) {
  const action = useDissAction()
  const [newTitle, setNewTitle] = useState('')

  if (data.sections.length === 0) {
    return (
      <div className={d.emptyState}>
        <p>No sections yet.</p>
        <p className={d.muted}>
          Import your project proposal and Claude will suggest sections and milestones for you to
          check, or add sections by hand below.
        </p>
        <button className={d.primary} onClick={onImport}>
          <FileUp size={14} /> Import plan
        </button>
        <AddSection
          value={newTitle}
          onChange={setNewTitle}
          onAdd={() =>
            action.run(() => call('diss:addSection', newTitle)).then(() => setNewTitle(''))
          }
        />
      </div>
    )
  }

  return (
    <div className={d.stack}>
      <div className={`${d.table} ${d.sectionTable}`} role="table" aria-label="Sections">
        <div className={d.sectionHead} role="row">
          <span role="columnheader">Section</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Words</span>
          <span role="columnheader">Reading</span>
          <span role="columnheader">Sessions</span>
          <span />
        </div>
        {data.sections.map((s, i) => (
          <SectionRow
            key={s.id}
            section={s}
            first={i === 0}
            last={i === data.sections.length - 1}
            action={action}
          />
        ))}
      </div>
      <AddSection
        value={newTitle}
        onChange={setNewTitle}
        onAdd={() =>
          action.run(() => call('diss:addSection', newTitle)).then(() => setNewTitle(''))
        }
      />
      {action.error && <p className={d.error}>{action.error}</p>}
    </div>
  )
}

function AddSection({
  value,
  onChange,
  onAdd
}: {
  value: string
  onChange: (v: string) => void
  onAdd: () => void
}) {
  return (
    <div className={d.addRow}>
      <input
        className={d.input}
        value={value}
        placeholder="New section"
        aria-label="New section title"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && onAdd()}
      />
      <button className={d.button} disabled={!value.trim()} onClick={onAdd}>
        Add section
      </button>
    </div>
  )
}

function SectionRow({
  section: s,
  first,
  last,
  action
}: {
  section: DissertationSection
  first: boolean
  last: boolean
  action: ReturnType<typeof useDissAction>
}) {
  const [words, setWords] = useState(s.wordCount === null ? '' : String(s.wordCount))
  const [minutes, setMinutes] = useState(90)
  const saveWords = () => {
    const n = words.trim() === '' ? null : Number(words)
    if (n === s.wordCount) return
    if (n !== null && (!Number.isInteger(n) || n < 0)) {
      setWords(s.wordCount === null ? '' : String(s.wordCount))
      return
    }
    void action.run(() => call('diss:updateSection', s.id, { wordCount: n }))
  }
  const next = s.upcoming[0]
  const navigate = useNavigate()
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { heading: s.title },
      ...SECTION_STATUSES.filter((st) => st !== s.status).map((st) => ({
        label: `Mark ${STATUS_LABEL[st].toLowerCase()}`,
        onSelect: () => action.run(() => call('diss:updateSection', s.id, { status: st }))
      })),
      'separator',
      {
        label: `Plan a ${SESSION_LENGTHS.find(([m]) => m === minutes)?.[1] ?? ''} session`,
        icon: CalendarPlus,
        hint: 'next free slot',
        onSelect: () => action.run(() => call('diss:scheduleSession', s.id, minutes))
      },
      next && {
        label: 'Show the next session',
        icon: CalendarDays,
        onSelect: () => navigate(`/?block=${next.id}`)
      },
      'separator',
      !first && {
        label: 'Move up',
        icon: ArrowUp,
        onSelect: () => action.run(() => call('diss:moveSection', s.id, -1))
      },
      !last && {
        label: 'Move down',
        icon: ArrowDown,
        onSelect: () => action.run(() => call('diss:moveSection', s.id, 1))
      },
      'separator',
      {
        label: 'Remove section…',
        icon: Trash2,
        danger: true,
        confirm: `Remove “${s.title}”? Its past sessions stay on the calendar.`,
        onSelect: () => action.run(() => call('diss:removeSection', s.id))
      }
    ])

  return (
    <div className={d.sectionRow} role="row" data-status={s.status} onContextMenu={menu}>
      <span className={d.sectionTitle}>{s.title}</span>
      <span>
        <select
          className={d.statusSelect}
          data-status={s.status}
          value={s.status}
          aria-label={`Status of ${s.title}`}
          onChange={(e) =>
            void action.run(() =>
              call('diss:updateSection', s.id, { status: e.target.value as SectionStatus })
            )
          }
        >
          {SECTION_STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </select>
      </span>
      <span className={d.words}>
        <input
          className={`${d.wordsInput} num`}
          value={words}
          inputMode="numeric"
          placeholder="0"
          aria-label={`Words in ${s.title}`}
          onChange={(e) => setWords(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={saveWords}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {s.wordTarget && <span className={d.muted}>/ {s.wordTarget.toLocaleString('en-GB')}</span>}
      </span>
      <span className={`${d.muted} num`}>{s.readingCount || '–'}</span>
      <span className={d.sessions}>
        {(s.loggedMinutes > 0 || !next) && (
          <span className="num">{s.loggedMinutes ? formatMinutes(s.loggedMinutes) : '–'}</span>
        )}
        {next && (
          <span className={d.muted} title="Next planned session">
            {s.loggedMinutes > 0 ? ' · next ' : 'next '}
            {zoned(next.start)
              .toPlainDate()
              .toLocaleString('en-GB', { weekday: 'short', day: 'numeric' })}{' '}
            {formatClock(next.start)}
          </span>
        )}
      </span>
      <span className={d.rowActions}>
        <select
          className={d.minutesSelect}
          value={minutes}
          aria-label="Session length"
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          {SESSION_LENGTHS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
        <button
          className={d.iconButton}
          title="Plan a session in the next free slot"
          aria-label={`Plan a session on ${s.title}`}
          disabled={action.busy}
          onClick={() => void action.run(() => call('diss:scheduleSession', s.id, minutes))}
        >
          <CalendarPlus size={14} />
        </button>
        <button
          className={d.iconButton}
          disabled={first}
          aria-label="Move up"
          onClick={() => void action.run(() => call('diss:moveSection', s.id, -1))}
        >
          <ArrowUp size={13} />
        </button>
        <button
          className={d.iconButton}
          disabled={last}
          aria-label="Move down"
          onClick={() => void action.run(() => call('diss:moveSection', s.id, 1))}
        >
          <ArrowDown size={13} />
        </button>
        <button
          className={d.iconButton}
          aria-label={`Remove ${s.title}`}
          onClick={() =>
            window.confirm(`Remove “${s.title}”? Its past sessions stay on the calendar.`) &&
            void action.run(() => call('diss:removeSection', s.id))
          }
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )
}
