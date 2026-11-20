import { useState } from 'react'
import { FileUp } from 'lucide-react'
import { useFileDrop } from '../lib/files'
import d from '../shell/Dialog.module.css'
import s from './BriefInput.module.css'

/**
 * Where a brief goes in: drop a file, choose one, or type or paste the text (from Moodle, an
 * email…). Typed text is kept as a `.txt` file by the caller (`files:addText`).
 */
export function BriefInput({
  onPaths,
  onChoose,
  onText,
  busy = false,
  compact = false,
  label = 'Drop the brief here'
}: {
  onPaths: (paths: string[]) => void
  onChoose: () => void
  onText: (text: string) => void | Promise<void>
  busy?: boolean
  /** A smaller version for a page's side column. */
  compact?: boolean
  label?: string
}) {
  const drop = useFileDrop(onPaths)
  const [text, setText] = useState('')
  return (
    <div className={s.wrap} data-compact={compact || undefined}>
      <div className={s.drop} data-over={drop.over || undefined} {...drop.props}>
        <FileUp size={compact ? 16 : 20} />
        <span>{label}</span>
        <button
          className={`${d.secondary} ${d.withIcon}`}
          disabled={busy}
          onClick={() => onChoose()}
        >
          Choose a file…
        </button>
      </div>
      <textarea
        className={s.text}
        value={text}
        rows={text ? 8 : 2}
        placeholder="…or type or paste the brief here"
        aria-label="Brief text"
        onChange={(e) => setText(e.target.value)}
      />
      {text.trim() && (
        <div className={s.actions}>
          <span className={s.count}>{text.trim().split(/\s+/).length} words</span>
          <button className={d.secondary} disabled={busy} onClick={() => setText('')}>
            Clear
          </button>
          <button
            className={d.primary}
            disabled={busy}
            onClick={async () => {
              await onText(text)
              setText('')
            }}
          >
            Use this text
          </button>
        </div>
      )}
    </div>
  )
}
