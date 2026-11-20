import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router'
import {
  Check,
  History,
  LoaderCircle,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { Attachment, BatchSummary } from '@shared/types'
import { useAssistant, type ChatMessage, type Conversation } from '../assistant/store'
import { call } from '../lib/api'
import { remember, remembered } from '../lib/remember'
import { useFileDrop } from '../lib/files'
import { FileIcon } from '../ui/Attachments'
import { errorMessage, useAssistantStatus } from '../lib/queries'
import s from './ClaudePanel.module.css'

/** The panel's usual width (the `--claude-w` token); dragged within this much of it, it snaps back. */
const DEFAULT_W = 380
const MIN_W = 300
const SNAP_PX = 24

// Right-hand assistant panel. It pushes the content narrower (no overlay).
// Organisation only: planning, rescheduling, debriefs and check-ins.

export function ClaudePanel() {
  const a = useAssistant()
  const { open } = a.state
  const { data: status } = useAssistantStatus()
  const [history, setHistory] = useState(false)
  // Drag the left edge to resize; it snaps back to the usual width when close to it.
  const [width, setWidth] = useState(() => remembered<number>('claudeWidth', DEFAULT_W))
  const [dragging, setDragging] = useState(false)
  const maxWidth = () => Math.max(MIN_W, Math.min(900, window.innerWidth * 0.6))
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = width
    let latest = width
    setDragging(true)
    const move = (ev: PointerEvent) => {
      let w = Math.max(MIN_W, Math.min(maxWidth(), startW + (startX - ev.clientX)))
      if (Math.abs(w - DEFAULT_W) <= SNAP_PX) w = DEFAULT_W
      latest = w
      setWidth(w)
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      setDragging(false)
      remember('claudeWidth', latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  // The dissertation assistant lives on its own page, not in the panel's tabs.
  const conversations = Object.values(a.state.conversations).filter(
    (c) => c.mode.kind !== 'dissertation'
  )

  return (
    <aside
      className={s.panel}
      data-open={open || undefined}
      data-dragging={dragging || undefined}
      aria-hidden={!open}
      aria-label="Claude"
      style={{ '--claude-w': `${width}px` } as CSSProperties}
    >
      {open && (
        <div
          className={s.resize}
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setWidth(DEFAULT_W)
            remember('claudeWidth', DEFAULT_W)
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Claude (double-click to reset)"
          title="Drag to resize, double-click to reset"
        />
      )}
      <div className={s.inner}>
        <header className={s.header}>
          <Sparkles size={14} strokeWidth={1.75} />
          <span className={s.title}>Claude</span>
          <span className={s.shortcut}>⌘J</span>
          <button
            className={s.iconButton}
            onClick={() => setHistory((h) => !h)}
            title="History"
            aria-label="History"
            aria-pressed={history}
            data-on={history || undefined}
            tabIndex={open ? 0 : -1}
          >
            <History size={14} />
          </button>
          <button
            className={s.iconButton}
            onClick={() => {
              setHistory(false)
              a.newChat()
            }}
            title="New chat (in a new tab)"
            aria-label="New chat"
            tabIndex={open ? 0 : -1}
          >
            <Plus size={14} />
          </button>
          <button
            className={s.iconButton}
            onClick={() => a.setOpen(false)}
            title="Close"
            aria-label="Close Claude"
            tabIndex={open ? 0 : -1}
          >
            <X size={14} />
          </button>
        </header>

        <nav className={s.tabs} role="tablist" aria-label="Conversations">
          {conversations.map((c) => (
            <span
              key={c.id}
              className={s.tab}
              aria-selected={!history && c.id === a.active.id}
              role="tab"
              title={c.title}
            >
              <button
                className={s.tabButton}
                onClick={() => {
                  setHistory(false)
                  a.activate(c.id)
                }}
              >
                {a.state.busyId === c.id && <LoaderCircle size={10} className={s.spin} />}
                {c.title}
              </button>
              {!(conversations.length === 1 && c.messages.length === 0) &&
                a.state.busyId !== c.id && (
                  <button
                    className={s.tabClose}
                    onClick={() => a.closeConversation(c.id)}
                    aria-label={`Close ${c.title}`}
                    title="Close (it stays in History)"
                  >
                    <X size={11} />
                  </button>
                )}
            </span>
          ))}
        </nav>

        {status && !status.hasToken ? (
          <TokenSetup />
        ) : history ? (
          <HistoryView onOpen={() => setHistory(false)} />
        ) : (
          <ConversationView conversationId={a.active.id} focusKey={open} />
        )}
      </div>
    </aside>
  )
}

/** Every kept conversation, latest first: open one as a tab, or delete it. */
function HistoryView({ onOpen }: { onOpen: () => void }) {
  const a = useAssistant()
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const { data: all = [], refetch } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => call('conversations:list'),
    refetchOnMount: 'always'
  })
  const q = query.trim().toLowerCase()
  const shown = all
    .filter((c) => c.mode.kind !== 'dissertation' && c.messageCount > 0)
    .filter((c) => !q || `${c.title} ${c.preview}`.toLowerCase().includes(q))
  const openIds = new Set(Object.keys(a.state.conversations))
  return (
    <div className={s.history}>
      <input
        className={s.historySearch}
        value={query}
        placeholder="Search your chats"
        aria-label="Search your chats"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.length === 0 ? (
        <p className={s.historyEmpty}>{q ? 'Nothing matches.' : 'No chats yet.'}</p>
      ) : (
        <ul className={s.historyList}>
          {shown.map((c) => (
            <li key={c.id} className={s.historyItem}>
              <button
                className={s.historyOpen}
                onClick={async () => {
                  await a.reopen(c.id)
                  onOpen()
                }}
              >
                <span className={s.historyTitle}>
                  {c.title}
                  {openIds.has(c.id) && <span className={s.historyBadge}>open</span>}
                </span>
                <span className={s.historyPreview}>{c.preview}</span>
                <span className={`${s.historyWhen} num`}>{whenLabel(c.updatedAt)}</span>
              </button>
              {confirming === c.id ? (
                <span className={s.historyConfirm}>
                  <button className={s.historyCancel} onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                  <button
                    className={s.historyDelete}
                    onClick={async () => {
                      await a.deleteConversation(c.id)
                      setConfirming(null)
                      await refetch()
                    }}
                  >
                    Delete
                  </button>
                </span>
              ) : (
                <button
                  className={s.iconButton}
                  title="Delete this chat"
                  aria-label={`Delete ${c.title}`}
                  disabled={a.state.busyId === c.id}
                  onClick={() => setConfirming(c.id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** "14:05" today, "Yesterday", "Mon 16 Nov" this year, else with the year. */
function whenLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const day = (x: Date) => x.toDateString()
  if (day(d) === day(now))
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (day(d) === day(y)) return 'Yesterday'
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
}

/**
 * One conversation: its messages and the box to reply. The panel shows the active one; the
 * Dissertation page embeds its own.
 */
export function ConversationView({
  conversationId,
  empty = <EmptyState />,
  placeholder,
  focusKey
}: {
  conversationId: string
  empty?: ReactNode
  placeholder?: string
  /** Focus the box when this changes (e.g. the panel opening). */
  focusKey?: unknown
}) {
  const a = useAssistant()
  const conv = a.state.conversations[conversationId]
  if (!conv) return null
  return (
    <ConversationInner conv={conv} empty={empty} placeholder={placeholder} focusKey={focusKey} />
  )
}

function ConversationInner({
  conv,
  empty,
  placeholder,
  focusKey
}: {
  conv: Conversation
  empty: ReactNode
  placeholder?: string
  focusKey?: unknown
}) {
  const a = useAssistant()
  const busy = a.state.busyId === conv.id
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  // Files can be dropped where Claude can file them (the chat and the dissertation assistant).
  const takesFiles = conv.mode.kind === 'chat' || conv.mode.kind === 'dissertation'

  // Keep the newest message in view as the reply streams in.
  const last = conv.messages.at(-1)
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conv.id, conv.messages.length, last?.text, last?.activity.length])

  useEffect(() => {
    if (focusKey !== false) input.current?.focus()
  }, [focusKey, conv.id])

  const addFiles = async (fn: () => Promise<Attachment[] | null>) => {
    setFileError(null)
    try {
      const added = await fn()
      if (added) setFiles((x) => [...x, ...added].slice(0, 10))
    } catch (e) {
      setFileError(errorMessage(e))
    }
    input.current?.focus()
  }
  const drop = useFileDrop((paths) => {
    if (takesFiles) void addFiles(() => call('files:add', paths, null))
  })
  const unpick = (f: Attachment) => {
    setFiles((x) => x.filter((y) => y.id !== f.id))
    // Not sent yet, so not filed anywhere: Engram's copy goes.
    void call('files:remove', f.id)
  }

  const submit = () => {
    if ((!draft.trim() && !files.length) || a.state.busyId) return
    void a.send(draft, conv.id, files)
    setDraft('')
    setFiles([])
  }

  return (
    <div className={s.dropArea} {...(takesFiles ? drop.props : {})}>
      <div className={s.messages} ref={list}>
        {conv.messages.length === 0 && empty}
        {conv.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
      </div>
      <div className={s.composer} data-over={drop.over || undefined}>
        {(files.length > 0 || fileError || drop.over) && (
          <div className={s.pending}>
            {drop.over && <span className={s.dropHint}>Drop to give Claude these files</span>}
            {files.map((f) => {
              return (
                <span key={f.id} className={s.fileChip}>
                  <FileIcon file={f} size={12} /> <span className={s.fileName}>{f.name}</span>
                  <button aria-label={`Remove ${f.name}`} onClick={() => unpick(f)}>
                    <X size={11} />
                  </button>
                </span>
              )
            })}
            {fileError && <span className={s.error}>{fileError}</span>}
          </div>
        )}
        <div className={s.composerRow}>
          {takesFiles && (
            <button
              className={s.attach}
              title="Add files"
              aria-label="Add files"
              onClick={() => void addFiles(() => call('files:choose', null))}
            >
              <Paperclip size={14} />
            </button>
          )}
          <textarea
            ref={input}
            className={s.input}
            rows={2}
            value={draft}
            placeholder={
              files.length
                ? 'Say what these are for (optional)…'
                : (placeholder ??
                  (conv.mode.kind === 'chat' ? 'Ask Claude to plan or move things…' : 'Reply…'))
            }
            aria-label="Message Claude"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {busy ? (
            <button className={s.send} onClick={a.stop} title="Stop" aria-label="Stop">
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className={s.send}
              onClick={submit}
              disabled={(!draft.trim() && !files.length) || a.state.busyId !== null}
              title="Send (Enter)"
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Ready-made requests for the page the user is on (the first ones are the likeliest). */
function startersFor(path: string): string[] {
  if (/^\/modules/.test(path)) {
    return [
      'Organise this module’s lectures',
      'Which write-ups are behind in this module?',
      'Plan time to catch up on this module’s write-ups this week'
    ]
  }
  if (/^\/assignments\/./.test(path)) {
    return [
      'Am I on track for this assignment?',
      'Plan the rest of the work on this assignment',
      'Move this assignment’s next session to tomorrow'
    ]
  }
  if (/^\/backlog/.test(path)) {
    return ['Fit the Backlog into this week', 'What’s been sitting in the Backlog longest?']
  }
  return [
    'What’s left for the rest of this week?',
    'Fit my Backlog into this week',
    'What’s due in the next two weeks?',
    'Anything new on Moodle?'
  ]
}

function EmptyState() {
  const a = useAssistant()
  const { pathname } = useLocation()
  const busy = a.state.busyId !== null
  return (
    <div className={s.empty}>
      <p>Ask me to plan or move work, or start with one of these:</p>
      <div className={s.starters}>
        {startersFor(pathname).map((text) => (
          <button
            key={text}
            className={s.starter}
            disabled={busy}
            onClick={() => void a.send(text)}
          >
            {text}
          </button>
        ))}
      </div>
      <p className={s.muted}>
        Tell me how you like to work (“no write-ups after 21:00”) and I’ll remember it. I only
        organise your work and never write coursework. One change applies straight away; bigger ones
        show on the calendar for you to accept or reject.
      </p>
    </div>
  )
}

function Message({ message: m }: { message: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className={s.user}>
        {m.files && m.files.length > 0 && (
          <div className={s.sentFiles}>
            {m.files.map((f) => {
              return (
                <span key={f.id} className={s.fileChip}>
                  <FileIcon file={f} size={12} /> <span className={s.fileName}>{f.name}</span>
                </span>
              )
            })}
          </div>
        )}
        {m.text}
      </div>
    )
  }
  const working = m.pending && !m.text
  return (
    <div className={s.assistant}>
      {m.heading && <div className={s.heading}>{m.heading}</div>}
      {m.text && <RichText text={m.text} />}
      {m.pending && (
        <div className={s.activity}>
          <LoaderCircle size={12} className={s.spin} />
          {m.activity.at(-1) ?? (working ? 'Thinking' : 'Writing')}…
        </div>
      )}
      {m.error && <p className={s.error}>{m.error}</p>}
      {m.suggestions && m.suggestions.length > 0 && <Suggestions message={m} />}
      {m.batch && <BatchCard batch={m.batch} />}
    </div>
  )
}

/** Plain text with short "- " lists, **bold** and *italic*; nothing else is interpreted. */
function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`l${blocks.length}`} className={s.list}>
          {list.map((li, i) => (
            <li key={i}>{bold(li)}</li>
          ))}
        </ul>
      )
      list = []
    }
  }
  for (const line of text.split('\n')) {
    const item = /^\s*(?:[-•*]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      list.push(item[1])
      continue
    }
    flush()
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{bold(line)}</p>)
  }
  flush()
  return <div className={s.text}>{blocks}</div>
}

/** **bold** and *italic* (paper titles come back in italics). */
function bold(line: string): ReactNode[] {
  return line
    .split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.length > 2 && part.startsWith('*') && part.endsWith('*') ? (
        <em key={i}>{part.slice(1, -1)}</em>
      ) : (
        part
      )
    )
}

function BatchCard({ batch: b }: { batch: BatchSummary }) {
  const a = useAssistant()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const reverted = b.status === 'undone' || b.status === 'rejected'
  return (
    <div className={s.batch} data-status={b.status}>
      <ul className={s.batchLines}>
        {(b.lines.length
          ? b.lines
          : [`${b.changeCount} change${b.changeCount === 1 ? '' : 's'}`]
        ).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {b.status === 'pending' && (
        <>
          <p className={s.muted}>Shown on the calendar. Keep these changes?</p>
          <div className={s.batchActions}>
            <button className={s.primary} disabled={busy} onClick={run(() => a.accept(b))}>
              <Check size={12} /> Accept
            </button>
            <button className={s.secondary} disabled={busy} onClick={run(() => a.reject(b))}>
              Reject
            </button>
          </div>
        </>
      )}
      {(b.status === 'applied' || b.status === 'accepted') && (
        <div className={s.batchActions}>
          <button className={s.secondary} disabled={busy} onClick={run(() => a.undo(b))}>
            <Undo2 size={12} /> Undo
          </button>
        </div>
      )}
      {reverted && (
        <p className={s.muted}>{b.status === 'rejected' ? 'Rejected: put back.' : 'Undone.'}</p>
      )}
      {error && <p className={s.error}>{error}</p>}
    </div>
  )
}

function Suggestions({ message: m }: { message: ChatMessage }) {
  const a = useAssistant()
  return (
    <div className={s.suggestions}>
      <div className={s.muted}>Add as todos?</div>
      {m.suggestions!.map((t) => (
        <div key={t.id} className={s.suggestion} data-state={t.state}>
          <span className={s.suggestionTitle}>
            {t.title}
            {t.dueDate && <span className={s.muted}> · {t.dueDate}</span>}
          </span>
          {t.state === 'open' ? (
            <>
              <button className={s.chip} onClick={() => a.resolveSuggestion(m.id, t, true)}>
                Add
              </button>
              <button className={s.chip} onClick={() => a.resolveSuggestion(m.id, t, false)}>
                No
              </button>
            </>
          ) : (
            <span className={s.muted}>{t.state === 'added' ? 'Added' : 'Skipped'}</span>
          )}
        </div>
      ))}
    </div>
  )
}

/** First use: paste the token from `claude setup-token`. Also in Settings. */
export function TokenSetup({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    try {
      await call('assistant:setToken', token)
      setToken('')
      await qc.invalidateQueries({ queryKey: ['assistantStatus'] })
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className={compact ? s.setupCompact : s.setup}>
      {!compact && <p>Connect Claude using your own Claude plan:</p>}
      <ol className={s.steps}>
        <li>
          In Terminal, run <code>claude setup-token</code> and sign in.
        </li>
        <li>Paste the token it prints here. It’s kept in your macOS Keychain.</li>
      </ol>
      <div className={s.tokenRow}>
        <input
          className={s.tokenInput}
          type="password"
          value={token}
          placeholder="sk-ant-…"
          aria-label="Claude token"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && void save()}
        />
        <button className={s.primary} disabled={!token.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
      {error && <p className={s.error}>{error}</p>}
    </div>
  )
}
