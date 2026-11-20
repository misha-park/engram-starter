import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { Temporal } from 'temporal-polyfill'
import { teachingWeek, yearLabel } from '../../core/moodle'
import { TZ } from '../../core/time'
import { callMoodle, type MoodleAuth } from './auth'

// Where Moodle downloads come from: UCL Moodle through the app key, or (demo) a fixture.

export interface MoodleCourse {
  id: number
  shortname: string
  fullname: string
}

export interface MoodleFile {
  filename: string
  filepath: string
  fileurl: string
  filesize: number
  timemodified: number
}

export interface MoodleModule {
  /** The course module id (stable per item on the course page). */
  id: number
  /** The activity's own id (e.g. the assignment's), for activity-specific calls. */
  instance: number
  modname: string
  name: string
  description?: string
  contents?: (MoodleFile & { type: string })[]
}

export interface MoodleSection {
  name: string
  modules: MoodleModule[]
}

/** A course's forum. Type 'news' is its Announcements forum. */
export interface MoodleForum {
  id: number
  course: number
  type: string
  name: string
}

export interface MoodleDiscussion {
  /** The discussion's id (what its posts are listed by). */
  discussion: number
  name: string
  /** Its latest activity (seconds). */
  timemodified: number
  pinned?: boolean
}

export interface MoodlePost {
  id: number
  subject: string
  /** HTML. */
  message: string
  author: { id: number; fullname: string }
  parentid: number | null
  timecreated: number
  isdeleted?: boolean
  urls?: { view?: string }
}

export interface MoodleSource {
  courses(): Promise<MoodleCourse[]>
  contents(courseId: number): Promise<MoodleSection[]>
  /** An assignment's attached brief files. */
  briefFiles(assignInstance: number): Promise<MoodleFile[]>
  download(file: MoodleFile): Promise<Buffer>
  /** The forums of these courses. */
  forums(courseIds: number[]): Promise<MoodleForum[]>
  /** One page of a forum's discussions, latest activity first (pinned ones on top). */
  discussions(forumId: number, page: number): Promise<MoodleDiscussion[]>
  posts(discussionId: number): Promise<MoodlePost[]>
  /** Each course's contacts (its staff as shown on the course page): user ids by course. */
  contacts(courseIds: number[]): Promise<Map<number, number[]>>
  /** The role shortnames of these users on a course (for authors who aren't contacts). */
  roles(courseId: number, userIds: number[]): Promise<Map<number, string[]>>
}

export const DISCUSSIONS_PER_PAGE = 25

export class RealMoodle implements MoodleSource {
  constructor(
    private readonly auth: MoodleAuth,
    private readonly http: typeof fetch = fetch
  ) {}

  private async creds() {
    const c = await this.auth.credentials()
    if (!c) throw new Error('Moodle isn’t connected.')
    return c
  }

  async courses(): Promise<MoodleCourse[]> {
    const c = await this.creds()
    const userid = c.userId ?? (await this.auth.siteInfo(c)).userid
    const list = await callMoodle<MoodleCourse[]>(
      c,
      'core_enrol_get_users_courses',
      { userid },
      this.http
    )
    return list.map(({ id, shortname, fullname }) => ({ id, shortname, fullname }))
  }

  async contents(courseId: number): Promise<MoodleSection[]> {
    return callMoodle<MoodleSection[]>(
      await this.creds(),
      'core_course_get_contents',
      { courseid: courseId },
      this.http
    )
  }

  async briefFiles(assignInstance: number): Promise<MoodleFile[]> {
    const status = await callMoodle<{
      assignmentdata?: { attachments?: { intro?: MoodleFile[] } }
    }>(
      await this.creds(),
      'mod_assign_get_submission_status',
      { assignid: assignInstance },
      this.http
    )
    return status.assignmentdata?.attachments?.intro ?? []
  }

  async forums(courseIds: number[]): Promise<MoodleForum[]> {
    if (!courseIds.length) return []
    const list = await callMoodle<MoodleForum[]>(
      await this.creds(),
      'mod_forum_get_forums_by_courses',
      Object.fromEntries(courseIds.map((id, i) => [`courseids[${i}]`, id])),
      this.http
    )
    return list.map(({ id, course, type, name }) => ({ id, course, type, name }))
  }

