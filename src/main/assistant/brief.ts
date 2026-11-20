import { Temporal } from 'temporal-polyfill'
import { ASSIGNMENT_TYPES, type AssignmentPlanDraft, type AssignmentType } from '../../shared/types'
import { atLocalTime, toIso } from '../../core/time'
import { createAssignment, replaceOpenStages, updateAssignment } from '../assignments'
import { listAttachments, readAttachmentText, setTarget } from '../attachments'
import type { Db } from '../db/client'
import * as t from '../db/schema'
import { eq } from 'drizzle-orm'

// Planning an assignment from its brief (Phase 8): Claude reads the brief (or marking
// criteria) and suggests the assignment's details, a short summary of what it asks for, and a
// stage breakdown with estimates. The user edits the draft before anything is saved. This is
// organisation: what the work is, when it's due and how to split the time, never any of the
// work itself.

const MAX_CHARS = 60_000
const STEP = 15

export const BRIEF_SYSTEM = `You help a student plan an assignment in their study planner from its brief or marking criteria. Extract only what the brief states or clearly implies:
- a short title for the assignment
- which of the student's modules it belongs to (choose one id from the list given, or null)
- its type: essay, lab-report, problem-set, presentation or other
- the due date (YYYY-MM-DD) and time (HH:MM, 24h), if given
- its weighting (% of the module) and word limit, if given
- a summary of what the assignment asks for, in 2 to 4 short sentences addressed to the student ("You…"): the task, what to hand in, its format and length, and what the marking emphasises
- a breakdown into 3 to 7 stages of work, in order, each with a realistic estimate in minutes for a third-year undergraduate (e.g. "Read the brief and marking criteria", "Background reading", "Analyse the data", "Draft", "Edit and reference"). Base the stages on what the brief asks for.
Never write, outline or answer any part of the assignment, and never suggest content, arguments, answers or a structure for the student's own work: describe only what is asked, when, and how to split the time. If something isn't in the brief, leave it null. Interpret relative dates from today's date given below.`

export const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'moduleId',
    'type',
    'dueDate',
    'dueTime',
    'weighting',
    'wordLimit',
    'summary',
    'stages'
  ],
  properties: {
    title: { type: ['string', 'null'] },
    moduleId: { type: ['string', 'null'] },
    type: { type: 'string', enum: [...ASSIGNMENT_TYPES] },
    dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    dueTime: { type: ['string', 'null'], description: 'HH:MM' },
    weighting: { type: ['integer', 'null'] },
    wordLimit: { type: ['integer', 'null'] },
    summary: { type: ['string', 'null'] },
    stages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'minutes'],
        properties: { name: { type: 'string' }, minutes: { type: 'integer' } }
      }
    }
  }
} as const

const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  try {
    Temporal.PlainDate.from(s)
    return true
  } catch {
    return false
  }
}

/** Tidy what Claude returned into a draft for the review form. */
export function cleanBriefDraft(raw: unknown, moduleIds: string[]): AssignmentPlanDraft {
  const r = (raw ?? {}) as Record<string, unknown>
  const int = (n: unknown, max: number) =>
    Number.isInteger(n) && (n as number) > 0 && (n as number) <= max ? (n as number) : null
  const stages = (Array.isArray(r.stages) ? r.stages : [])
    .filter((s) => typeof s?.name === 'string' && s.name.trim())
    .slice(0, 10)
    .map((s) => ({
      name: (s.name as string).trim().slice(0, 120),
      minutes: Math.min(
        100 * 60,
        Math.max(STEP, Math.round((Number(s.minutes) || 60) / STEP) * STEP)
      )
    }))
  return {
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 200) : null,
    moduleId: typeof r.moduleId === 'string' && moduleIds.includes(r.moduleId) ? r.moduleId : null,
    type: ASSIGNMENT_TYPES.includes(r.type as AssignmentType)
      ? (r.type as AssignmentType)
      : 'other',
    dueDate: isDate(r.dueDate) ? r.dueDate : null,
    dueTime:
      typeof r.dueTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.dueTime)
        ? r.dueTime
        : null,
    weighting: int(r.weighting, 100),
    wordLimit: int(r.wordLimit, 100_000),
    summary:
      typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim().slice(0, 2000) : null,
    stages
  }
}

export async function extractBriefPlan(
  text: string,
  today: Temporal.PlainDate,
  modules: { id: string; label: string }[],
  completeJson: (
    system: string,
    prompt: string,
    schema: Record<string, unknown>
  ) => Promise<unknown>
): Promise<AssignmentPlanDraft> {
  const brief = text.trim().slice(0, MAX_CHARS)
  if (brief.length < 40) throw new Error('There’s too little text in that brief to plan from.')
  const list = modules.map((m) => `- ${m.id}: ${m.label}`).join('\n')
  const raw = await completeJson(
    BRIEF_SYSTEM,
    `Today is ${today.toString()}.\n\nThe student's modules (id: name):\n${list}\n\nThe brief:\n"""\n${brief}\n"""`,
    BRIEF_SCHEMA as unknown as Record<string, unknown>
  )
  return cleanBriefDraft(
    raw,
    modules.map((m) => m.id)
  )
}

