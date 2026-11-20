import { Temporal } from 'temporal-polyfill'
import type { PlanDraft } from '../../shared/types'
import { isReadableDocument, readDocument } from '../documents'

// Plan import: Claude turns a short project proposal into sections and milestones, which the
// user checks before anything is saved. This is organisation (structure and dates), not writing.

const MAX_CHARS = 60_000

export const PLAN_SYSTEM = `You turn a student's dissertation (literature review) proposal into a plan for their study planner. Extract only what the proposal states or clearly implies:
- the dissertation title, if given
- its sections or chapters, in order, as short titles (e.g. "Introduction", "Search strategy and methods", "Microglia in development"), with a word target when the proposal gives one
- milestones with dates (YYYY-MM-DD), e.g. proposal sign-off, literature search done, first draft (not the submission or the viva: they have their own fields)
- the submission date and the overall word limit, if given
Never invent content, arguments or headings the proposal doesn't support, and never write any of the dissertation. If something isn't in the proposal, leave it out (or null). Interpret relative dates from today's date given below.`

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'sections', 'milestones', 'submissionDue', 'wordTarget'],
  properties: {
    title: { type: ['string', 'null'] },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'wordTarget'],
        properties: { title: { type: 'string' }, wordTarget: { type: ['integer', 'null'] } }
      }
    },
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'due'],
        properties: {
          title: { type: 'string' },
          due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
        }
      }
    },
    submissionDue: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    wordTarget: { type: ['integer', 'null'] }
  }
} as const

/** The proposal's text from a file: plain text, Word/RTF/HTML (textutil) or PDF (PDFKit). */
export async function readProposal(path: string): Promise<string> {
  if (!isReadableDocument(path)) {
    throw new Error('Choose a Word, PDF or text file, or paste the proposal instead.')
  }
  return readDocument(path, MAX_CHARS)
}

/** Tidy what Claude returned into a draft for the review form. */
export function cleanDraft(raw: unknown): PlanDraft {
  const r = (raw ?? {}) as Partial<PlanDraft>
  const date = (s: unknown) =>
    typeof s === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    (() => {
      try {
        Temporal.PlainDate.from(s)
        return true
      } catch {
        return false
      }
    })()
  const int = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : null)
  return {
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 200) : null,
    sections: (Array.isArray(r.sections) ? r.sections : [])
      .filter((s) => typeof s?.title === 'string' && s.title.trim())
      .slice(0, 30)
      .map((s) => ({ title: s.title.trim().slice(0, 120), wordTarget: int(s.wordTarget) })),
    milestones: (Array.isArray(r.milestones) ? r.milestones : [])
      .filter((m) => typeof m?.title === 'string' && m.title.trim() && date(m.due))
      // The submission and the viva are shown from their own settings.
      .filter((m) => !/^(final\s+)?(submission|submit|hand[- ]?in|viva)\b/i.test(m.title.trim()))
      .slice(0, 30)
      .map((m) => ({ title: m.title.trim().slice(0, 120), due: m.due })),
    submissionDue: date(r.submissionDue) ? (r.submissionDue as string) : null,
    wordTarget: int(r.wordTarget)
  }
}

export async function extractPlan(
  text: string,
  today: Temporal.PlainDate,
  completeJson: (
    system: string,
    prompt: string,
    schema: Record<string, unknown>
  ) => Promise<unknown>
): Promise<PlanDraft> {
  const proposal = text.trim().slice(0, MAX_CHARS)
  if (proposal.length < 40) throw new Error('Paste a little more of the proposal first.')
  const raw = await completeJson(
    PLAN_SYSTEM,
    `Today is ${today.toString()}.\n\nThe proposal:\n"""\n${proposal}\n"""`,
    PLAN_SCHEMA as unknown as Record<string, unknown>
  )
  return cleanDraft(raw)
}