  async discussions(forumId: number, page: number): Promise<MoodleDiscussion[]> {
    const r = await callMoodle<{ discussions?: MoodleDiscussion[] }>(
      await this.creds(),
      'mod_forum_get_forum_discussions',
      // sortorder -1: Moodle's default, latest activity first.
      { forumid: forumId, sortorder: -1, page, perpage: DISCUSSIONS_PER_PAGE },
      this.http
    )
    return (r.discussions ?? []).map(({ discussion, name, timemodified, pinned }) => ({
      discussion,
      name,
      timemodified,
      pinned
    }))
  }

  async posts(discussionId: number): Promise<MoodlePost[]> {
    const r = await callMoodle<{ posts?: MoodlePost[] }>(
      await this.creds(),
      'mod_forum_get_discussion_posts',
      { discussionid: discussionId, sortby: 'created', sortdirection: 'ASC' },
      this.http
    )
    return r.posts ?? []
  }

  async contacts(courseIds: number[]): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>()
    if (!courseIds.length) return out
    const r = await callMoodle<{ courses?: { id: number; contacts?: { id: number }[] }[] }>(
      await this.creds(),
      'core_course_get_courses_by_field',
      { field: 'ids', value: courseIds.join(',') },
      this.http
    )
    for (const c of r.courses ?? [])
      out.set(
        c.id,
        (c.contacts ?? []).map((p) => p.id)
      )
    return out
  }

  /** Only the roles are kept from the profiles Moodle sends. */
  async roles(courseId: number, userIds: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>()
    if (!userIds.length) return out
    const args: Record<string, number> = {}
    userIds.forEach((id, i) => {
      args[`userlist[${i}][userid]`] = id
      args[`userlist[${i}][courseid]`] = courseId
    })
    const r = await callMoodle<{ id: number; roles?: { shortname: string }[] }[]>(
      await this.creds(),
      'core_user_get_course_user_profiles',
      args,
      this.http
    )
    for (const u of r ?? [])
      out.set(
        u.id,
        (u.roles ?? []).map((x) => x.shortname)
      )
    return out
  }

  /** The key goes in the request body, and only ever to Moodle's own address. */
  async download(file: MoodleFile): Promise<Buffer> {
    const c = await this.creds()
    const url = new URL(file.fileurl)
    if (url.origin !== new URL(c.site).origin) throw new Error('That file isn’t on Moodle.')
    url.searchParams.delete('token')
    let res: Response
    try {
      res = await this.http(url.toString(), {
        method: 'POST',
        body: new URLSearchParams({ token: c.token }),
        signal: AbortSignal.timeout(120_000)
      })
    } catch {
      throw new Error('Couldn’t reach Moodle. Check your internet connection.')
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || (type.includes('json') && buf.subarray(0, 1).toString() === '{')) {
      const text = buf.toString('utf8', 0, 300)
      throw new Error(
        /invalidtoken/.test(text)
          ? 'Moodle no longer accepts Engram’s key. Connect Moodle again.'
          : `Moodle didn’t send “${file.filename}” (${res.status}).`
      )
    }
    return buf
  }
}

/**
 * The demo's stand-in: a fixture of courses whose section weeks and year follow the current
 * date (so "Week N" lines up with the demo's lectures), with small sample files.
 */
export class FixtureMoodle implements MoodleSource {
  constructor(
    private readonly fixtureDir: string,
    private readonly now: () => Temporal.Instant
  ) {}

  private fixture(): {
    courses: (MoodleCourse & {
      contacts?: number[]
      roles?: Record<string, string[]>
      forums?: DemoForum[]
      sections: {
        name: string
        weekOffset?: number
        modules: (Omit<MoodleModule, 'contents'> & { files?: string[]; briefFiles?: string[] })[]
      }[]
    })[]
  } {
    const raw = readFileSync(join(this.fixtureDir, 'moodle-demo.json'), 'utf8')
    const today = this.now().toZonedDateTimeISO(TZ).toPlainDate()
    const year = yearLabel(today)
    const last = yearLabel(today.subtract({ years: 1 }))
    return JSON.parse(raw.replaceAll('{year}', year).replaceAll('{lastYear}', last))
  }