/**
 * Save a checked draft: a new assignment, or the details and unstarted stages of an existing
 * one. The brief, if it was a file, is attached to the assignment. Returns the assignment id.
 */
export function applyBriefPlan(
  db: Db,
  draft: AssignmentPlanDraft,
  opts: { assignmentId?: string | null; attachmentId?: string | null; planned?: boolean },
  now: Temporal.Instant
): string {
  if (!draft.stages.length) throw new Error('Add at least one stage.')
  const stages = draft.stages.map((s) => ({ name: s.name, estimateMinutes: s.minutes }))
  const due =
    draft.dueDate &&
    toIso(atLocalTime(Temporal.PlainDate.from(draft.dueDate), draft.dueTime ?? '12:00'))
  let id = opts.assignmentId ?? null
  if (id) {
    updateAssignment(
      db,
      id,
      {
        ...(draft.title ? { title: draft.title } : {}),
        ...(due ? { due } : {}),
        type: draft.type,
        weighting: draft.weighting,
        wordLimit: draft.wordLimit,
        ...(draft.summary !== undefined ? { summary: draft.summary } : {})
      },
      now
    )
    replaceOpenStages(db, id, stages, now)
  } else {
    if (!draft.title) throw new Error('Give the assignment a title.')
    if (!draft.moduleId) throw new Error('Choose the module.')
    if (!due) throw new Error('Set the due date.')
    id = createAssignment(
      db,
      {
        moduleId: draft.moduleId,
        title: draft.title,
        due,
        type: draft.type,
        weighting: draft.weighting,
        wordLimit: draft.wordLimit,
        summary: draft.summary,
        planned: opts.planned ?? true,
        estimateMinutes: stages.reduce((sum, s) => sum + s.estimateMinutes, 0),
        stages
      },
      now
    )
  }
  if (opts.attachmentId) setTarget(db, opts.attachmentId, { type: 'assignment', id })
  return id
}

export const SUMMARY_SYSTEM = `You help a student keep track of an assignment in their study planner. From its brief, write a summary of what the assignment asks for, in 2 to 4 short sentences addressed to the student ("You…"): the task, what to hand in, its format and length, and what the marking emphasises. Say only what the brief states. Never write, outline or answer any part of the assignment, and never suggest content, arguments, answers or a structure for the student's own work.`

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: ['string', 'null'] } }
} as const

/** Summarise what an assignment asks for, from its brief's text. */
export async function summariseBrief(
  title: string,
  text: string,
  completeJson: (
    system: string,
    prompt: string,
    schema: Record<string, unknown>
  ) => Promise<unknown>
): Promise<string | null> {
  const doc = text.trim().slice(0, MAX_CHARS)
  if (doc.length < 40) return null
  const raw = (await completeJson(
    SUMMARY_SYSTEM,
    `The assignment: ${title}\n\nThe brief:\n"""\n${doc}\n"""`,
    SUMMARY_SCHEMA as unknown as Record<string, unknown>
  )) as { summary?: unknown } | null
  return typeof raw?.summary === 'string' && raw.summary.trim()
    ? raw.summary.trim().slice(0, 2000)
    : null
}

/** The file most likely to be an assignment's brief: one named "brief", else the first readable. */
function briefFile(db: Db, assignmentId: string) {
  const readable = listAttachments(db, { type: 'assignment', id: assignmentId }).filter(
    (a) => a.readable
  )
  return (
    readable.find((a) => /brief/i.test(a.name)) ??
    readable.find((a) => !/marking|criteria|rubric/i.test(a.name)) ??
    readable[0] ??
    null
  )
}

/** Summarise an assignment from its brief and keep the summary. Returns it (null = no brief). */
export async function summariseAssignment(
  db: Db,
  filesDir: string,
  assignmentId: string,
  completeJson: (
    system: string,
    prompt: string,
    schema: Record<string, unknown>
  ) => Promise<unknown>,
  now: Temporal.Instant
): Promise<string | null> {
  const a = db.select().from(t.assignments).where(eq(t.assignments.id, assignmentId)).get()
  if (!a) throw new Error('Assignment not found.')
  const file = briefFile(db, assignmentId)
  if (!file) return null
  const summary = await summariseBrief(
    a.title,
    await readAttachmentText(db, filesDir, file.id),
    completeJson
  )
  if (summary) updateAssignment(db, assignmentId, { summary }, now)
  return summary
}
