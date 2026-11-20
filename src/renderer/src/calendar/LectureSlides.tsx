import { useQuery } from '@tanstack/react-query'
import { Copy, Download, Presentation } from 'lucide-react'
import type { Block } from '@shared/types'
import { call } from '../lib/api'
import { copyFile, dragFile, saveToDownloads } from '../lib/download'
import { useModule } from '../lib/queries'
import s from './BlockDialog.module.css'

/** The lecture's slides from Moodle (a lecture's block or its write-up), as a dialog field. */
export function LectureSlides({ lecture }: { lecture: NonNullable<Block['lecture']> }) {
  const { data: mod } = useModule(lecture.moduleId)
  const { data: groups = [] } = useQuery({
    queryKey: ['files', 'moodle', lecture.moduleId],
    queryFn: () => call('moodle:moduleFiles', lecture.moduleId)
  })
  // A later session of a merged lecture shares the first session's slides.
  const id = mod?.lectures.find((l) => l.id === lecture.id)?.part?.firstId ?? lecture.id
  const slides = groups.flatMap((g) => g.files.filter((f) => f.lectureId === id))
  if (slides.length === 0) return null
  return (
    <>
      <dt>Slides</dt>
      <dd className={s.slides}>
        {slides.map((f) => (
          <span key={f.id} className={s.slide}>
            <button
              className={s.slideOpen}
              title={`Open ${f.name} (or drag it out)`}
              draggable
              onDragStart={(e) => dragFile(e, f.id)}
              onClick={() => void call('files:open', f.id)}
            >
              <Presentation size={13} /> <span className={s.slideName}>{f.name}</span>
            </button>
            <button
              className={s.slideSave}
              title="Save to Downloads"
              aria-label={`Save ${f.name} to Downloads`}
              onClick={() => void saveToDownloads(f.id)}
            >
              <Download size={13} />
            </button>
            <button
              className={s.slideSave}
              title="Copy"
              aria-label={`Copy ${f.name}`}
              onClick={() => void copyFile(f.id, f.name)}
            >
              <Copy size={13} />
            </button>
          </span>
        ))}
      </dd>
    </>
  )
}
