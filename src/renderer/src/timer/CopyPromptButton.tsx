import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { call } from '../lib/api'
import d from '../shell/Dialog.module.css'

/** Copies a prompt for the Claude chat you're revising with; paste its reply back here. */
export function CopyPromptButton({
  prompt,
  label = 'Copy prompt for Claude',
  title = 'Copy a prompt that asks your revision chat for this debrief',
  className = `${d.secondary} ${d.withIcon}`
}: {
  prompt: string
  label?: string
  title?: string
  /** The button's look, to match the dialog it's in. */
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={() =>
        call('clipboard:write', prompt).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : label}
    </button>
  )
}
