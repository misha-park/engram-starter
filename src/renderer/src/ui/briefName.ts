/** A name for a typed brief: its first line, shortened ("Coursework 2: lab report (brief)"). */
export function briefName(text: string, fallback = 'Brief'): string {
  const first = text.trim().split('\n')[0]?.trim() ?? ''
  const short = first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}…` : first
  return short ? `${short} (brief)` : fallback
}
