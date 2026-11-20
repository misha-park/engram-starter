import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { call } from '../lib/api'
import { useAssistantStatus, errorMessage } from '../lib/queries'
import { TokenSetup } from '../shell/ClaudePanel'
import s from './Page.module.css'
import m from './ClaudeSection.module.css'

/** The assistant: its token (in the Keychain), the model, and the Sunday weekly review. */
export function ClaudeSection() {
  const qc = useQueryClient()
  const { data: status } = useAssistantStatus()
  const { data: review } = useQuery({
    queryKey: ['weeklyReview'],
    queryFn: () => call('assistant:review')
  })
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  const removeToken = async () => {
    if (!window.confirm('Remove the Claude token? The assistant stops working until you add one.'))
      return
    await call('assistant:clearToken')
    await qc.invalidateQueries({ queryKey: ['assistantStatus'] })
  }
  const writeReview = async () => {
    setWriting(true)
    setError(null)
    try {
      await call('assistant:runReview')
      await qc.invalidateQueries({ queryKey: ['weeklyReview'] })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWriting(false)
    }
  }

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Claude</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Account</div>
            <div className={s.muted}>
              {status?.hasToken
                ? 'Connected with your token from claude setup-token (kept in the macOS Keychain). It uses your own Claude plan.'
                : 'Not connected.'}
            </div>
          </div>
          {status?.hasToken && (
            <button className={s.button} onClick={() => void removeToken()}>
              Remove token
            </button>
          )}
        </div>
        {status && !status.hasToken && (
          <div className={s.row}>
            <div className={s.grow}>
              <TokenSetup compact />
            </div>
          </div>
        )}
        <div className={s.row}>
          <div className={s.grow}>
            <div>Model</div>
            <div className={s.muted}>
              {status?.model}. Organisation only: it plans and moves work, and never writes
              coursework.
            </div>
          </div>
        </div>
        <Memories />
        <div className={s.row}>
          <div className={s.grow}>
            <div>Weekly review</div>
            <div className={s.muted}>
              Written on Sunday evenings (from 18:00, if Engram is open) and sent as a notification.
            </div>
            {review && (
              <p className={s.reviewText}>
                <span className={s.muted}>
                  Week of{' '}
                  {new Date(review.weekStart).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short'
                  })}
                  :{' '}
                </span>
                {review.text}
              </p>
            )}
            {error && <div className={s.errorText}>{error}</div>}
          </div>
          <button
            className={s.button}
            disabled={!status?.hasToken || writing}
            onClick={() => void writeReview()}
          >
            {writing ? 'Writing…' : 'Write it now'}
          </button>
        </div>
      </div>
    </section>
  )
}

/** What Claude was asked to remember: shown in every conversation, removable here. */
function Memories() {
  const qc = useQueryClient()
  const { data: memories = [] } = useQuery({
    queryKey: ['assistantMemories'],
    queryFn: () => call('assistant:memories')
  })
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['assistantMemories'] })

  const add = async () => {
    if (!draft.trim()) return
    setError(null)
    try {
      await call('assistant:remember', draft)
      setDraft('')
      await refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const remove = async (id: string) => {
    await call('assistant:forgetMemory', id)
    await refresh()
  }

  return (
    <div className={s.row}>
      <div className={s.grow}>
        <div>Remembered</div>
        <div className={s.muted}>
          Your preferences for planning, which Claude follows in every chat. Tell Claude in a chat
          (“remember I don’t do write-ups after 21:00”) or add one here.
        </div>
        {memories.length > 0 && (
          <ul className={m.list}>
            {memories.map((x) => (
              <li key={x.id} className={m.item}>
                <span className={m.text}>{x.text}</span>
                <button
                  className={m.remove}
                  onClick={() => void remove(x.id)}
                  title="Forget this"
                  aria-label={`Forget “${x.text}”`}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={m.add}>
          <input
            className={s.input}
            value={draft}
            maxLength={200}
            placeholder="e.g. Keep Fridays light"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <button className={s.button} disabled={!draft.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
        {error && <div className={s.errorText}>{error}</div>}
      </div>
    </div>
  )
}
