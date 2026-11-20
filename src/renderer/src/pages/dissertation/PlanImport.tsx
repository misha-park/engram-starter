import { useEffect, useState } from 'react'
import { FileUp, LoaderCircle, Trash2, X } from 'lucide-react'
import type { PlanDraft } from '@shared/types'
import { call } from '../../lib/api'
import { errorMessage, useAssistantStatus } from '../../lib/queries'
import { DateField } from '../../ui/DateField'
import { useFileDrop } from '../../lib/files'
import { useDissAction } from './useDissertation'
import dlg from '../../shell/Dialog.module.css'
import d from './Dissertation.module.css'

/**
 * Plan import: paste the project proposal (or choose a Word, PDF or text file); Claude
 * suggests sections and milestones, which you check and edit before anything is saved.
 */
export function PlanImport({ onClose }: { onClose: () => void }) {
  const { data: claude } = useAssistantStatus()
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = useDissAction()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !working && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, working])

  const fromDrop = useFileDrop((paths) => {
    if (working || draft) return
    void (async () => {
      setWorking(true)
      setError(null)
      try {
        const r = await call('plan:fromPath', paths[0])
        setDraft(r.draft)
        setSource(r.name)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setWorking(false)
      }
    })()
  })

  const ask = async (fromFile: boolean) => {
    setWorking(true)
    setError(null)
    try {
      if (fromFile) {
        const r = await call('plan:fromFile')
        if (r) {
          setDraft(r.draft)
          setSource(r.name)
        }
      } else {
        setDraft(await call('plan:fromText', text))
        setSource('the pasted proposal')
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }

  const patch = (p: Partial<PlanDraft>) => setDraft((x) => (x ? { ...x, ...p } : x))

  return (
    <div className={dlg.backdrop}>
      <div
        className={`${dlg.dialog} ${d.importDialog}`}
        role="dialog"
        aria-label="Import plan"
        data-over={fromDrop.over || undefined}
        {...fromDrop.props}
      >
        <header className={dlg.header}>
          <h2 className={dlg.title}>Import plan</h2>
          <button className={dlg.close} onClick={onClose} disabled={working} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <div className={`${dlg.body} ${d.importBody}`}>
          {!draft ? (
            <>
              <p className={dlg.lead}>
                Paste your project proposal, or drop or choose the file. Claude suggests sections
                and milestones from it; you check them before anything is saved. It never writes any
                of the dissertation.
              </p>
              {claude && !claude.hasToken && (
                <p className={dlg.error}>Add your Claude token in Settings first.</p>
              )}
              <textarea
                className={`${dlg.textarea} ${d.proposal}`}
                value={text}
                placeholder="Paste the proposal here"
                onChange={(e) => setText(e.target.value)}
                disabled={working}
              />
              {working && (
                <p className={d.muted}>
                  <LoaderCircle size={13} className={d.spin} /> Claude is reading the proposal…
                </p>
              )}
            </>
          ) : (
            <DraftEditor draft={draft} source={source} patch={patch} />
          )}
          {(error || save.error) && <p className={dlg.error}>{error ?? save.error}</p>}
        </div>
        <div className={dlg.actions}>
          {!draft ? (
            <>
              <button
                className={`${dlg.secondary} ${dlg.withIcon}`}
                disabled={working}
                onClick={() => void ask(true)}
              >
                <FileUp size={13} /> Choose a file…
              </button>
              <span className={dlg.spacer} />
              <button
                className={dlg.primary}
                disabled={working || text.trim().length < 40}
                onClick={() => void ask(false)}
              >
                Suggest a plan
              </button>
            </>
          ) : (
            <>
              <button className={dlg.secondary} onClick={() => setDraft(null)}>
                Start again
              </button>
              <span className={dlg.spacer} />
              <button
                className={dlg.primary}
                disabled={save.busy}
                onClick={() =>
                  void save.run(() => call('plan:apply', draft)).then((r) => r && onClose())
                }
              >
                Save plan
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DraftEditor({
  draft,
  source,
  patch
}: {
  draft: PlanDraft
  source: string | null
  patch: (p: Partial<PlanDraft>) => void
}) {
  return (
    <div className={d.draft}>
      <p className={d.muted}>
        From {source}. Edit anything that’s wrong; existing sections with the same title are kept as
        they are.
      </p>
      <label className={dlg.field}>
        Title
        <input
          className={d.input}
          value={draft.title ?? ''}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </label>
      <div className={d.formRow}>
        <label className={dlg.field}>
          Submission
          <DateField
            value={draft.submissionDue ?? ''}
            onChange={(v) => patch({ submissionDue: v })}
            ariaLabel="Submission date"
          />
        </label>
        <label className={dlg.field}>
          Word target
          <input
            className={`${d.input} ${d.short}`}
            value={draft.wordTarget ?? ''}
            inputMode="numeric"
            onChange={(e) =>
              patch({
                wordTarget: e.target.value ? Number(e.target.value.replace(/[^\d]/g, '')) : null
              })
            }
          />
        </label>
      </div>
      <div className={d.draftHeading}>Sections ({draft.sections.length})</div>
      {draft.sections.map((s, i) => (
        <div key={i} className={d.draftRow}>
          <input
            className={d.input}
            value={s.title}
            aria-label={`Section ${i + 1}`}
            onChange={(e) =>
              patch({
                sections: draft.sections.map((x, j) =>
                  j === i ? { ...x, title: e.target.value } : x
                )
              })
            }
          />
          <input
            className={`${d.input} ${d.short}`}
            value={s.wordTarget ?? ''}
            placeholder="words"
            aria-label={`Words for section ${i + 1}`}
            onChange={(e) =>
              patch({
                sections: draft.sections.map((x, j) =>
                  j === i
                    ? {
                        ...x,
                        wordTarget: e.target.value
                          ? Number(e.target.value.replace(/[^\d]/g, ''))
                          : null
                      }
                    : x
                )
              })
            }
          />
          <button
            className={d.iconButton}
            aria-label="Remove section"
            onClick={() => patch({ sections: draft.sections.filter((_, j) => j !== i) })}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className={d.draftHeading}>Milestones ({draft.milestones.length})</div>
      {draft.milestones.map((m, i) => (
        <div key={i} className={d.draftRow}>
          <input
            className={d.input}
            value={m.title}
            aria-label={`Milestone ${i + 1}`}
            onChange={(e) =>
              patch({
                milestones: draft.milestones.map((x, j) =>
                  j === i ? { ...x, title: e.target.value } : x
                )
              })
            }
          />
          <DateField
            value={m.due}
            ariaLabel={`Milestone ${i + 1} date`}
            onChange={(v) =>
              patch({
                milestones: draft.milestones.map((x, j) => (j === i ? { ...x, due: v } : x))
              })
            }
          />
          <button
            className={d.iconButton}
            aria-label="Remove milestone"
            onClick={() => patch({ milestones: draft.milestones.filter((_, j) => j !== i) })}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
