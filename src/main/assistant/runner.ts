import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import type { Temporal } from 'temporal-polyfill'
import type {
  AssistantEvent,
  BatchSummary,
  ConversationMode,
  ScreenContext,
  TodoSuggestion
} from '../../shared/types'
import type { Db } from '../db/client'
import { getAttachments } from '../attachments'
import { deleteConversation, getSessionId, setSessionId } from './conversations'
import { ChangeTracker, getBatch, recordBatch } from './changes'
import { dynamicPrompt, STATIC_PROMPT } from './prompt'
import { toolsFor, type ToolContext, type ToolDef } from './tools'

// Runs assistant turns through the Claude Agent SDK. Claude only gets Engram's own tools
// (no shell, files or web), no user settings or CLAUDE.md, and the user's Claude plan via the
// OAuth token. Each turn's data changes become one batch (undo, review).

export const ASSISTANT_MODEL = 'claude-opus-5-5'
const SERVER = 'engram'

export interface AssistantDeps {
  db(): Db
  recordsDir(): string
  /** Where the profile keeps attached files. */
  filesDir(): string
  now(): Temporal.Instant
  token(): Promise<string | null>
  /** Where the SDK keeps its session files (no project files live there). */
  workDir: string
  emit(event: AssistantEvent): void
  dataChanged(): void
  /** The Claude Code process's environment (default: `assistantEnv`). The evals override it. */
  env?(token: string): Record<string, string | undefined>
  /**
   * The native `claude` binary, when the SDK can't find it itself: in the packaged app it
   * resolves a path inside app.asar, which can't be run (unset in development).
   */
  executable?: string
}

export interface TurnRequest {
  conversationId: string
  message: string
  mode: ConversationMode
  screen?: ScreenContext
  /** Files the user dropped with this message (already added, unfiled or attached). */
  attachments?: string[]
}

/** An event without the ids the runner adds (distributes over the union). */
type EventBody<E = AssistantEvent> = E extends AssistantEvent
  ? Omit<E, 'conversationId' | 'turnId'>
  : never

const TOOL_LABELS: Record<string, string> = {
  get_schedule: 'Checking the calendar',
  find_free_slots: 'Looking for free time',
  get_backlog: 'Reading the Backlog',
  get_modules: 'Reading modules',
  get_assignments: 'Reading assignments',
  get_todos: 'Reading todos',
  get_record: 'Reading records',
  get_week_summary: 'Adding up the week',
  get_recent_changes: 'Checking recent changes',
  move_block: 'Moving a block',
  create_block: 'Adding a block',
  mark_outcome: 'Marking an outcome',
  schedule_backlog_item: 'Scheduling from the Backlog',
  get_general_deadlines: 'Reading deadlines',
  create_deadline: 'Adding a deadline',
  update_deadline: 'Updating a deadline',
  create_todo: 'Adding a todo',
  update_assignment_stage: 'Updating a stage',
  undo_change: 'Undoing a change',
  save_debrief: 'Saving the debrief',
  suggest_todos: 'Suggesting todos',
  complete_checkin: 'Finishing the check-in',
  list_files: 'Looking at your files',
  read_file: 'Reading the file',
  attach_file: 'Attaching the file',
  plan_assignment_from_brief: 'Opening Plan from brief',
  get_module_files: 'Looking at the module’s files',
  rename_lecture: 'Naming a lecture',
  split_lecture: 'Splitting a lecture',
  join_lecture: 'Joining a lecture',
  combine_lectures: 'Combining lectures',
  separate_lecture: 'Separating a lecture',
  merge_with_previous_lecture: 'Merging lectures',
  create_repeating_event: 'Adding a repeating event',
  save_pasted_brief: 'Saving the brief',
  end_series_after: 'Ending a repeating event',
  set_file_lecture: 'Placing a file',
  update_todo: 'Updating a todo',
  tick_todo: 'Ticking a todo',
  archive_todo: 'Archiving a todo',
  update_event: 'Updating an event',
  delete_event: 'Deleting an event',
  remove_occurrence: 'Removing an occurrence',
  update_series: 'Updating a series',
  set_availability: 'Changing availability',
  create_assignment: 'Adding an assignment',
  update_assignment: 'Updating an assignment',
  set_assignment_total_time: 'Changing the total time',
  set_assignment_planned: 'Planning an assignment',
  set_assignment_submitted: 'Marking it submitted',
  delete_assignment: 'Deleting an assignment',
  add_assignment_stage: 'Adding a stage',
  remove_assignment_stage: 'Removing a stage',
  move_assignment_stage: 'Moving a stage',
  update_module: 'Updating a module',
  set_lecture_attended: 'Marking attendance',
  set_lecture_flashcards: 'Ticking flashcards',
  set_lecture_notes: 'Ticking notes',
  delete_timetable_event: 'Deleting a timetable event',
  update_dissertation_settings: 'Updating the dissertation',
  add_dissertation_section: 'Adding a section',
  remove_dissertation_section: 'Removing a section',
  add_milestone: 'Adding a milestone',
  remove_milestone: 'Removing a milestone',
  save_meeting: 'Saving the meeting',
  remove_meeting: 'Removing a meeting',
  get_reviews: 'Reading reviews',
  reschedule_review: 'Moving a review',
  get_week_settings: 'Reading your week',
  set_weekly_target: 'Setting the weekly target',
  add_commitment: 'Adding a commitment',
  end_commitment: 'Ending a commitment',
  set_start_date: 'Setting the start date',
  dismiss_backlog_item: 'Letting go of a Backlog item',
  log_time: 'Logging time',
  get_dissertation: 'Reading the dissertation',
  update_dissertation_section: 'Updating a section',
  update_milestone: 'Updating a milestone',
  update_reading: 'Updating the reading list',
  schedule_dissertation_session: 'Planning a dissertation session',
  find: 'Looking it up',
  get_stats: 'Adding up your study time',
  get_notifications: 'Checking notifications',
  organise_lectures: 'Organising lectures',
  take_time_off: 'Clearing the time',
  remember: 'Remembering that',
  forget: 'Forgetting that'
}

