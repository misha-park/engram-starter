import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type {
  AssistantEvent,
  Attachment,
  BatchSummary,
  ConversationMode,
  ScreenContext,
  StoredConversation
} from '@shared/types'
import { call, onEvent } from '../lib/api'
import { requestBriefPlan } from '../lib/files'
import { remember, remembered } from '../lib/remember'
import { errorMessage } from '../lib/queries'
import { Ctx, type AssistantApi, type ChatMessage, type Conversation, type State } from './store'

// The assistant's state in the renderer: conversations (chats, plus a debrief or a check-in
// when one is running), the reply streaming in, and what the user is looking at.
// Conversations are kept in the profile's database (conversations:save): the open tabs come
// back after a restart, and closed ones stay in History.

type Action =
  | { type: 'open'; open: boolean }
  | { type: 'activate'; id: string }
  | { type: 'add'; conversation: Conversation }
  | { type: 'remove'; id: string }
  | { type: 'ensure'; conversation: Conversation }
  | { type: 'push'; id: string; message: ChatMessage }
  | { type: 'patchLast'; id: string; patch: (m: ChatMessage) => ChatMessage }
  | { type: 'patchMessage'; id: string; messageId: string; patch: (m: ChatMessage) => ChatMessage }
  | { type: 'busy'; id: string | null }
  | { type: 'load'; conversations: Conversation[]; activeId: string | null }
  | { type: 'hydrate'; conversation: Conversation }
  | { type: 'retitle'; id: string; title: string }

const newId = () => Math.random().toString(36).slice(2, 10)
const mainChat = (): Conversation => ({
  id: `chat-${newId()}`,
  mode: { kind: 'chat' },
  title: 'New chat',
  messages: []
})

function reducer(state: State, a: Action): State {
  const update = (id: string, fn: (c: Conversation) => Conversation): State => {
    const c = state.conversations[id]
    return c ? { ...state, conversations: { ...state.conversations, [id]: fn(c) } } : state
  }
  switch (a.type) {
    case 'open':
      return { ...state, open: a.open }
    case 'activate':
      return { ...state, activeId: a.id, open: true }
    case 'add':
      return {
        ...state,
        open: true,
        activeId: a.conversation.id,
        conversations: { ...state.conversations, [a.conversation.id]: a.conversation }
      }
    case 'ensure':
      return state.conversations[a.conversation.id]
        ? state
        : {
            ...state,
            conversations: { ...state.conversations, [a.conversation.id]: a.conversation }
          }
    case 'remove': {
      const rest = { ...state.conversations }
      delete rest[a.id]
      // Always keep a chat to type into.
      let fallback = Object.values(rest).find((c) => c.mode.kind === 'chat')
      if (!fallback) {
        fallback = mainChat()
        rest[fallback.id] = fallback
      }
      return {
        ...state,
        conversations: rest,
        activeId: state.activeId === a.id ? fallback.id : state.activeId
      }
    }
    case 'load': {
      // The tabs kept from last time replace the empty chat the panel started with.
      const kept = { ...state.conversations }
      for (const c of Object.values(kept)) {
        if (c.mode.kind === 'chat' && c.messages.length === 0) delete kept[c.id]
      }
      for (const c of a.conversations) kept[c.id] = c
      if (!Object.values(kept).some((c) => c.mode.kind === 'chat')) {
        const chat = mainChat()
        kept[chat.id] = chat
      }
      const activeId =
        a.activeId && kept[a.activeId]
          ? a.activeId
          : (Object.values(kept).find((c) => c.mode.kind !== 'dissertation')?.id ?? state.activeId)
      return { ...state, conversations: kept, activeId }
    }
    case 'hydrate':
      // A kept conversation's messages, if nothing was said in it since the app started.
      return state.conversations[a.conversation.id]?.messages.length
        ? state
        : {
            ...state,
            conversations: { ...state.conversations, [a.conversation.id]: a.conversation }
          }
    case 'retitle':
      return update(a.id, (c) => ({ ...c, title: a.title }))
    case 'push':
      return update(a.id, (c) => ({ ...c, messages: [...c.messages, a.message] }))
    case 'patchLast':
      return update(a.id, (c) => {
        const last = c.messages.at(-1)
        return last && last.role === 'assistant'
          ? { ...c, messages: [...c.messages.slice(0, -1), a.patch(last)] }
          : c
      })
    case 'patchMessage':
      return update(a.id, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === a.messageId ? a.patch(m) : m))
      }))
    case 'busy':
      return { ...state, busyId: a.id }
  }
}

