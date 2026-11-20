/**
 * What kind of teaching session a timetabled "lecture" really is. Some modules (Investigative
 * Methods) put workshops, practicals and support sessions in the feed as [Lecture], so only
 * their names tell them apart. Engram guesses from the name and the user confirms.
 */

export const SESSION_KINDS = ['lecture', 'workshop', 'practical', 'other'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

export const KIND_NAME: Record<SessionKind, string> = {
  lecture: 'Lecture',
  workshop: 'Workshop',
  practical: 'Practical',
  other: 'Other session'
}

/** Label prefix per kind ("L3", "WS1", "P2"); other sessions have no number. */
const PREFIX: Record<SessionKind, string> = {
  lecture: 'L',
  workshop: 'WS',
  practical: 'P',
  other: ''
}

const WORKSHOP = /\bWS\s*\d+\b|\bworkshops?\b/i
const PRACTICAL = /\bprac(?:s|tical|ticals)?\b/i
const OTHER =
  /\bsupport\b|\bq\s*&\s*a\b|\brevision\b|\bLVs?\b|\bpresentations?\b|\bdrop[- ]?in\b|\boffice hours\b/i

/** A session's kind from its name: "Ephys WS1" → workshop, "Parkinsons Prac" → practical. */
export function guessKind(name: string | null | undefined): SessionKind {
  const s = name?.trim() ?? ''
  if (!s) return 'lecture'
  if (WORKSHOP.test(s)) return 'workshop'
  if (PRACTICAL.test(s)) return 'practical'
  if (OTHER.test(s)) return 'other'
  return 'lecture'
}

/** The kind the user set, or else the guess from the name. */
export function kindOf(stored: SessionKind | null, name: string | null | undefined): SessionKind {
  return stored ?? guessKind(name)
}

/**
 * Labels for a module's sessions, numbered per kind in time order: L1, L2…, WS1, WS2…, P1…
 * Other sessions get "". A later session of a lecture across several days (`rootId`) shares
 * its first session's label and isn't counted.
 */
export function sessionLabels(
  sessions: { id: string; start: string; kind: SessionKind; rootId?: string | null }[]
): Map<string, string> {
  const labels = new Map<string, string>()
  const count: Record<SessionKind, number> = { lecture: 0, workshop: 0, practical: 0, other: 0 }
  const sorted = [...sessions].sort((a, b) => a.start.localeCompare(b.start))
  for (const s of sorted) {
    if (s.rootId && s.rootId !== s.id) continue
    labels.set(s.id, s.kind === 'other' ? '' : `${PREFIX[s.kind]}${++count[s.kind]}`)
  }
  for (const s of sorted) {
    if (s.rootId && s.rootId !== s.id) labels.set(s.id, labels.get(s.rootId) ?? '')
  }
  return labels
}

/**
 * A session as the calendar's second line shows it: "WS1. Ephys WS1", "L12" with no name
 * yet, or just the name for an other session; a later session adds "(part 2)".
 */
export function sessionLine(label: string, title: string | null, part = 1): string {
  const name = title?.trim() ?? ''
  const suffix = part > 1 ? ` (part ${part})` : ''
  if (!label) return `${name || 'Session'}${suffix}`
  const n = `${label}${suffix}`
  return name ? `${n}. ${name}` : n
}
