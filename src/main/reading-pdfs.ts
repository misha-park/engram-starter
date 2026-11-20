import { copyFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import type { Db } from './db/client'
import * as t from './db/schema'
import { whitenPdf } from './pdf-background'
import type { ReadingSource } from './zotero'

// A paper's PDF, pulled from Zotero so it can be dragged out of the Reading tab into GoodNotes,
// Finder, a shelf app. Zotero's own file is only ever read: Engram works on a copy, named after
// the paper ("Smith et al. (2020) Title.pdf") instead of Zotero's file name, with the white page
// baked in (pdf-background.ts). The copies live in the temp folder and are made again as needed.

/** A file name from the paper's authors, year and title: safe on disk, not too long. */
export function paperFileName(item: {
  creators: string
  year: string | null
  title: string
}): string {
  const head = [item.creators, item.year ? `(${item.year})` : ''].filter(Boolean).join(' ')
  const name = `${head} ${item.title}`
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return `${name || 'Paper'}.pdf`
}

export class ReadingPdfs {
  /** Copies in progress, so hovering and then dragging share one piece of work. */
  private readonly running = new Map<string, Promise<string | null>>()
  /** What each copy was made from, so an unchanged PDF isn't copied again. */
  private readonly made = new Map<string, { source: string; mtimeMs: number; path: string }>()

  constructor(
    private readonly source: () => ReadingSource,
    private readonly folder: () => string,
    private readonly db: () => Db
  ) {}

  /** The ready copy of the paper's PDF, or null when Zotero has none for it. */
  prepare(id: string): Promise<string | null> {
    const running = this.running.get(id)
    if (running) return running
    const job = this.make(id).finally(() => this.running.delete(id))
    this.running.set(id, job)
    return job
  }

  private async make(id: string): Promise<string | null> {
    const item = this.db().select().from(t.readingItems).where(eq(t.readingItems.id, id)).get()
    if (!item) throw new Error('Reading item not found.')
    const source = await this.source().pdfFile(id)
    if (!source) return null
    const { mtimeMs } = statSync(source)
    const done = this.made.get(id)
    if (done && done.source === source && done.mtimeMs === mtimeMs) {
      try {
        statSync(done.path)
        return done.path
      } catch {
        // The copy was cleared away: make it again.
      }
    }
    const dir = join(this.folder(), id)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const path = join(dir, paperFileName(item))
    copyFileSync(source, path)
    await whitenPdf(path)
    this.made.set(id, { source, mtimeMs, path })
    return path
  }
}