/** The environment for the Claude Code process: the OAuth token, never an API key. */
export function assistantEnv(token: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  // Either of these would take precedence over the token and bill elsewhere.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ELECTRON_RUN_AS_NODE
  env.CLAUDE_CODE_OAUTH_TOKEN = token
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'engram/0.1'
  return env
}

function friendlyError(raw: string): string {
  if (/authenticat|401|invalid.*token|oauth/i.test(raw)) {
    return 'Claude didn’t accept the token. Run `claude setup-token` again and paste the new token in Settings.'
  }
  if (/rate.?limit|usage limit|You've hit your|You've reached your/i.test(raw)) {
    return 'Your Claude plan’s usage limit has been reached for now. Try again later.'
  }
  return raw || 'Something went wrong talking to Claude.'
}

export class Assistant {
  /**
   * Conversation id → Agent SDK session id, so later messages resume the same conversation
   * (also kept in the conversations table, for after a restart).
   */
  private readonly sessions = new Map<string, string>()
  private running: AbortController | null = null

  constructor(private readonly deps: AssistantDeps) {
    mkdirSync(deps.workDir, { recursive: true })
  }

  private env(token: string): Record<string, string | undefined> {
    return this.deps.env ? this.deps.env(token) : assistantEnv(token)
  }

  get busy(): boolean {
    return this.running !== null
  }

  stop(): void {
    this.running?.abort()
  }

  /** Forget a conversation for good (deleted from History). */
  forget(conversationId: string): void {
    this.sessions.delete(conversationId)
    deleteConversation(this.deps.db(), conversationId)
  }

  private sessionOf(conversationId: string): string | undefined {
    return (
      this.sessions.get(conversationId) ?? getSessionId(this.deps.db(), conversationId) ?? undefined
    )
  }

