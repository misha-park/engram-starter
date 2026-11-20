// Updates to the installed app (docs/ORIGINAL-SPEC.md §9). `npm run release` builds Engram and leaves the new
// app in <data folder>/updates/next/; the running app offers "Restart to update", and
// resources/update-swap.sh swaps it into place. The app before it is kept in updates/previous/
// for Roll back. Pure helpers only: the file work is in main/updates.ts and scripts/release.ts.

/** What a build was made from: written to out/build.json and packaged as Resources/build.json. */
export interface BuildInfo {
  /** package.json's version. */
  version: string
  /** The git commit it was built from. */
  commit: string
  /** Built with uncommitted changes in the repo. */
  dirty: boolean
  /** When it was built (UTC ISO). */
  builtAt: string
}

/** What `npm run release` leaves next to the new app (updates/next/notes.json). */
export interface UpdateNotes {
  /** The new build's commit subjects since the installed build, newest first. */
  changes: string[]
  /** More commits than listed. */
  more: number
}

/** Subfolders of <data folder>/updates. */
export const UPDATE_DIRS = {
  /** The staged update: Engram.app and notes.json. */
  next: 'next',
  /** The app the last update replaced (Roll back swaps it back in). */
  previous: 'previous',
  /** Where the release script assembles `next` before renaming it into place. */
  partial: 'next.partial'
} as const

/** Most changes listed with an update. */
export const MAX_NOTES = 30

/** A build.json's contents, or null when it isn't one. */
export function parseBuildInfo(text: string): BuildInfo | null {
  try {
    const v = JSON.parse(text) as Partial<BuildInfo>
    if (
      typeof v.version !== 'string' ||
      typeof v.commit !== 'string' ||
      typeof v.builtAt !== 'string'
    ) {
      return null
    }
    return { version: v.version, commit: v.commit, dirty: v.dirty === true, builtAt: v.builtAt }
  } catch {
    return null
  }
}

export function parseNotes(text: string): UpdateNotes {
  try {
    const v = JSON.parse(text) as Partial<UpdateNotes>
    const changes = Array.isArray(v.changes) ? v.changes.filter((c) => typeof c === 'string') : []
    return { changes, more: typeof v.more === 'number' ? v.more : 0 }
  } catch {
    return { changes: [], more: 0 }
  }
}

/** The same build (two builds of one commit differ by their build time). */
export function sameBuild(a: BuildInfo | null, b: BuildInfo | null): boolean {
  return !!a && !!b && a.commit === b.commit && a.builtAt === b.builtAt
}

/** Notes from `git log --format=%s` output (newest first), capped at MAX_NOTES. */
export function notesFromLog(log: string): UpdateNotes {
  const all = log
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { changes: all.slice(0, MAX_NOTES), more: Math.max(0, all.length - MAX_NOTES) }
}

/** "1.0.0 · a1b2c3d" (plus "+ uncommitted" for a dirty build). */
export function buildLabel(b: BuildInfo): string {
  return `${b.version} · ${b.commit.slice(0, 7)}${b.dirty ? ' + uncommitted changes' : ''}`
}

/**
 * The .app bundle an executable belongs to (`/Applications/Engram.app` for
 * `/Applications/Engram.app/Contents/MacOS/Engram`), or null when it isn't in one.
 */
export function bundleOf(exePath: string): string | null {
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath)
  return m ? m[1] : null
}