/** "Move my L7 write-up to Friday" → a tab title. */
function chatTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 40 ? `${t.slice(0, 38).trimEnd()}…` : t
}

/** A kept conversation as the panel holds it (a reply cut off by quitting is marked so). */
function fromStored(c: StoredConversation): Conversation {
  return {
    id: c.id,
    mode: c.mode,
    title: c.title,
    messages: (c.messages as ChatMessage[]).map((m) =>
      m.pending ? { ...m, pending: false, error: m.error ?? 'Interrupted.' } : m
    )
  }
}

// The active tab and whether the panel is open are kept per profile (lib/remember).
const ACTIVE_KEY = 'assistant.activeTab'
const OPEN_KEY = 'assistant.open'
const readActive = () => remembered<string | null>(ACTIVE_KEY, null)

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const chat = mainChat()
    return {
      open: remembered(OPEN_KEY, false),
      activeId: chat.id,
      conversations: { [chat.id]: chat },
      busyId: null
    }
  })
  const stateRef = useRef(state)
  stateRef.current = state
  const location = useLocation()
  const screen = useRef<Partial<ScreenContext>>({})
  const qc = useQueryClient()

  /** What was last saved of each conversation (to save only what changed). */
  const saved = useRef(new Map<string, Conversation>())

  // Bring back the tabs that were open last time.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const open = (await call('conversations:list')).filter(
        (c) => c.open && c.mode.kind !== 'dissertation'
      )
      const loaded = (await Promise.all(open.map((c) => call('conversations:get', c.id))))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map(fromStored)
      if (cancelled) return
      // Already kept as they are: don't save them again (it would reorder History).
      loaded.forEach((c) => saved.current.set(c.id, c))
      dispatch({ type: 'load', conversations: loaded, activeId: readActive() })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Keep each conversation as it changes.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const c of Object.values(state.conversations)) {
      if (saved.current.get(c.id) === c || c.messages.length === 0) continue
      // While a reply streams in, save when it pauses (so quitting mid-reply keeps the question).
      const wait = c.messages.some((m) => m.pending) ? 1500 : 300
      timers.push(
        setTimeout(() => {
          saved.current.set(c.id, c)
          void call('conversations:save', {
            id: c.id,
            title: c.title,
            mode: c.mode,
            messages: c.messages,
            open: true
          })
        }, wait)
      )
    }
    return () => timers.forEach(clearTimeout)
  }, [state.conversations])
  useEffect(() => remember(ACTIVE_KEY, state.activeId), [state.activeId])
  useEffect(() => remember(OPEN_KEY, state.open), [state.open])

  // Stream events from main into the conversation they belong to.
  useEffect(
    () =>
      onEvent('assistant:event', (e: AssistantEvent) => {
        const id = e.conversationId
        if (e.type === 'text') {
          dispatch({
            type: 'patchLast',
            id,
            patch: (m) => ({
              ...m,
              text:
                m.text + (m.afterTool && m.text && !m.text.endsWith('\n') ? '\n\n' : '') + e.text,
              afterTool: false
            })
          })
        } else if (e.type === 'tool') {
          dispatch({
            type: 'patchLast',
            id,
            patch: (m) => ({ ...m, activity: [...m.activity, e.label], afterTool: true })
          })
        } else if (e.type === 'suggestions') {
          dispatch({
            type: 'patchLast',
            id,
            patch: (m) => ({
              ...m,
              suggestions: [
                ...(m.suggestions ?? []),
                ...e.todos.map((t) => ({ ...t, state: 'open' as const }))
              ]
            })
          })
        } else if (e.type === 'planBrief') {
          requestBriefPlan(e.attachmentId, e.assignmentId)
        } else if (e.type === 'error') {
          dispatch({ type: 'patchLast', id, patch: (m) => ({ ...m, error: e.message }) })
        } else if (e.type === 'done') {
          dispatch({
            type: 'patchLast',
            id,
            patch: (m) => ({ ...m, pending: false, batch: e.batch })
          })
          if (e.batch) qc.invalidateQueries()
        }
      }),
    [qc]
  )

  const setScreen = useCallback((part: Partial<ScreenContext>) => {
    screen.current = { ...screen.current, ...part }
    return () => {
      const next = { ...screen.current }
      for (const k of Object.keys(part) as (keyof ScreenContext)[]) delete next[k]
      screen.current = next
    }
  }, [])

  // Set synchronously so a double Enter can't send twice before the next render.
  const busy = useRef(false)
  const sendTo = useCallback(
    async (conv: Conversation, text: string, files: Attachment[] = []) => {
      const id = conv.id
      if (busy.current || (!text.trim() && !files.length)) return
      busy.current = true
      // A new chat is named after its first message.
      if (conv.mode.kind === 'chat' && conv.messages.length === 0 && text.trim()) {
        dispatch({ type: 'retitle', id, title: chatTitle(text) })
      }
      dispatch({
        type: 'push',
        id,
        message: {
          id: newId(),
          role: 'user',
          text: text.trim(),
          activity: [],
          files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, readable: f.readable }))
        }
      })
      dispatch({
        type: 'push',
        id,
        message: { id: newId(), role: 'assistant', text: '', activity: [], pending: true }
      })
      dispatch({ type: 'busy', id })
      try {
        await call('assistant:send', {
          conversationId: id,
          message: text.trim(),
          mode: conv.mode,
          screen: { ...screen.current, path: location.pathname },
          attachments: files.map((f) => f.id)
        })
      } catch (e) {
        dispatch({
          type: 'patchLast',
          id,
          patch: (m) => ({ ...m, pending: false, error: errorMessage(e) })
        })
      } finally {
        busy.current = false
        dispatch({ type: 'busy', id: null })
      }
    },
    [location.pathname]
  )

  const send = useCallback(
    async (text: string, conversationId?: string, files?: Attachment[]) => {
      const s = stateRef.current
      const conv = s.conversations[conversationId ?? s.activeId]
      if (conv) await sendTo(conv, text, files)
    },
    [sendTo]
  )

  const start = useCallback(
    (mode: ConversationMode, title: string, opening: string) => {
      const existing = Object.values(stateRef.current.conversations).find(
        (c) => JSON.stringify(c.mode) === JSON.stringify(mode)
      )
      if (existing) {
        dispatch({ type: 'activate', id: existing.id })
        return
      }
      const conversation: Conversation = {
        id: `${mode.kind}-${newId()}`,
        mode,
        title,
        messages: []
      }
      dispatch({ type: 'add', conversation })
      void sendTo(conversation, opening)
    },
    [sendTo]
  )

  const reviewMessage = useCallback(async () => {
    const review = await call('assistant:review')
    if (!review) return
    const chat = Object.values(stateRef.current.conversations).find((c) => c.mode.kind === 'chat')!
    if (chat.messages.some((m) => m.id === `review-${review.weekStart}`)) {
      dispatch({ type: 'activate', id: chat.id })
      return
    }
    dispatch({ type: 'activate', id: chat.id })
    dispatch({
      type: 'push',
      id: chat.id,
      message: {
        id: `review-${review.weekStart}`,
        role: 'assistant',
        heading: 'Weekly review',
        text: review.text,
        activity: []
      }
    })
  }, [])

  useEffect(() => onEvent('assistant:open', () => void reviewMessage()), [reviewMessage])

  const patchBatch = (b: BatchSummary, status: BatchSummary['status']) => {
    for (const c of Object.values(stateRef.current.conversations)) {
      for (const m of c.messages) {
        if (m.batch?.id === b.id) {
          dispatch({
            type: 'patchMessage',
            id: c.id,
            messageId: m.id,
            patch: (x) => ({ ...x, batch: { ...x.batch!, status } })
          })
        }
      }
    }
  }

  const api = useMemo<AssistantApi>(
    () => ({
      state,
      active: state.conversations[state.activeId],
      setOpen: (open) => dispatch({ type: 'open', open }),
      toggle: () => dispatch({ type: 'open', open: !stateRef.current.open }),
      activate: (id) => dispatch({ type: 'activate', id }),
      send,
      ask: (text) => {
        const s = stateRef.current
        const active = s.conversations[s.activeId]
        const chat =
          active?.mode.kind === 'chat'
            ? active
            : Object.values(s.conversations).find((c) => c.mode.kind === 'chat')!
        dispatch({ type: 'activate', id: chat.id })
        void sendTo(chat, text)
      },
      startDebrief: (blockId, title) =>
        start({ kind: 'debrief', blockId }, `Debrief: ${title}`, `Let’s debrief “${title}”.`),
      startCheckin: (sessionId, title) =>
        start(
          { kind: 'checkin', sessionId },
          `Check-in: ${title}`,
          `My timer for “${title}” stopped itself. Let’s sort it out.`
        ),
      ensureConversation: (mode, title) => {
        const id = mode.kind === 'dissertation' ? 'dissertation' : `${mode.kind}-${newId()}`
        if (!stateRef.current.conversations[id]) {
          dispatch({ type: 'ensure', conversation: { id, mode, title, messages: [] } })
          // The dissertation's conversation is kept too: bring back what was said.
          void call('conversations:get', id).then(
            (c) => c && dispatch({ type: 'hydrate', conversation: fromStored(c) })
          )
        }
        return id
      },
      closeConversation: (id) => {
        const c = stateRef.current.conversations[id]
        if (!c || stateRef.current.busyId === id) return
        if (c.messages.length) void call('conversations:setOpen', id, false)
        saved.current.delete(id)
        dispatch({ type: 'remove', id })
      },
      reopen: async (id) => {
        if (stateRef.current.conversations[id]) {
          dispatch({ type: 'activate', id })
          return
        }
        const c = await call('conversations:get', id)
        if (!c) return
        await call('conversations:setOpen', id, true)
        const conversation = fromStored(c)
        saved.current.set(id, conversation)
        dispatch({ type: 'add', conversation })
      },
      deleteConversation: async (id) => {
        if (stateRef.current.busyId === id) return
        await call('assistant:forget', id)
        saved.current.delete(id)
        if (stateRef.current.conversations[id]) dispatch({ type: 'remove', id })
      },
      newChat: () => {
        // An empty chat already open is reused rather than piling up blank tabs.
        const blank = Object.values(stateRef.current.conversations).find(
          (c) => c.mode.kind === 'chat' && c.messages.length === 0
        )
        if (blank) dispatch({ type: 'activate', id: blank.id })
        else dispatch({ type: 'add', conversation: mainChat() })
      },
      stop: () => void call('assistant:stop'),
      setScreen,
      undo: async (b) => {
        await call('assistant:undo', b.id)
        patchBatch(b, 'undone')
      },
      accept: async (b) => {
        await call('assistant:accept', b.id)
        patchBatch(b, 'accepted')
        await qc.invalidateQueries({ queryKey: ['assistantPending'] })
      },
      reject: async (b) => {
        await call('assistant:reject', b.id)
        patchBatch(b, 'rejected')
      },
      resolveSuggestion: async (messageId, s, add) => {
        if (add) await call('assistant:addTodo', s)
        const conv = Object.values(stateRef.current.conversations).find((c) =>
          c.messages.some((m) => m.id === messageId)
        )
        if (!conv) return
        dispatch({
          type: 'patchMessage',
          id: conv.id,
          messageId,
          patch: (m) => ({
            ...m,
            suggestions: m.suggestions?.map((x) =>
              x.id === s.id ? { ...x, state: add ? 'added' : 'dismissed' } : x
            )
          })
        })
        if (add) await qc.invalidateQueries({ queryKey: ['todos'] })
      }
    }),
    [state, send, sendTo, start, setScreen, qc]
  )

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
