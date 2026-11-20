import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileUp, LoaderCircle, X } from 'lucide-react'
import type { Attachment, LectureListAnalysis, OrganiseStatus } from '@shared/types'
import { call } from '../../lib/api'
import { useFileDrop } from '../../lib/files'
import { errorMessage, useAssistantStatus } from '../../lib/queries'
import d from '../../shell/Dialog.module.css'
import l from './LectureList.module.css'

/**
 * A module's lecture list (booklet, timetable document or spreadsheet): Claude reads the
 * lectures and their times, Engram matches them against the timetable and suggests which
 * timetable events hold more than one lecture. Nothing changes until the user applies the
 * ticked ones. The file is kept with the module.
 */
export function LectureListDialog({
  moduleId,
  moduleLabel,
  attachmentId,
  suggested,
  onApplied,
  onClose
}: {
  moduleId: string
  moduleLabel: string
  /** Start by reading this file (e.g. the lecture list Engram found on Moodle). */
  attachmentId?: string
  /** Start from splits Claude already suggested (Organise lectures), with nothing to read. */
  suggested?: OrganiseStatus['splits']
  onApplied?: () => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data: claude } = useAssistantStatus()
  const [file, setFile] = useState<Pick<Attachment, 'name'> | null>(() =>
    suggested ? { name: 'Claude’s suggestions' } : null
  )
  const [analysis, setAnalysis] = useState<LectureListAnalysis | null>(() =>
    suggested
      ? {
          method: 'dates',
          proposals: suggested.map((x) => ({ ...x, confidence: 'sure' as const })),
          titled: [],
          unmatched: 0,
          listed: 0,
          timetabled: 0
        }
      : null
  )
  const [ticked, setTicked] = useState<Set<number>>(
    () => new Set(suggested ? suggested.map((_, i) => i) : [])
  )
  const [working, setWorking] = useState<'reading' | 'saving' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !working && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, working])

  const analyse = async (fn: () => Promise<Attachment[] | null>) => {
    setError(null)
    try {
      const added = (await fn())?.[0]
      if (!added) return
      setFile(added)
      setWorking('reading')
      const a = await call('lectureList:analyse', moduleId, added.id)
      setAnalysis(a)
      // Sure matches start ticked; ones to check start unticked.
      setTicked(new Set(a.proposals.flatMap((p, i) => (p.confidence === 'sure' ? [i] : []))))
      await qc.invalidateQueries({ queryKey: ['files'] })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWorking(null)
    }
  }
  // A file given up front (from Moodle) is read straight away.
  const [startWith] = useState(attachmentId)
  useEffect(() => {
    if (!startWith) return
    void Promise.resolve().then(() => analyse(() => call('files:get', [startWith])))
    // Runs once, for the file the dialog was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWith])

  const target = { type: 'module' as const, id: moduleId }
  const drop = useFileDrop(
    (paths) => void analyse(() => call('files:add', paths.slice(0, 1), target))
  )

  const apply = async () => {
    if (!analysis) return
    setWorking('saving')
    setError(null)
    try {
      await call(
        'lectureList:apply',
        analysis.proposals
          .filter((_, i) => ticked.has(i))
          .map(({ lectureId, cuts, parts }) => ({
            lectureId,
            cuts,
            titles: parts.map((p) => p.title)
          })),
        analysis.titled
      )
      onApplied?.()
      await qc.invalidateQueries()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setWorking(null)
    }
  }

  const toggle = (i: number) =>
    setTicked((t) => {
      const next = new Set(t)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className={d.backdrop}>
      <div className={`${d.dialog} ${l.dialog}`} role="dialog" aria-label="Lecture list">
        <header className={d.header}>
          <h2 className={d.title}>{moduleLabel} lecture list</h2>
          <button className={d.close} onClick={onClose} disabled={!!working} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <div className={`${d.body} ${l.body}`}>
          {!file ? (
            <>
              <p className={d.lead}>
                The timetable gives a 2-hour slot as one event, even when it holds two different
                lectures. Drop the module’s lecture list (booklet, timetable document or
                spreadsheet: Word, PDF or Excel) and Engram suggests which slots to split. A booklet
                from last year works too, as long as the lectures are in the same order.
              </p>
              {claude && !claude.hasToken && (
                <p className={d.error}>Add your Claude token in Settings first.</p>
              )}
              <div className={l.drop} data-over={drop.over || undefined} {...drop.props}>
                <FileUp size={20} />
                <span>Drop the lecture list here</span>
                <button
                  className={`${d.secondary} ${d.withIcon}`}
                  onClick={() => void analyse(() => call('files:choose', target))}
                >
                  Choose a file…
                </button>
              </div>
            </>
          ) : working === 'reading' ? (
            <p className={l.reading}>
              <LoaderCircle size={14} className={l.spin} /> Reading “{file.name}”…
            </p>
          ) : analysis ? (
            <>
              {suggested ? (
                <p className={d.muted}>
                  From the timetable, the lecture list and Moodle, Claude thinks these slots each
                  hold more than one lecture. Untick any that are wrong.
                </p>
              ) : (
                <p className={d.muted}>
                  {analysis.listed} lectures in “{file.name}”, {analysis.timetabled} in the
                  timetable.{' '}
                  {analysis.method === 'dates'
                    ? 'Matched by date and time.'
                    : 'The list’s dates aren’t this year’s, so they were matched in order.'}
                  {analysis.unmatched > 0 &&
                    ` ${analysis.unmatched} from the list didn’t match a timetabled lecture.`}
                  {analysis.titled.length > 0 &&
                    ` ${analysis.titled.length} lectures get their titles from the list.`}
                </p>
              )}
              {analysis.proposals.length === 0 ? (
                <p className={l.none}>
                  Nothing to split: every timetable slot holds one lecture of the list.
                </p>
              ) : (
                <ul className={l.list}>
                  {analysis.proposals.map((p, i) => (
                    <li key={p.lectureId} className={l.item}>
                      <label>
                        <input type="checkbox" checked={ticked.has(i)} onChange={() => toggle(i)} />
                        <span className={`${l.numbers} num`}>L{p.number}</span>
                        <span className={l.parts}>
                          {p.parts.map((x) => (
                            <span key={x.start} className={l.part}>
                              <span className={`${l.time} num`}>
                                {x.start}–{x.end}
                              </span>
                              {x.title}
                            </span>
                          ))}
                        </span>
                        {p.confidence === 'check' && (
                          <span
                            className={l.check}
                            title="The day or times in the list differ from the timetable"
                          >
                            Check
                          </span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className={d.muted}>
                Each part becomes its own lecture with its own write-up, and later lectures are
                renumbered. You can join them again on the module page.
              </p>
            </>
          ) : null}
          {error && <p className={d.error}>{error}</p>}
        </div>
        <div className={d.actions}>
          {file && !working && !suggested && (
            <button
              className={d.secondary}
              onClick={() => {
                setFile(null)
                setAnalysis(null)
              }}
            >
              Use another file
            </button>
          )}
          <span className={d.spacer} />
          <button className={d.secondary} onClick={onClose} disabled={!!working}>
            Cancel
          </button>
          {analysis && (analysis.proposals.length > 0 || analysis.titled.length > 0) && (
            <button
              className={d.primary}
              disabled={!!working || (!ticked.size && !analysis.titled.length)}
              onClick={() => void apply()}
            >
              {ticked.size
                ? `Split ${ticked.size} and name lectures`
                : `Name ${analysis.titled.length} lectures`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
