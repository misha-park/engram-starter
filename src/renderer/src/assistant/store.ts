import { createContext, useContext, useEffect } from 'react'
import type {
  Attachment,
  BatchSummary,
  ConversationMode,
  ScreenContext,
  TodoSuggestion
} from '@shared/types'

// The assistant's shared state and hooks (the provider is in AssistantContext.tsx).

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Tool activity while replying ("Looking for free time"). */
  activity: string[]
  batch?: BatchSummary | null
  suggestions?: (TodoSuggestion & { state: 'open' | 'added' | 'dismissed' })[]
  error?: string
  /** Still streaming. */
  pending?: boolean
  /** A tool ran since the last text: the next text starts a new paragraph. */
  afterTool?: boolean
  /** A heading shown above the message (e.g. "Weekly review"). */
  heading?: string
  /** Files the user dropped with this message. */
  files?: Pick<Attachment, 'id' | 'name' | 'mime' | 'readable'>[]
}

export interface Conversation {
  id: string
  mode: ConversationMode
  title: string
  messages: ChatMessage[]
}

export interface State {
  open: boolean
  activeId: string
  conversations: Record<string, Conversation>
  busyId: string | null
}

export interface AssistantApi {
  state: State
  active: Conversation
  setOpen(open: boolean): void
  toggle(): void
  activate(id: string): void
  /** Send a message in the active conversation (or the main chat). */
  send(text: string, conversationId?: string, files?: Attachment[]): Promise<void>
  /** Open the main chat and send this. */
  ask(text: string): void
  startDebrief(blockId: string, title: string): void
  startCheckin(sessionId: string, title: string): void
  /** Close a tab (the conversation stays in History). */
  closeConversation(id: string): void
  /** Open a kept conversation from History as a tab. */
  reopen(id: string): Promise<void>
  /** Delete a conversation for good. */
  deleteConversation(id: string): Promise<void>
  /** A conversation for this mode (created quietly if needed), without opening the panel. */
  ensureConversation(mode: ConversationMode, title: string): string
  /** A new chat in a new tab. */
  newChat(): void
  stop(): void
  /** Pages report what they show, for "this week" / "this module". */
  setScreen(part: Partial<ScreenContext>): () => void
  undo(batch: BatchSummary): Promise<void>
  accept(batch: BatchSummary): Promise<void>
  reject(batch: BatchSummary): Promise<void>
  resolveSuggestion(messageId: string, suggestion: TodoSuggestion, add: boolean): Promise<void>
}

export const Ctx = createContext<AssistantApi | null>(null)

export function useAssistant(): AssistantApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useAssistant outside AssistantProvider')
  return api
}

/** Tell the assistant what this page shows while it's mounted. */
export function useAssistantScreen(part: Partial<ScreenContext>): void {
  const { setScreen } = useAssistant()
  const key = JSON.stringify(part)
  useEffect(() => setScreen(JSON.parse(key)), [key, setScreen])
}
