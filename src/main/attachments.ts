import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { ATTACHMENT_TARGETS, type Attachment, type AttachmentRef } from '../shared/types'
import { formatClock, zoned } from '../core/time'
import type { Db, DbOrTx } from './db/client'
import * as t from './db/schema'
import { isReadableDocument, readDocument } from './documents'
import { ensureWhite, queueWhiten } from './pdf-background'

// Files attached to an item (Phase 8). Engram copies each file into the profile's `files/`
// folder (named by id, keeping the extension) and leaves the original where it was. A file
// dropped in a chat starts unfiled (no target); Claude or the user then attaches it.

const MAX_BYTES = 100 * 1024 * 1024
const DISSERTATION_ID = 'main'

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.rtf': 'application/rtf',
  '.pages': 'application/vnd.apple.pages',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.gif': 'image/gif'
}

/** What an item is called, for lists and for Claude. Null when it doesn't exist. */
export function targetLabel(db: DbOrTx, ref: AttachmentRef): string | null {
  switch (ref.type) {
    case 'assignment': {
      const a = db.select().from(t.assignments).where(eq(t.assignments.id, ref.id)).get()
      return a ? a.title : null
    }
    case 'module': {
      const c = db.select().from(t.categories).where(eq(t.categories.id, ref.id)).get()
      const m = db.select().from(t.modules).where(eq(t.modules.id, ref.id)).get()
      return c && m ? `${c.shortLabel} · ${c.name}` : null
    }
    case 'dissertation': {
      const d = db.select().from(t.dissertation).where(eq(t.dissertation.id, ref.id)).get()
      return d ? 'Dissertation' : null
    }
    case 'dissertation-section': {
      const s = db.select().from(t.dissSections).where(eq(t.dissSections.id, ref.id)).get()
      return s ? `Dissertation: ${s.title}` : null
    }
    case 'meeting': {
      const m = db.select().from(t.meetings).where(eq(t.meetings.id, ref.id)).get()
      if (!m) return null
      const date = zoned(m.at)
        .toPlainDate()
        .toLocaleString('en-GB', { day: 'numeric', month: 'short' })
      return `Supervisor meeting, ${date} ${formatClock(m.at)}`
    }
  }
}

function checkTarget(db: DbOrTx, ref: AttachmentRef | null): void {
  if (!ref) return
  if (!ATTACHMENT_TARGETS.includes(ref.type) || typeof ref.id !== 'string') {
    throw new Error('Unknown item to attach to.')
  }
  if (targetLabel(db, ref) === null) throw new Error('That item no longer exists.')
}

type Row = typeof t.attachments.$inferSelect

function toAttachment(db: DbOrTx, r: Row): Attachment {
  const ref = r.targetType && r.targetId ? { type: r.targetType, id: r.targetId } : null
  const label = ref ? targetLabel(db, ref) : null
  // An item that has since been deleted leaves its files unfiled.
  const target = label === null ? null : ref
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    target,
    targetLabel: label,
    addedBy: r.addedBy,
    createdAt: r.createdAt,
    readable: isReadableDocument(r.storedName)
  }
}

export function getAttachment(db: DbOrTx, id: string): Attachment | null {
  const r = db.select().from(t.attachments).where(eq(t.attachments.id, id)).get()
  return r ? toAttachment(db, r) : null
}

export function getAttachments(db: DbOrTx, ids: string[]): Attachment[] {
  if (!ids.length) return []
  const rows = db.select().from(t.attachments).where(inArray(t.attachments.id, ids)).all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id) => (byId.has(id) ? [toAttachment(db, byId.get(id)!)] : []))
}

/** Copy files into the profile and record them, attached to `target` (or unfiled). */
export function addFiles(
  db: Db,
  filesDir: string,
  paths: string[],
  target: AttachmentRef | null,
  addedBy: 'user' | 'claude' = 'user'
): Attachment[] {
  checkTarget(db, target)
  mkdirSync(filesDir, { recursive: true })
  const added: Attachment[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || !existsSync(path)) throw new Error('That file can’t be found.')
    const stat = statSync(path)
    if (!stat.isFile())
      throw new Error(`“${basename(path)}” is a folder: drop the files inside it.`)
    if (stat.size > MAX_BYTES) throw new Error(`“${basename(path)}” is larger than 100 MB.`)
    const id = randomUUID()
    const ext = extname(path).toLowerCase().slice(0, 12)
    const storedName = `${id}${ext}`
    copyFileSync(path, join(filesDir, storedName))
    // A PDF gets its white page baked in, in the background (see pdf-background.ts).
    void queueWhiten(join(filesDir, storedName))
    db.insert(t.attachments)
      .values({
        id,
        name: basename(path),
        storedName,
        mime: MIME[ext] ?? 'application/octet-stream',
        size: stat.size,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        addedBy
      })
      .run()
    added.push(getAttachment(db, id)!)
  }
  return added
}

/**
 * Text typed or pasted in (e.g. a brief copied from Moodle), kept as a `.txt` file so it works
 * like any dropped file: Plan from brief, Summarise brief and Claude can all read it.
 */
export function addText(
  db: Db,
  filesDir: string,
  name: string,
  text: string,
  target: AttachmentRef | null,
  addedBy: 'user' | 'claude' = 'user'
): Attachment {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('Type or paste the brief first.')
  if (body.length > 200_000) throw new Error('That’s too long to keep as text: add it as a file.')
  checkTarget(db, target)
  mkdirSync(filesDir, { recursive: true })
  const clean =
    String(name ?? '')
      .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Brief'
  const id = randomUUID()
  const storedName = `${id}.txt`
  writeFileSync(join(filesDir, storedName), body + '\n', 'utf8')
  db.insert(t.attachments)
    .values({
      id,
      name: clean.toLowerCase().endsWith('.txt') ? clean : `${clean}.txt`,
      storedName,
      mime: 'text/plain',
      size: Buffer.byteLength(body + '\n'),
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      addedBy
    })
    .run()
  return getAttachment(db, id)!
}