  private file(name: string): MoodleFile {
    const path = join(this.fixtureDir, 'moodle-demo', name)
    if (!existsSync(path)) throw new Error(`Missing demo file ${name}.`)
    return {
      filename: basename(name),
      filepath: '/',
      fileurl: `fixture://${name}`,
      filesize: readFileSync(path).length,
      timemodified: 1_790_000_000
    }
  }

  async courses(): Promise<MoodleCourse[]> {
    return this.fixture().courses.map(({ id, shortname, fullname }) => ({
      id,
      shortname,
      fullname
    }))
  }

  async contents(courseId: number): Promise<MoodleSection[]> {
    const course = this.fixture().courses.find((c) => c.id === courseId)
    if (!course) throw new Error('No such course.')
    const week = teachingWeek(this.now().toString())
    return course.sections.map((s) => ({
      name: s.weekOffset === undefined ? s.name : `Week ${week + s.weekOffset}: ${s.name}`,
      modules: s.modules.map(({ files, ...m }) => ({
        ...m,
        contents: (files ?? []).map((f) => ({ type: 'file', ...this.file(f) }))
      }))
    }))
  }

  async briefFiles(assignInstance: number): Promise<MoodleFile[]> {
    for (const c of this.fixture().courses)
      for (const s of c.sections)
        for (const m of s.modules)
          if (m.modname === 'assign' && m.instance === assignInstance)
            return (m.briefFiles ?? []).map((f) => this.file(f))
    return []
  }

  async download(file: MoodleFile): Promise<Buffer> {
    return readFileSync(
      join(this.fixtureDir, 'moodle-demo', file.fileurl.replace('fixture://', ''))
    )
  }

  private ago(hours: number): number {
    return Math.floor(this.now().epochMilliseconds / 1000) - Math.round(hours * 3600)
  }

  private allForums(): (DemoForum & { course: number })[] {
    return this.fixture().courses.flatMap((c) =>
      (c.forums ?? []).map((f) => ({ ...f, course: c.id }))
    )
  }

  async forums(courseIds: number[]): Promise<MoodleForum[]> {
    return this.allForums()
      .filter((f) => courseIds.includes(f.course))
      .map(({ id, course, type, name }) => ({ id, course, type, name }))
  }

  async discussions(forumId: number, page: number): Promise<MoodleDiscussion[]> {
    const forum = this.allForums().find((f) => f.id === forumId)
    if (!forum) throw new Error('No such forum.')
    return forum.discussions
      .map((d) => ({
        discussion: d.id,
        name: d.name,
        pinned: d.pinned,
        timemodified: Math.max(...d.posts.map((p) => this.ago(p.hoursAgo)))
      }))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.timemodified - a.timemodified)
      .slice(page * DISCUSSIONS_PER_PAGE, (page + 1) * DISCUSSIONS_PER_PAGE)
  }

  async posts(discussionId: number): Promise<MoodlePost[]> {
    for (const f of this.allForums()) {
      const d = f.discussions.find((x) => x.id === discussionId)
      if (!d) continue
      return d.posts.map((p) => ({
        id: p.id,
        subject: p.subject,
        message: p.message,
        author: { id: p.author, fullname: p.authorName },
        parentid: p.parent ?? null,
        timecreated: this.ago(p.hoursAgo),
        // Demo posts have no page on Moodle.
        urls: {}
      }))
    }
    throw new Error('No such discussion.')
  }

  async contacts(courseIds: number[]): Promise<Map<number, number[]>> {
    return new Map(
      this.fixture()
        .courses.filter((c) => courseIds.includes(c.id))
        .map((c) => [c.id, c.contacts ?? []])
    )
  }

  async roles(courseId: number, userIds: number[]): Promise<Map<number, string[]>> {
    const roles = this.fixture().courses.find((c) => c.id === courseId)?.roles ?? {}
    return new Map(userIds.map((id) => [id, roles[String(id)] ?? ['student']]))
  }
}

/** The fixture's forums: post times are hours before now. */
interface DemoForum {
  id: number
  type: string
  name: string
  discussions: {
    id: number
    name: string
    pinned?: boolean
    posts: {
      id: number
      parent?: number
      author: number
      authorName: string
      subject: string
      message: string
      hoursAgo: number
    }[]
  }[]
}
