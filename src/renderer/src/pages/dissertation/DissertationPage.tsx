import { useEffect, useState, type CSSProperties } from 'react'
import { FileUp, MessageSquareText, Settings2 } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import { TZ, zoned } from '@core/time'
import { useAssistant, useAssistantScreen } from '../../assistant/store'
import { useAssistantStatus } from '../../lib/queries'
import { ConversationView } from '../../shell/ClaudePanel'
import { FilesTab } from './FilesTab'
import { MeetingsTab } from './MeetingsTab'
import { PlanImport } from './PlanImport'
import { PlanTab } from './PlanTab'
import { ReadingTab } from './ReadingTab'
import { SettingsPanel } from './SettingsPanel'
import { TimelineStrip, TimelineTab } from './TimelineTab'
import { useDissertation } from './useDissertation'
import d from './Dissertation.module.css'

const TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'reading', label: 'Reading' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'files', label: 'Files' }
] as const
type Tab = (typeof TABS)[number]['id']
const TAB_KEY = 'dissertation.tab'
const CHAT_KEY = 'dissertation.chat'

const stored = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not essential.
  }
}

/**
 * The dissertation: plan (sections), timeline (milestones to submission and the viva),
 * reading list (from Zotero) and supervisor meetings, with its own Claude assistant beside it.
 */
export function DissertationPage() {
  const { data } = useDissertation()
  const assistant = useAssistant()
  const { data: claude } = useAssistantStatus()
  const [tab, setTab] = useState<Tab>(() => stored<Tab>(TAB_KEY, 'plan'))
  const [chatOpen, setChatOpen] = useState(() => stored(CHAT_KEY, true))
  const [panel, setPanel] = useState<'settings' | 'import' | null>(null)
  useAssistantScreen({})

  // The dissertation conversation has a fixed id, so it outlives visits to this page.
  const { ensureConversation } = assistant
  useEffect(() => {
    ensureConversation({ kind: 'dissertation' }, 'Dissertation')
  }, [ensureConversation])

  if (!data) return null
  const s = data.settings
  const today = Temporal.Now.plainDateISO(TZ)
  const daysTo = (iso: string | null) => (iso ? today.until(zoned(iso).toPlainDate()).days : null)
  const submissionIn = daysTo(s.submissionDue)
  const wordPct = s.wordTarget ? Math.min(100, (data.wordCount / s.wordTarget) * 100) : 0

  const choose = (t: Tab) => {
    setTab(t)
    store(TAB_KEY, t)
  }
  const toggleChat = () => {
    setChatOpen(!chatOpen)
    store(CHAT_KEY, !chatOpen)
  }

  return (
    <div className={`cat ${d.page}`} style={{ '--cat': data.colour ?? undefined } as CSSProperties}>
      <div className={d.main}>
        <header className={d.header}>
          <div className={d.titleRow}>
            <h1 className={d.title}>{s.title}</h1>
            <span className={d.spacer} />
            <button
              className={d.button}
              onClick={() => setPanel('import')}
              title="Turn a proposal into sections and milestones"
            >
              <FileUp size={14} /> Import plan
            </button>
            <button
              className={d.iconButton}
              onClick={() => setPanel('settings')}
              title="Dissertation settings"
              aria-label="Dissertation settings"
            >
              <Settings2 size={16} />
            </button>
            <button
              className={d.iconButton}
              onClick={toggleChat}
              aria-pressed={chatOpen}
              title={
                chatOpen ? 'Hide the dissertation assistant' : 'Show the dissertation assistant'
              }
              aria-label="Dissertation assistant"
            >
              <MessageSquareText size={16} />
            </button>
          </div>
          <div className={d.stats}>
            <span>
              <strong className="num">{data.wordCount.toLocaleString('en-GB')}</strong>
              {s.wordTarget ? ` / ${s.wordTarget.toLocaleString('en-GB')}` : ''} words
            </span>
            {submissionIn !== null && (
              <span>
                Due{' '}
                <strong className="num">
                  {zoned(s.submissionDue!)
                    .toPlainDate()
                    .toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </strong>{' '}
                <span className={d.muted}>
                  ({submissionIn >= 0 ? `in ${submissionIn} days` : `${-submissionIn} days ago`})
                </span>
              </span>
            )}
            {s.vivaDate && (
              <span>
                Viva{' '}
                <strong className="num">
                  {Temporal.PlainDate.from(s.vivaDate).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short'
                  })}
                  {s.vivaTime ? `, ${s.vivaTime}` : ''}
                </strong>
              </span>
            )}
          </div>
          {s.wordTarget && (
            <div className={d.bar} title="Words written (as you've entered them)">
              <div className={d.fill} style={{ width: `${wordPct}%` }} />
            </div>
          )}
          <nav className={d.tabs} role="tablist" aria-label="Dissertation">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={d.tab}
                onClick={() => choose(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        <div className={d.content}>
          {tab !== 'timeline' && (
            <div className={d.stack} style={{ marginBottom: 'var(--space-4)' }}>
              <TimelineStrip data={data} />
            </div>
          )}
          {tab === 'plan' && <PlanTab data={data} onImport={() => setPanel('import')} />}
          {tab === 'timeline' && <TimelineTab data={data} />}
          {tab === 'reading' && <ReadingTab data={data} onSettings={() => setPanel('settings')} />}
          {tab === 'meetings' && <MeetingsTab data={data} />}
          {tab === 'files' && <FilesTab data={data} />}
        </div>
      </div>

      {chatOpen && (
        <aside className={d.chat} aria-label="Dissertation assistant">
          <div className={d.chatHeader}>Dissertation assistant</div>
          {claude && !claude.hasToken ? (
            <p className={d.chatEmpty}>Add your Claude token in Settings to use the assistant.</p>
          ) : (
            <ConversationView
              conversationId="dissertation"
              focusKey={false}
              placeholder="Ask about sections, reading or sessions…"
              empty={
                <div className={d.chatEmpty}>
                  <p>I help organise the dissertation, never write it. For example:</p>
                  <ul>
                    <li>“Plan two sessions on the methods this week”</li>
                    <li>“I’ve drafted 900 words of the introduction”</li>
                    <li>“Which papers haven’t I read for the discussion?”</li>
                  </ul>
                </div>
              }
            />
          )}
        </aside>
      )}

      {panel === 'settings' && <SettingsPanel data={data} onClose={() => setPanel(null)} />}
      {panel === 'import' && <PlanImport onClose={() => setPanel(null)} />}
    </div>
  )
}
