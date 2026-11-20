import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { PROFILES, type ProfileName } from '../shared/types'

// Each profile has its own directory, so demo and real data can never share a file:
//   <userData>/profiles/demo/app.db     <userData>/profiles/demo/records/
//   <userData>/profiles/real/app.db     <userData>/profiles/real/records/
// plus files/ (attachments) in each, and tot-demo.txt (the demo's fake Tot dot).
// The active profile is remembered in <userData>/profile.json (outside both).

export const APP_NAME = 'Engram'
/** The app's name before it was renamed (its data folder is moved across on first start). */
export const OLD_APP_NAME = 'Study Planner'

export interface ProfilePaths {
  name: ProfileName
  dir: string
  dbPath: string
  recordsDir: string
  /** Engram's copies of attached files (Phase 8). */
  filesDir: string
  /** The demo's stand-in for Tot's UNI dot (Phase 8); unused by the real profile. */
  totDemoFile: string
  /** The demo's stand-in for Google Calendar (Phase 9); unused by the real profile. */
  googleDemoFile: string
}

/**
 * `npm run dev`'s data folder. The installed app keeps ~/Library/Application Support/Engram; dev
 * has its own, so the two never share a database or run syncs and backups twice (docs/ORIGINAL-SPEC.md §9).
 */
export const DEV_DATA_FOLDER = 'Engram Dev'

/** The installed app's data folder on macOS (Electron's userData). */
export function defaultUserDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', APP_NAME)
}

/** `npm run dev`'s data folder, for CLI scripts that run without the Electron app module. */
export function devUserDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', DEV_DATA_FOLDER)
}

export function profilePaths(userDataDir: string, name: ProfileName): ProfilePaths {
  const dir = join(userDataDir, 'profiles', name)
  return {
    name,
    dir,
    dbPath: join(dir, 'app.db'),
    recordsDir: join(dir, 'records'),
    filesDir: join(dir, 'files'),
    totDemoFile: join(dir, 'tot-demo.txt'),
    googleDemoFile: join(dir, 'google-calendar-demo.json')
  }
}

export function ensureProfileDirs(paths: ProfilePaths): void {
  mkdirSync(paths.recordsDir, { recursive: true })
  mkdirSync(paths.filesDir, { recursive: true })
}

const profileFile = (userDataDir: string): string => join(userDataDir, 'profile.json')

/** The active profile; demo unless the user has switched (in the setup wizard, Phase 10). */
export function readActiveProfile(userDataDir: string): ProfileName {
  const file = profileFile(userDataDir)
  if (!existsSync(file)) return 'demo'
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { active?: unknown }
    return PROFILES.includes(parsed.active as ProfileName) ? (parsed.active as ProfileName) : 'demo'
  } catch {
    return 'demo'
  }
}

export function writeActiveProfile(userDataDir: string, name: ProfileName): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(profileFile(userDataDir), JSON.stringify({ active: name }, null, 2))
}

/** Throws unless `paths` is the demo profile. Guards every destructive demo-only action. */
export function assertDemo(paths: ProfilePaths): void {
  const demoSegment = `${sep}profiles${sep}demo`
  if (paths.name !== 'demo' || !paths.dir.endsWith(demoSegment)) {
    throw new Error(
      `Refusing to modify the "${paths.name}" profile: only demo data can be seeded or reset.`
    )
  }
}
