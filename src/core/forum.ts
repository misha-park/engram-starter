// Moodle forum notifications: which posts in a module's forums are worth telling the student
// about. Most posts are students asking about lectures; only course staff's announcements
// matter (cancelled or moved lectures, room changes, assignments released, deadline changes,
// extensions). Filtering is layered, cheapest and most deterministic first:
//   1. posts in a course's Announcements (news) forum always count;
//   2. elsewhere, only posts by course staff are looked at (students' never are);
//   3. a staff reply with no hint of a change just answers a question, so it doesn't count;
//      other staff posts are classified by Claude (or, without Claude, by the hints).

export type ForumPostKind = 'announcement' | 'staff' | 'other'

/** What happens to a new post: notify, drop, or let Claude decide. */
export type Triage = 'important' | 'not-important' | 'classify'

/** Words that suggest a post changes something for the student. */
const HINTS: [label: string, pattern: RegExp][] = [
  ['cancelled', /\bcancel(?:l?ed|lation|ling)?\b|\bcalled off\b/i],
  ['no lecture', /\bno (?:lecture|class|seminar|workshop|practical|session)s?\b/i],
  [
    'won’t take place',
    /\b(?:not|won[’']t) (?:be )?tak(?:e|ing) place\b|\bwon[’']t (?:be )?(?:running|happening)\b/i
  ],
  ['postponed', /\bpostpone[ds]?\b|\breschedul(?:e|ed|ing)\b|\bdelayed\b/i],
  ['moved', /\bmoved\b|\bmoving (?:to|online)\b|\bnew (?:time|date|location|venue|room)\b/i],
  ['room', /\broom\b|\bvenue\b|\blecture theatre\b|\blocation\b/i],
  ['online', /\b(?:on teams|on zoom|online only|now online)\b/i],
  [
    'released',
    /\breleased?\b|\bnow (?:available|open|live|up)\b|\bhas been (?:published|posted|uploaded)\b/i
  ],
  ['deadline', /\bdeadlines?\b|\bdue (?:date|on|by)\b|\bsubmission date\b|\bhand-?in\b/i],
  ['extension', /\bextensions?\b|\bextended\b/i],
  ['exam', /\bexam(?:ination)?s?\b|\bassessment (?:date|time|arrangements?)\b/i]
]

/** The hints found in a post's subject and text (labels, each once). */
export function forumHints(text: string): string[] {
  return HINTS.filter(([, re]) => re.test(text)).map(([label]) => label)
}

/** Moodle role shortnames that aren't staff (anything else on a course is). */
const NOT_STAFF = /student|guest|^user$|auditor|observer|frontpage/i

export function isStaffRole(shortnames: string[]): boolean {
  return shortnames.some((r) => !NOT_STAFF.test(r))
}

export function postKind(
  forumType: string,
  authorId: number,
  staff: ReadonlySet<number>
): ForumPostKind {
  if (forumType === 'news') return 'announcement'
  return staff.has(authorId) ? 'staff' : 'other'
}

export function triage(post: { kind: ForumPostKind; isReply: boolean; hints: string[] }): Triage {
  if (post.kind === 'announcement') return 'important'
  if (post.kind === 'other') return 'not-important'
  if (post.isReply && post.hints.length === 0) return 'not-important'
  return 'classify'
}

/**
 * Without Claude: a staff post counts when it starts a discussion and hints at a change.
 * Replies don't (most are answers, even when they mention a room or a deadline).
 */
export function fallbackImportant(post: { isReply: boolean; hints: string[] }): boolean {
  return !post.isReply && post.hints.length > 0
}

/**
 * A post is new when Engram hasn't kept it yet and it was written after the forum was first
 * synced: the first sync only notes what's there, so old posts never notify.
 */
export function isNewPost(
  post: { id: number; created: number },
  baseline: number,
  seen: ReadonlySet<number>
): boolean {
  return !seen.has(post.id) && post.created > baseline
}

/**
 * Discussions to read posts from: those changed since the forum was last read. Moodle lists
 * the latest first, with pinned discussions at the top whatever their age, so an old pinned
 * one is skipped rather than ending the list. `more` says whether older pages may still hold
 * changes.
 */
export function changedDiscussions<T extends { timemodified: number; pinned?: boolean }>(
  page: T[],
  seenUntil: number
): { changed: T[]; more: boolean } {
  const changed: T[] = []
  for (const d of page) {
    if (d.timemodified > seenUntil) changed.push(d)
    else if (!d.pinned) return { changed, more: false }
  }
  return { changed, more: page.length > 0 }
}

const stripRe = (s: string) => s.replace(/^\s*(?:re|fwd?)\s*:\s*/i, '').trim()

/**
 * A one-line notification title: Claude's when it gave a usable one, else the post's subject
 * (without "Re:"). At most 90 characters, on one line.
 */
export function forumTitle(claudeTitle: unknown, subject: string): string {
  const pick =
    typeof claudeTitle === 'string' && claudeTitle.trim() ? claudeTitle : stripRe(subject)
  const line = pick.replace(/\s+/g, ' ').trim() || 'Post on Moodle'
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line
}