/** An item's files, newest first. */
export function listAttachments(db: Db, target: AttachmentRef): Attachment[] {
  return db
    .select()
    .from(t.attachments)
    .where(and(eq(t.attachments.targetType, target.type), eq(t.attachments.targetId, target.id)))
    .orderBy(desc(t.attachments.createdAt))
    .all()
    .map((r) => toAttachment(db, r))
}

/** Everything for the dissertation: its own files, its sections' and its meetings'. */
export function listDissertationFiles(db: Db): Attachment[] {
  return db
    .select()
    .from(t.attachments)
    .where(
      or(
        and(
          eq(t.attachments.targetType, 'dissertation'),
          eq(t.attachments.targetId, DISSERTATION_ID)
        ),
        inArray(t.attachments.targetType, ['dissertation-section', 'meeting'])
      )
    )
    .orderBy(desc(t.attachments.createdAt))
    .all()
    .map((r) => toAttachment(db, r))
}

/** Every file, or only unfiled ones (for Claude). */
export function listAll(db: Db, unfiledOnly = false): Attachment[] {
  return db
    .select()
    .from(t.attachments)
    .where(unfiledOnly ? isNull(t.attachments.targetType) : undefined)
    .orderBy(desc(t.attachments.createdAt))
    .all()
    .map((r) => toAttachment(db, r))
}

export function setTarget(db: Db, id: string, target: AttachmentRef | null): Attachment {
  if (!getAttachment(db, id)) throw new Error('File not found.')
  checkTarget(db, target)
  db.update(t.attachments)
    .set({ targetType: target?.type ?? null, targetId: target?.id ?? null })
    .where(eq(t.attachments.id, id))
    .run()
  return getAttachment(db, id)!
}

export function renameAttachment(db: Db, id: string, name: string): void {
  const clean = name
    .replace(/[/\\:]/g, '-')
    .trim()
    .slice(0, 200)
  if (!clean) throw new Error('A file needs a name.')
  const row = db.select().from(t.attachments).where(eq(t.attachments.id, id)).get()
  if (!row) throw new Error('File not found.')
  // Keep the extension so the file still opens in the right app.
  const ext = extname(row.name)
  const named = ext && !clean.toLowerCase().endsWith(ext.toLowerCase()) ? `${clean}${ext}` : clean
  db.update(t.attachments).set({ name: named }).where(eq(t.attachments.id, id)).run()
}

/** Delete Engram's copy (the original, wherever it was, is untouched). */
export function removeAttachment(db: Db, filesDir: string, id: string): void {
  const row = db.select().from(t.attachments).where(eq(t.attachments.id, id)).get()
  if (!row) return
  db.delete(t.attachments).where(eq(t.attachments.id, id)).run()
  rmSync(join(filesDir, row.storedName), { force: true })
}

/**
 * Copy a file to a folder (the user's Downloads) under its own name, adding " (2)", " (3)"…
 * rather than overwriting anything there. Returns the copy's path.
 */
export function saveCopyTo(db: Db, filesDir: string, id: string, folder: string): string {
  const source = attachmentPath(db, filesDir, id)
  const row = getAttachment(db, id)!
  const ext = extname(source)
  let name = basename(row.name.replace(/[/:]/g, '-')).trim() || 'file'
  if (ext && extname(name).toLowerCase() !== ext.toLowerCase()) name += ext
  const stem = name.slice(0, name.length - extname(name).length)
  let target = join(folder, name)
  for (let n = 2; existsSync(target); n++) target = join(folder, `${stem} (${n})${extname(name)}`)
  mkdirSync(folder, { recursive: true })
  copyFileSync(source, target)
  return target
}

export function attachmentPath(db: Db, filesDir: string, id: string): string {
  const row = db.select().from(t.attachments).where(eq(t.attachments.id, id)).get()
  if (!row) throw new Error('File not found.')
  const path = join(filesDir, row.storedName)
  if (!existsSync(path)) throw new Error('Engram’s copy of this file is missing.')
  return path
}

/**
 * The stored file, once it's ready to hand on (a PDF has its white background by then). Use
 * this, not `attachmentPath`, for anything that gives the file to the user or another app.
 */
export async function readyAttachmentPath(db: Db, filesDir: string, id: string): Promise<string> {
  const path = attachmentPath(db, filesDir, id)
  await ensureWhite(path)
  return path
}

/** Whiten every PDF already stored (once each; the ones done are skipped quickly). */
export async function whitenStoredPdfs(db: Db, filesDir: string): Promise<void> {
  for (const row of db.select().from(t.attachments).all()) {
    if (!row.storedName.toLowerCase().endsWith('.pdf')) continue
    const path = join(filesDir, row.storedName)
    if (existsSync(path)) await queueWhiten(path)
  }
}

/** A file's text, for Claude (organisation only) and for planning from a brief. */
export async function readAttachmentText(
  db: Db,
  filesDir: string,
  id: string,
  maxChars = 60_000
): Promise<string> {
  const row = db.select().from(t.attachments).where(eq(t.attachments.id, id)).get()
  if (!row) throw new Error('File not found.')
  if (!isReadableDocument(row.storedName)) {
    throw new Error(
      `Text can’t be read from “${row.name}” (only Word, PDF, RTF, Pages or text files).`
    )
  }
  return readDocument(attachmentPath(db, filesDir, id), maxChars)
}

export { DISSERTATION_ID }
