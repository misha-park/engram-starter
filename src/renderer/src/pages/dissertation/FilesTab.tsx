import type { DissertationOverview } from '@shared/types'
import { formatClock, zoned } from '@core/time'
import { call } from '../../lib/api'
import { Attachments } from '../../ui/Attachments'
import d from './Dissertation.module.css'

/** The dissertation's files: its own, its sections' and its meetings'. Each can be moved. */
export function FilesTab({ data }: { data: DissertationOverview }) {
  const places = [
    { ref: { type: 'dissertation' as const, id: 'main' }, label: 'Dissertation' },
    ...data.sections.map((s) => ({
      ref: { type: 'dissertation-section' as const, id: s.id },
      label: `Section: ${s.title}`
    })),
    ...data.meetings.map((m) => ({
      ref: { type: 'meeting' as const, id: m.id },
      label: `Meeting ${zoned(m.at)
        .toPlainDate()
        .toLocaleString('en-GB', { day: 'numeric', month: 'short' })}, ${formatClock(m.at)}`
    }))
  ]
  return (
    <div className={d.stack}>
      <p className={d.muted}>
        Engram keeps a copy of each file; the original stays where it was. Drop files in the
        dissertation assistant and Claude files them in the right place.
      </p>
      <Attachments
        target={{ type: 'dissertation', id: 'main' }}
        list={{ key: ['files', 'dissertation-all'], fetch: () => call('files:listDissertation') }}
        places={places}
        hint="Drop the proposal, ethics forms, supervisor feedback, figures…"
      />
    </div>
  )
}
