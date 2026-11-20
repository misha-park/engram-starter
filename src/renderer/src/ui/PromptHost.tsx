import { useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { answerPrompt, currentPrompt, subscribePrompt, type PromptRequest } from './promptStore'
import d from '../shell/Dialog.module.css'

/** Draws the dialog for `askText` (one at a time). */
export function PromptHost() {
  const req = useSyncExternalStore(subscribePrompt, currentPrompt)
  if (!req) return null
  return createPortal(<Prompt key={req.title + (req.initial ?? '')} req={req} />, document.body)
}

function Prompt({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.initial ?? '')
  const ok = req.allowEmpty || value.trim().length > 0
  return (
    <div className={d.backdrop} onMouseDown={() => answerPrompt(null)}>
      <form
        className={d.dialog}
        role="dialog"
        aria-label={req.title}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) answerPrompt(value.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            answerPrompt(null)
          }
        }}
      >
        <header className={d.header}>
          <h2 className={d.title}>{req.title}</h2>
        </header>
        <div className={d.body}>
          <input
            className={d.input}
            autoFocus
            value={value}
            placeholder={req.placeholder}
            aria-label={req.title}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setValue(e.target.value)}
          />
          {req.note && <span className={d.muted}>{req.note}</span>}
        </div>
        <div className={d.actions}>
          <span className={d.spacer} />
          <button type="button" className={d.secondary} onClick={() => answerPrompt(null)}>
            Cancel
          </button>
          <button type="submit" className={d.primary} disabled={!ok}>
            {req.okLabel ?? 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
