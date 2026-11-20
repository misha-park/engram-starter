import type { AssignmentStatus, AssignmentType } from '../shared/types'
import { STEP_MINUTES } from './scheduler'

/**
 * Default stage breakdowns by assignment type (share of the total estimate). The user edits
 * them; from Phase 6 Claude can suggest a breakdown from the brief instead.
 */
export const STAGE_TEMPLATES: Record<AssignmentType, { name: string; share: number }[]> = {
  essay: [
    { name: 'Read and research', share: 0.35 },
    { name: 'Plan', share: 0.1 },
    { name: 'Draft', share: 0.35 },
    { name: 'Edit and references', share: 0.2 }
  ],
  'lab-report': [
    { name: 'Analyse data', share: 0.3 },
    { name: 'Methods and results', share: 0.3 },
    { name: 'Introduction and discussion', share: 0.3 },
    { name: 'Edit', share: 0.1 }
  ],
  'problem-set': [
    { name: 'Work the problems', share: 0.75 },
    { name: 'Check and write up', share: 0.25 }
  ],
  presentation: [
    { name: 'Research', share: 0.35 },
    { name: 'Slides', share: 0.35 },
    { name: 'Rehearse', share: 0.3 }
  ],
  other: [
    { name: 'Plan', share: 0.2 },
    { name: 'Do the work', share: 0.6 },
    { name: 'Finish and check', share: 0.2 }
  ]
}

/** Default total estimate by type, in minutes (the form's starting value). */
export const DEFAULT_ESTIMATE_MINUTES: Record<AssignmentType, number> = {
  essay: 15 * 60,
  'lab-report': 12 * 60,
  'problem-set': 6 * 60,
  presentation: 8 * 60,
  other: 8 * 60
}

/** Split a total estimate into the type's stages, in quarter hours, summing exactly to the total. */
export function templateStages(
  type: AssignmentType,
  totalMinutes: number
): { name: string; minutes: number }[] {
  const template = STAGE_TEMPLATES[type]
  const total = Math.max(STEP_MINUTES, Math.round(totalMinutes / STEP_MINUTES) * STEP_MINUTES)
  const stages = template.map((t) => ({
    name: t.name,
    minutes: Math.max(STEP_MINUTES, Math.round((total * t.share) / STEP_MINUTES) * STEP_MINUTES)
  }))
  // Put any rounding difference on the largest stage.
  const diff = total - stages.reduce((s, x) => s + x.minutes, 0)
  const largest = stages.reduce((a, b) => (b.minutes > a.minutes ? b : a))
  largest.minutes = Math.max(STEP_MINUTES, largest.minutes + diff)
  return stages
}

/** Status stops at "submitted"; before that it follows the work. */
export function assignmentStatus(opts: {
  submittedAt: string | null
  stagesDone: number
  loggedMinutes: number
}): AssignmentStatus {
  if (opts.submittedAt) return 'submitted'
  return opts.stagesDone > 0 || opts.loggedMinutes > 0 ? 'in-progress' : 'not-started'
}