  /** Run one turn. Resolves when Claude has finished (events stream out meanwhile). */
  async send(req: TurnRequest): Promise<BatchSummary | null> {
    if (this.running) throw new Error('Claude is still replying.')
    const token = await this.deps.token()
    if (!token) throw new Error('Add your Claude token in Settings first.')
    const typed = req.message.trim()
    const dropped = getAttachments(this.deps.db(), (req.attachments ?? []).slice(0, 10))
    if (!typed && !dropped.length) throw new Error('Type a message first.')
    if (typed.length > 8000) throw new Error('That message is too long.')
    // Claude sees the dropped files as a note before the message, and reads them with read_file.
    const message = dropped.length
      ? `[The user added ${dropped.length === 1 ? 'a file' : `${dropped.length} files`} to Engram with this message: ${dropped
          .map(
            (f) =>
              `“${f.name}” (file_id ${f.id}${f.targetLabel ? `, attached to ${f.targetLabel}` : ', not attached to anything yet'}${f.readable ? '' : ', text not readable'})`
          )
          .join(
            '; '
          )}. Use read_file to see what it is, then attach it where it belongs (ask if unsure).]\n\n${typed || 'Please file this.'}`
      : typed

    const turnId = randomUUID()
    const { conversationId } = req
    const emit = (e: EventBody) =>
      this.deps.emit({ ...e, conversationId, turnId } as AssistantEvent)

    const abort = new AbortController()
    this.running = abort
    const db = this.deps.db()
    const tracker = new ChangeTracker(db)
    emit({ type: 'start' })

    let batch: BatchSummary | null
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const ctx: ToolContext = {
        db,
        recordsDir: this.deps.recordsDir(),
        now: () => this.deps.now(),
        mode: req.mode,
        suggest: (todos: TodoSuggestion[]) => emit({ type: 'suggestions', todos }),
        filesDir: this.deps.filesDir(),
        planBrief: (attachmentId, assignmentId) =>
          emit({ type: 'planBrief', attachmentId, assignmentId }),
        completeJson: (system, prompt, schema, signal) =>
          this.completeJson(system, prompt, schema, signal ?? abort.signal)
      }
      const defs = toolsFor(req.mode)
      const server = sdk.createSdkMcpServer({
        name: SERVER,
        version: '1.0.0',
        alwaysLoad: true,
        tools: defs.map((d) => this.sdkTool(sdk.tool, d, ctx, tracker))
      })

      const resume = this.sessionOf(conversationId)
      const ask = (resumeId: string | undefined) =>
        sdk.query({
          prompt: message,
          options: {
            model: ASSISTANT_MODEL,
            effort: 'medium',
            systemPrompt: [
              STATIC_PROMPT,
              sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
              dynamicPrompt(db, this.deps.now(), req.mode, req.screen)
            ],
            // No built-in tools (shell, files, web): only Engram's own.
            tools: [],
            mcpServers: { [SERVER]: server },
            allowedTools: defs.map((d) => `mcp__${SERVER}__${d.name}`),
            permissionMode: 'dontAsk',
            // Don't load ~/.claude settings, CLAUDE.md, hooks or plugins.
            settingSources: [],
            cwd: this.deps.workDir,
            env: this.env(token),
            pathToClaudeCodeExecutable: this.deps.executable,
            resume: resumeId,
            includePartialMessages: true,
            maxTurns: 30,
            abortController: abort,
            stderr: (data) => console.error('[assistant]', data.trimEnd())
          }
        })

      const consume = async (resumeId: string | undefined) => {
        let streamed = false
        for await (const msg of ask(resumeId)) {
          if (
            'session_id' in msg &&
            msg.session_id &&
            this.sessions.get(conversationId) !== msg.session_id
          ) {
            this.sessions.set(conversationId, msg.session_id)
            setSessionId(db, conversationId, req.mode, msg.session_id, this.deps.now())
          }
          if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
            const ev = msg.event
            if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
              streamed = true
              emit({ type: 'text', text: ev.delta.text })
            }
          } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
            if (msg.error) throw new Error(friendlyError(msg.error))
            for (const block of msg.message.content) {
              if (block.type === 'tool_use') {
                const name = block.name.replace(`mcp__${SERVER}__`, '')
                emit({ type: 'tool', name, label: TOOL_LABELS[name] ?? name })
              } else if (block.type === 'text' && !streamed) {
                emit({ type: 'text', text: block.text })
              }
            }
            streamed = false
          } else if (msg.type === 'result') {
            if (msg.subtype !== 'success') {
              throw new Error(friendlyError(msg.errors.join(' ')))
            }
            if (msg.is_error) throw new Error(friendlyError(msg.result))
          }
        }
      }
      try {
        await consume(resume)
      } catch (e) {
        // The saved session is gone (e.g. Claude's files were cleared): start a fresh one.
        const msg = e instanceof Error ? e.message : String(e)
        if (!resume || abort.signal.aborted || !/no conversation found/i.test(msg)) throw e
        this.sessions.delete(conversationId)
        setSessionId(db, conversationId, req.mode, null, this.deps.now())
        await consume(undefined)
      }
    } catch (e) {
      const text = abort.signal.aborted
        ? 'Stopped.'
        : friendlyError(e instanceof Error ? e.message : String(e))
      emit({ type: 'error', message: text })
    } finally {
      // Whatever was changed (even by a turn that failed half way) is one undoable batch.
      const id = recordBatch(
        db,
        { changes: tracker.all, request: message, conversationId },
        this.deps.now()
      )
      batch = id ? getBatch(db, id) : null
      this.running = null
      if (batch) this.deps.dataChanged()
      emit({ type: 'done', batch })
    }
    return batch
  }

  /**
   * A one-off reply with no tools and no conversation (the Sunday review). Returns the text.
   */
  async complete(system: string, prompt: string): Promise<string> {
    const token = await this.deps.token()
    if (!token) throw new Error('Add your Claude token in Settings first.')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const q = sdk.query({
      prompt,
      options: {
        model: ASSISTANT_MODEL,
        effort: 'low',
        systemPrompt: system,
        tools: [],
        settingSources: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        maxTurns: 1,
        cwd: this.deps.workDir,
        env: this.env(token),
        pathToClaudeCodeExecutable: this.deps.executable
      }
    })
    for await (const msg of q) {
      if (msg.type === 'assistant' && msg.error) throw new Error(friendlyError(msg.error))
      if (msg.type === 'result') {
        if (msg.subtype !== 'success' || msg.is_error) {
          throw new Error(
            friendlyError(msg.subtype === 'success' ? msg.result : msg.errors.join(' '))
          )
        }
        return msg.result.trim()
      }
    }
    throw new Error('Claude didn’t reply.')
  }

  /**
   * A one-off reply as JSON matching `schema` (no tools, no conversation): the plan import.
   */
  async completeJson(
    system: string,
    prompt: string,
    schema: Record<string, unknown>,
    /** Stops the request (e.g. the user pressed Stop). */
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('Stopped.')
    const token = await this.deps.token()
    if (!token) throw new Error('Add your Claude token in Settings first.')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const abort = new AbortController()
    signal?.addEventListener('abort', () => abort.abort(), { once: true })
    const q = sdk.query({
      prompt,
      options: {
        abortController: abort,
        model: ASSISTANT_MODEL,
        effort: 'low',
        systemPrompt: system,
        tools: [],
        settingSources: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        maxTurns: 3,
        outputFormat: { type: 'json_schema', schema },
        cwd: this.deps.workDir,
        env: this.env(token),
        pathToClaudeCodeExecutable: this.deps.executable
      }
    })
    try {
      for await (const msg of q) {
        if (signal?.aborted) throw new Error('Stopped.')
        if (msg.type === 'assistant' && msg.error) throw new Error(friendlyError(msg.error))
        if (msg.type === 'result') {
          if (msg.subtype !== 'success' || msg.is_error) {
            throw new Error(
              friendlyError(msg.subtype === 'success' ? msg.result : msg.errors.join(' '))
            )
          }
          if (msg.structured_output === undefined) throw new Error('Claude didn’t return a plan.')
          return msg.structured_output
        }
      }
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped.', { cause: e })
      throw e
    }
    if (signal?.aborted) throw new Error('Stopped.')
    throw new Error('Claude didn’t reply.')
  }

  /** Wrap a tool definition as an SDK tool: tracked if it changes data, errors as tool errors. */
  private sdkTool(
    tool: typeof import('@anthropic-ai/claude-agent-sdk').tool,
    d: ToolDef,
    ctx: ToolContext,
    tracker: ChangeTracker
  ) {
    return tool(
      d.name,
      d.description,
      d.shape,
      async (args) => {
        try {
          const result = await (d.mutates
            ? tracker.track(() => d.run(args, ctx))
            : d.run(args, ctx))
          if (d.mutates || d.name === 'undo_change') this.deps.dataChanged()
          const text = typeof result === 'string' ? result : JSON.stringify(result)
          return { content: [{ type: 'text' as const, text }] }
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
            isError: true
          }
        }
      },
      { annotations: { readOnlyHint: !d.mutates && d.name !== 'undo_change' } }
    )
  }
}
