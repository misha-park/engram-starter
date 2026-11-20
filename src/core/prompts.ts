import { formatClock, formatMinutes, zoned } from './time'

// Prompts the user copies into the Claude chat they revise with. The app never sends these
// anywhere itself; the user pastes the reply back.

/** Ask Claude (in the revision chat) for a short debrief of where the session got to. */
export function debriefPrompt(opts: {
  title: string
  categoryName?: string | null
  start: string
  end: string
  minutes?: number
}): string {
  const day = zoned(opts.start)
    .toPlainDate()
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const what = opts.categoryName ? `${opts.title} (${opts.categoryName})` : opts.title
  const worked = opts.minutes ? `, about ${formatMinutes(opts.minutes)} of work` : ''
  return [
    `I'm wrapping up this study session and only got part of the way through. Based on our conversation so far, write me a short debrief to paste into my study planner.`,
    '',
    `Session: ${what}, ${day} ${formatClock(opts.start)}–${formatClock(opts.end)}${worked}.`,
    '',
    'In plain text, with no headings or formatting, cover:',
    '- what we covered',
    "- what's left to do next time",
    '- anything worth remembering (gaps, things to check, open questions)',
    '',
    'Keep it under 120 words and only include things we actually discussed.'
  ].join('\n')
}

/** For a spaced-repetition review, in the user's existing Claude chat for that lecture. */
export function reviewPrompt(opts: {
  lectureTitle: string
  moduleName: string
  step: number
  steps: number
  lastRating: 'easy' | 'ok' | 'hard' | null
}): string {
  return [
    `Spaced-repetition review of ${opts.lectureTitle} (${opts.moduleName}), review ${opts.step} of ${opts.steps}.`,
    '',
    'Quiz me on this lecture from what we covered in this chat. Ask 5 short recall questions on the key points, one at a time, and wait for my answer before asking the next. Correct me briefly after each answer.',
    opts.lastRating === 'hard'
      ? 'I found the last review hard, so lean towards the points I got wrong or was unsure about before.'
      : '',
    'After the last question, tell me in two lines which points I was shaky on.'
  ]
    .filter((l, i, all) => l || all[i - 1])
    .join('\n')
}

/** For a review across a whole module, in that module's Claude project. */
export function moduleReviewPrompt(opts: {
  moduleName: string
  hardLectures: string[]
  lectureCount: number
}): string {
  const focus = opts.hardLectures.length
    ? `Focus on the lectures I rated hard in my reviews: ${opts.hardLectures.join(', ')}. Bring in the others where they connect.`
    : 'Spread the questions across the lectures.'
  return [
    `Review across ${opts.moduleName} (${opts.lectureCount} lectures so far).`,
    '',
    `Quiz me with 10 recall questions that link ideas across the lectures in this project, one at a time, waiting for my answer each time and correcting me briefly. ${focus}`,
    '',
    'At the end, list in a few lines the topics I should go back to.'
  ].join('\n')
}
