import type { AssignmentType, AvailabilitySettings, CategoryKind } from '../../shared/types'

// Fictional demo content. Nothing here is real timetable or personal data.
// Phase 2 replaces the hand-written teaching pattern below with an import of a fake .ics fixture.

export interface DemoCategory {
  id: string
  kind: CategoryKind
  name: string
  shortLabel: string
  colour: string
  /** Module-only fields. Write-up minutes per hour of lecture. */
  writeUpMinutes?: number
  feedNames?: string[]
  assessmentNotes?: string
}

export const DEMO_CATEGORIES: DemoCategory[] = [
  {
    id: 'neur',
    kind: 'module',
    name: 'Cellular Neurophysiology',
    shortLabel: 'NEUR',
    colour: '#9373ff',
    writeUpMinutes: 60,
    feedNames: ['Cellular Neurophysiology'],
    assessmentNotes: 'Coursework essay 30%, unseen exam 70%.'
  },
  {
    id: 'phar',
    kind: 'module',
    name: 'Molecular Pharmacology',
    shortLabel: 'PHAR',
    colour: '#17c4ae',
    writeUpMinutes: 60,
    feedNames: ['Molecular Pharmacology'],
    assessmentNotes: 'Practical reports 40%, exam 60%.'
  },
  {
    id: 'phys',
    kind: 'module',
    name: 'Systems Physiology',
    shortLabel: 'PHYS',
    colour: '#f6a823',
    writeUpMinutes: 60,
    feedNames: ['Systems Physiology'],
    assessmentNotes: 'Data-analysis assignment 25%, exam 75%.'
  },
  {
    // Cross-listed: the same project module appears under three names in the feed.
    id: 'proj',
    kind: 'module',
    name: 'Research Project',
    shortLabel: 'PROJ',
    colour: '#f75482',
    writeUpMinutes: 60,
    feedNames: [
      'Neuroscience Research Project',
      'Pharmacology Research Project',
      'Physiology Research Project',
      'Neuroscience Research Project, Pharmacology Research Project, Physiology Research Project'
    ],
    assessmentNotes: 'Literature review dissertation and viva.'
  },
  { id: 'social', kind: 'social', name: 'Social', shortLabel: 'SOC', colour: '#3ec867' },
  { id: 'work', kind: 'work', name: 'Work', shortLabel: 'WORK', colour: '#7b93bd' }
]

// --- Fake timetable feed -----------------------------------------------------------------
// These become a UCL-format .ics (see demo-timetable.ts), which the seed imports through the
// real importer. Feed names, not module ids: mapping them to modules is part of what's tested.

/** A weekly timetabled event as it appears in the feed. */
export interface FeedSlot {
  weekday: number // ISO, 1 = Monday
  start: string
  end: string
  /** Every name the event is listed under (a cross-listed event appears once per name). */
  feedNames: string[]
  /** The bracketed type in SUMMARY. */
  feedType: string
  /** CATEGORIES value; the real feed sometimes says None even for real events. */
  categories?: string
}

export const FEED_LEVEL = 6

export const FEED_PATTERN: FeedSlot[] = [
  {
    weekday: 1,
    start: '10:00',
    end: '11:00',
    feedNames: ['Cellular Neurophysiology'],
    feedType: 'Lecture'
  },
  {
    weekday: 1,
    start: '14:00',
    end: '16:00',
    feedNames: ['Molecular Pharmacology'],
    feedType: 'Practical',
    categories: 'None'
  },
  {
    weekday: 2,
    start: '11:00',
    end: '12:00',
    feedNames: ['Systems Physiology'],
    feedType: 'Lecture'
  },
  {
    weekday: 2,
    start: '13:00',
    end: '14:00',
    feedNames: ['Cellular Neurophysiology'],
    feedType: 'Lecture'
  },
  {
    weekday: 2,
    start: '16:00',
    end: '17:00',
    feedNames: ['Statistics for Biosciences'],
    feedType: 'Workshop'
  },
  // Like the real feed: a 2-hour slot as one event, though some weeks it holds two different
  // lectures (split it on the module page, or from the module's lecture list).
  {
    weekday: 3,
    start: '10:00',
    end: '12:00',
    feedNames: ['Molecular Pharmacology'],
    feedType: 'Lecture'
  },
  {
    weekday: 3,
    start: '15:00',
    end: '17:00',
    feedNames: [
      'Neuroscience Research Project',
      'Pharmacology Research Project',
      'Physiology Research Project'
    ],
    feedType: 'Problem Based Learning'
  },
  {
    weekday: 4,
    start: '09:00',
    end: '11:00',
    feedNames: ['Systems Physiology'],
    feedType: 'Lecture'
  },
  {
    weekday: 4,
    start: '11:00',
    end: '13:00',
    feedNames: ['Cellular Neurophysiology'],
    feedType: 'Workshop'
  },
  {
    weekday: 4,
    start: '12:00',
    end: '12:30',
    feedNames: ['Personal Tutor Drop-in'],
    feedType: 'None',
    categories: 'None'
  },
  {
    weekday: 5,
    start: '10:00',
    end: '11:00',
    feedNames: ['Molecular Pharmacology'],
    feedType: 'Lecture'
  },
  {
    weekday: 5,
    start: '14:00',
    end: '15:00',
    feedNames: ['Systems Physiology'],
    feedType: 'Workshop'
  }
]

