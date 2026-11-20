import { createHash, randomBytes } from 'crypto'
import type { EncryptedJson } from '../secrets'

// Moodle sign-in (UCL). UCL doesn't show the app key in Moodle's Security keys page, so Engram
// signs in the way the Moodle app does: Moodle's "launch" page, after the university's own
// sign-in, hands a key to the app through a moodlemobile://token=… link. Engram shows that page
// in a small window of its own (the user signs in there; Engram never sees the password),
// catches the link, checks it belongs to this sign-in, and keeps the key encrypted.
//
// The key is a personal key: never in the database, settings, logs or error messages. Web
// service calls send it in the POST body, not the URL.

export const MOODLE_SITE = 'https://moodle.ucl.ac.uk'
export const APP_SCHEME = 'moodlemobile'
const SERVICE = 'moodle_mobile_app'

export interface MoodleCredentials {
  site: string
  token: string
  privateToken?: string
  userId?: number
}

/** A new sign-in: the page to open and the passport that ties the returned key to it. */
export function launchUrl(site = MOODLE_SITE): { url: string; passport: string } {
  const passport = randomBytes(12).toString('hex')
  const q = new URLSearchParams({ service: SERVICE, passport, urlscheme: APP_SCHEME })
  return { url: `${site}/admin/tool/mobile/launch.php?${q}`, passport }
}

/**
 * The key from Moodle's moodlemobile://token=<base64> link. The decoded value is
 * "signature:::token[:::privatetoken]", where the signature is md5(site URL + passport): it
 * proves the key came back for this sign-in. Returns null for anything else.
 */
export function parseLaunchToken(
  link: string,
  site: string,
  passport: string
): Pick<MoodleCredentials, 'token' | 'privateToken'> | null {
  const m = /^moodlemobile:\/\/token=([A-Za-z0-9+/=_-]+)/.exec(link.trim())
  if (!m) return null
  const decoded = Buffer.from(m[1], 'base64').toString('utf8')
  const [signature, token, privateToken] = decoded.split(':::')
  if (!signature || !token || !/^[a-f0-9]{32}$/i.test(token)) return null
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')
  const bases = [site, site.replace(/\/$/, ''), `${site.replace(/\/$/, '')}/`]
  if (!bases.some((b) => md5(b + passport) === signature.toLowerCase())) return null
  return { token, privateToken: privateToken || undefined }
}

export interface SiteInfo {
  sitename: string
  userid: number
  functions: string[]
}

/**
 * Functions the sync needs: course list, course contents, assignment briefs, and forum
 * notifications (forums, discussions, posts, course contacts, and an author's course roles).
 * All checked against UCL Moodle with the Moodle app's key.
 */
export const NEEDED_FUNCTIONS = [
  'core_enrol_get_users_courses',
  'core_course_get_contents',
  'mod_assign_get_assignments',
  'mod_forum_get_forums_by_courses',
  'mod_forum_get_forum_discussions',
  'mod_forum_get_discussion_posts',
  'core_course_get_courses_by_field',
  'core_user_get_course_user_profiles'
]

/** Call a Moodle web service function. The key goes in the POST body. Errors never contain it. */
export async function callMoodle<T>(
  creds: Pick<MoodleCredentials, 'site' | 'token'>,
  fn: string,
  args: Record<string, string | number> = {},
  http: typeof fetch = fetch
): Promise<T> {
  const body = new URLSearchParams({
    wstoken: creds.token,
    wsfunction: fn,
    moodlewsrestformat: 'json',
    ...Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))
  })
  let res: Response
  try {
    res = await http(`${creds.site}/webservice/rest/server.php`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    throw new Error('Couldn’t reach Moodle. Check your internet connection.')
  }
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(
      /Just a moment|cloudflare/i.test(text)
        ? 'Moodle’s bot check blocked the request.'
        : `Moodle answered with something unexpected (${res.status}).`
    )
  }
  const err = data as { exception?: string; errorcode?: string; message?: string }
  if (err && typeof err === 'object' && err.exception) {
    if (err.errorcode === 'invalidtoken' || err.errorcode === 'accessexception') {
      throw new Error('Moodle no longer accepts Engram’s key. Connect Moodle again.')
    }
    throw new Error(`Moodle: ${err.message ?? err.errorcode ?? 'error'}`)
  }
  return data as T
}

export interface MoodleAuthDeps {
  store: EncryptedJson<MoodleCredentials>
  /** Opens the sign-in window and resolves with the moodlemobile:// link (or rejects). */
  openSignInWindow(url: string): Promise<string>
  fetch?: typeof fetch
}

export class MoodleAuth {
  constructor(private readonly deps: MoodleAuthDeps) {}

  connected(): boolean {
    return this.deps.store.has()
  }

  credentials(): Promise<MoodleCredentials | null> {
    return this.deps.store.get()
  }

  /** Sign in through Moodle's launch page; checks the key works before keeping it. */
  async signIn(site = MOODLE_SITE): Promise<SiteInfo> {
    const { url, passport } = launchUrl(site)
    const link = await this.deps.openSignInWindow(url)
    const parsed = parseLaunchToken(link, site, passport)
    if (!parsed) throw new Error('Moodle’s answer didn’t match this sign-in, so it wasn’t used.')
    const creds: MoodleCredentials = { site, ...parsed }
    const info = await this.siteInfo(creds)
    await this.deps.store.set({ ...creds, userId: info.userid })
    return info
  }

  async siteInfo(creds?: MoodleCredentials): Promise<SiteInfo> {
    const c = creds ?? (await this.credentials())
    if (!c) throw new Error('Moodle isn’t connected.')
    const info = await callMoodle<{
      sitename: string
      userid: number
      functions?: { name: string }[]
    }>(c, 'core_webservice_get_site_info', {}, this.deps.fetch)
    return {
      sitename: info.sitename,
      userid: info.userid,
      functions: (info.functions ?? []).map((f) => f.name)
    }
  }

  signOut(): void {
    this.deps.store.clear()
  }
}
