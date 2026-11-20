import { useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import type { LinkedCalendar } from '@shared/types'
import { formatClock, zoned } from '@core/time'
import { call } from '../lib/api'
import { errorMessage, useProfile } from '../lib/queries'
import { useSynced } from '../lib/useSynced'
import { toast } from '../ui/toastStore'
import { ColourPicker } from './modules/ColourPicker'
import s from './Page.module.css'

/**
 * iCloud (or any public iCal) calendars, shown on Engram's calendar for reference. Nothing is
 * planned around their events and nothing is written back; the link is kept in the Keychain.
 */
export function LinkedCalendarsSection() {
  const qc = useQueryClient()
  const { data: profile } = useProfile()
  const isDemo = profile?.active === 'demo'
  const { data: calendars = [] } = useQuery({
    queryKey: ['linkedCalendars'],
    queryFn: () => call('calendars:list')
  })
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await qc.invalidateQueries()
      if (done) toast(done)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    run(async () => {
      const added = await call('calendars:add', link)
      setLink('')
      toast(`Linked “${added.name}”: ${added.events} events. Its toggle is in the Calendars list.`)
    })

  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>iCloud calendar</h2>
      <div className={s.card}>
        <div className={s.row}>
          <div className={s.grow}>
            <div>See your iCloud events without opening the Calendar app</div>
            <div className={s.muted}>
              They show on Engram’s calendar as outlined, read-only events. Engram doesn’t plan
              around them and never changes your iCloud calendar: double-click one to add it to
              Engram by hand, and it drops off once you have (a block with the same name at that
              time). Right-click one to delete it from here (your iCloud calendar isn’t touched).
              Each calendar has a toggle in the Calendars list.
            </div>
          </div>
        </div>
        {calendars.map((c) => (
          <CalendarRow
            key={c.id}
            calendar={c}
            busy={busy}
            onRename={(name) => run(() => call('calendars:update', c.id, { name }))}
            onColour={(colour) => run(() => call('calendars:update', c.id, { colour }))}
            onRemove={() => {
              if (
                window.confirm(
                  `Unlink “${c.name}”? Its events leave Engram’s calendar. Your iCloud calendar isn’t touched.`
                )
              )
                void run(() => call('calendars:remove', c.id))
            }}
          />
        ))}
        {calendars.length > 0 && (
          <div className={s.row}>
            <div className={`${s.grow} ${s.muted}`}>Checked every 30 minutes.</div>
            <button
              className={s.button}
              disabled={busy}
              onClick={() => void run(() => call('calendars:sync'), 'Checked.')}
            >
              Check now
            </button>
          </div>
        )}
        <div className={s.row}>
          <div className={s.grow}>
            <input
              className={`${s.input} ${s.grow}`}
              style={{ width: '100%' }}
              placeholder={
                isDemo
                  ? 'Only used with real data'
                  : 'Paste a public calendar link (webcal:// or https://)'
              }
              value={link}
              disabled={isDemo || busy}
              aria-label="Public calendar link"
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && link.trim() && void add()}
            />
            <div className={s.muted}>
              In the Calendar app on your Mac: right-click the calendar, choose Share Calendar…,
              tick Public Calendar, then Copy Link. Anyone with that link can see the calendar, so
              keep it private: Engram keeps it in the Keychain, never in files. One link per
              calendar; add as many as you like.
            </div>
          </div>
          <button
            className={s.button}
            disabled={isDemo || busy || !link.trim()}
            onClick={() => void add()}
          >
            {busy ? 'Reading…' : 'Link'}
          </button>
        </div>
      </div>
      {error && <p className={s.errorText}>{error}</p>}
    </section>
  )
}

function CalendarRow({
  calendar: c,
  busy,
  onRename,
  onColour,
  onRemove
}: {
  calendar: LinkedCalendar
  busy: boolean
  onRename: (name: string) => void
  onColour: (colour: string) => void
  onRemove: () => void
}) {
  const [name, setName] = useSynced(c.name)
  const [picking, setPicking] = useState(false)
  const checked = c.lastCheckedAt
    ? `${zoned(c.lastCheckedAt).toPlainDate().toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short'
      })}, ${formatClock(c.lastCheckedAt)}`
    : 'not yet'
  return (
    <div className={s.row}>
      <button
        className={s.button}
        style={{ '--cat': c.colour, width: 28, padding: 0 } as CSSProperties}
        title="Colour"
        aria-label={`Colour of ${c.name}`}
        onClick={() => setPicking(!picking)}
      >
        <span
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: c.colour
          }}
        />
      </button>
      <div className={s.grow}>
        <input
          className={s.input}
          value={name}
          aria-label="Calendar name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== c.name && onRename(name)}
        />
        <div className={`${s.muted} num`}>
          {c.events} events · checked {checked}
        </div>
        {c.lastError && <div className={s.errorText}>Last check failed: {c.lastError}</div>}
        {picking && (
          <ColourPicker
            value={c.colour}
            onChange={(colour) => {
              setPicking(false)
              onColour(colour)
            }}
          />
        )}
      </div>
      <button
        className={s.button}
        disabled={busy}
        title="Unlink this calendar"
        aria-label={`Unlink ${c.name}`}
        onClick={onRemove}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