/** One-off feed events. `week` is relative to the current week. */
export const FEED_ONE_OFFS: (Omit<FeedSlot, 'weekday'> & { week: number; weekday: number })[] = [
  {
    week: 1,
    weekday: 2,
    start: '09:30',
    end: '10:30',
    feedNames: ['Systems Physiology'],
    feedType: 'Assessment'
  },
  // Like the real feed: cohort viva sessions as one long event listing every name.
  {
    week: 2,
    weekday: 5,
    start: '09:00',
    end: '16:00',
    feedNames: [
      'Neuroscience Research Project, Pharmacology Research Project, Physiology Research Project'
    ],
    feedType: 'Viva'
  },
  {
    week: 1,
    weekday: 3,
    start: '13:00',
    end: '14:00',
    feedNames: ['Molecular Pharmacology'],
    feedType: 'Presentation'
  }
]

/** A weekly fixed social commitment. */
export const SOCIAL_SLOT = { weekday: 3, start: '19:00', end: '21:00', title: 'Climbing' }

/** Recurring pub shift: Saturdays 17:00–00:00. */
export const PUB_SHIFT = {
  id: 'rec-pub-shift',
  title: 'Pub shift',
  weekday: 6,
  start: '17:00',
  end: '00:00'
}

/** Weeks of timetable the fake feed covers, relative to the current week (negative = past). */
export const TEACHING_WEEKS = { from: -3, to: 2 }
/** Weeks of pub-shift occurrences relative to the current week. */
export const PUB_SHIFT_WEEKS = { from: -3, to: 8 }

export const DEMO_SETTINGS: Record<string, unknown> = {
  timezone: 'Europe/London',
  weeklyTargetMinutes: 20 * 60,
  // 09:00–22:00, except Friday evenings (from 18:00) and a later start on Sundays.
  availability: {
    days: [
      { start: '09:00', end: '22:00' },
      { start: '09:00', end: '22:00' },
      { start: '09:00', end: '22:00' },
      { start: '09:00', end: '22:00' },
      { start: '09:00', end: '18:00' },
      { start: '09:00', end: '22:00' },
      { start: '10:00', end: '22:00' }
    ]
  } satisfies AvailabilitySettings
}

/** Todos; `due` is days relative to today (negative = overdue). */
export const DEMO_TODOS: {
  title: string
  due?: number
  done?: boolean
  categoryId?: string
  weeklyOn?: number
}[] = [
  { title: 'Email supervisor about project meeting', due: -1, categoryId: 'proj' },
  { title: 'Renew railcard', due: -5 },
  { title: 'Book a room for the PBL group', due: 1, categoryId: 'proj' },
  { title: 'Return library books', due: 3 },
  { title: 'Print PHAR practical handout', categoryId: 'phar' },
  { title: 'Check lab notebook is up to date', weeklyOn: 1 },
  { title: 'Buy lab coat', done: true }
]

/**
 * The demo's Tot dot, as Tot stores it (○ open, ● ticked). Two lines match seeded todos, one is
 * new (it becomes a todo on the first sync) and the ticked one is ignored.
 */
export const DEMO_TOT_DOT = [
  'UNI:',
  '○ Return library books',
  '○ Print PHAR practical handout',
  '● Buy lab coat',
  '○ Collect hoodie from the SU',
  ''
].join('\n')

/** A fictional brief, attached to the demo's NEUR essay. */
export const DEMO_ESSAY_BRIEF = `NEUR0017 Cellular Neurophysiology: Essay (30%)

Title: How does the diversity of voltage-gated ion channels shape neuronal firing?

Length: 2,500 words maximum, excluding references.
Submission: via Moodle by 12:00 on the due date shown in the module handbook.

What we are looking for
- A clear argument supported by primary literature (at least 8 research papers).
- Use of at least two worked examples of specific channel types.
- One original figure (a diagram you have drawn yourself).
- Harvard referencing.

Marking criteria: argument and structure 40%; use of evidence 30%; understanding 20%;
presentation and referencing 10%.
`

/**
 * A fictional brief for an assignment the demo doesn't have yet, saved in the demo profile's
 * sample-files folder to try dropping files and "Plan from brief".
 */
export const DEMO_SAMPLE_BRIEF = `PHAR0003 Pharmacology: Coursework 2, pharmacokinetics lab report (40%)

Write up the pharmacokinetics practical as a full lab report: introduction, methods, results
(including your clearance and half-life calculations and at least two graphs), discussion and
references. Maximum 2,000 words, excluding tables, figures and references.

Deadline: 12:00, three weeks after the practical session.
Submit as a single PDF on Moodle. Late work is capped at the pass mark.
`

/** Assignments at different stages. `dueInDays` is relative to today. */
export const DEMO_ASSIGNMENTS: {
  moduleId: string
  title: string
  type: AssignmentType
  dueInDays: number
  dueTime: string
  weighting: number
  wordLimit?: number
  estimateHours: number
  /** Stages already finished (from the start). */
  stagesDone: number
  submitted?: boolean
}[] = [
  {
    moduleId: 'neur',
    title: 'Ion channels essay',
    type: 'essay',
    dueInDays: 12,
    dueTime: '12:00',
    weighting: 30,
    wordLimit: 2500,
    estimateHours: 15,
    stagesDone: 1
  },
  {
    moduleId: 'phys',
    title: 'Data analysis assignment',
    type: 'problem-set',
    dueInDays: 5,
    dueTime: '17:00',
    weighting: 25,
    estimateHours: 8,
    stagesDone: 0
  },
  {
    moduleId: 'phar',
    title: 'Practical report 1',
    type: 'lab-report',
    dueInDays: -4,
    dueTime: '12:00',
    weighting: 20,
    wordLimit: 2000,
    estimateHours: 10,
    stagesDone: 4,
    submitted: true
  }
]
