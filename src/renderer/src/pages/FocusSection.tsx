import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX } from 'lucide-react'
import type { FocusSettings } from '@shared/types'
import { call } from '../lib/api'
import { errorMessage } from '../lib/queries'
import s from './Page.module.css'

/**
 * Focus while a timer runs. macOS only lets apps change Focus through Shortcuts, so the user
 * makes two shortcuts once and Engram runs them when a timer starts and stops.
 */
export function FocusSection() {
  const qc = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['focus'], queryFn: () => call('focus:get') })
  const [draft, setDraft] = useState<FocusSettings | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const value = draft ?? status
  if (!value || !status) return null

  const save = async (next: FocusSettings) => {
    setDraft(null)
    await call('focus:set', next)
    await qc.invalidateQueries({ queryKey: ['focus'] })
  }
  const test = async (which: 'on' | 'off') => {
    setMessage(null)
    try {
      await call('focus:test', which)
      setMessage(`Ran “${which === 'on' ? value.onShortcut : value.offShortcut}”.`)
    } catch (e) {
      setMessage(errorMessage(e))
    }
  }

  const Found = ({ ok }: { ok: boolean }) =>
    ok ? (
      <CircleCheck size={14} className={s.ok} aria-label="Found in Shortcuts" />
    ) : (
      <CircleX size={14} className={s.bad} aria-label="Not found in Shortcuts" />
    )

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>Focus and menu bar</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Menu-bar timer</div>
            <div className={s.muted}>
              The stopwatch in the menu bar shows the running block and can start, stop or extend
              it.
            </div>
          </div>
        </div>
        <div className={s.row}>
          <div className={s.grow}>
            <div>Turn on Focus while a timer runs</div>
            <div className={s.muted}>
              In the Shortcuts app, make two shortcuts with a “Set Focus” action: one turning your
              study Focus on, one turning it off. Engram runs them when a timer starts and stops.
            </div>
          </div>
          <label className={s.switch}>
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => void save({ ...value, enabled: e.target.checked })}
            />
            {value.enabled ? 'On' : 'Off'}
          </label>
        </div>
        {(['on', 'off'] as const).map((which) => {
          const key = which === 'on' ? 'onShortcut' : 'offShortcut'
          const saved = which === 'on' ? status.onShortcut : status.offShortcut
          return (
            <div key={which} className={s.row}>
              <div className={s.grow}>
                <div>Shortcut to turn Focus {which}</div>
              </div>
              <Found ok={status.found[which]} />
              <input
                className={s.input}
                value={value[key]}
                aria-label={`Shortcut to turn Focus ${which}`}
                onChange={(e) => setDraft({ ...value, [key]: e.target.value })}
                onBlur={() => value[key] !== saved && void save(value)}
              />
              <button className={s.button} onClick={() => void test(which)}>
                Test
              </button>
            </div>
          )
        })}
        {(message || status.lastError) && (
          <div className={s.row}>
            <div className={message?.startsWith('Ran') ? s.muted : s.errorText}>
              {message ?? status.lastError}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
