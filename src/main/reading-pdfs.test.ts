import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { Temporal } from 'temporal-polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { AppContext } from './app-context'
import type { Db } from './db/client'
import * as t from './db/schema'
import { paperFileName, ReadingPdfs } from './reading-pdfs'
import { LocalZotero, localFile, pickPdf, type ReadingSource, type ZoteroItemJson } from './zotero'

const migrations = resolve(__dirname, '../../drizzle')
const contexts: AppContext[] = []
function open(): Db {
  const ctx = new AppContext(mkdtempSync(join(tmpdir(), 'engram-rp-')), migrations, {
    clock: () => Temporal.Instant.from('2026-11-18T14:00:00Z')
  })
  contexts.push(ctx)
  ctx.open()
  return ctx.db
}
afterEach(() => contexts.splice(0).forEach((c) => c.close()))

async function samplePdf(dir: string, name: string): Promise<string> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  const path = join(dir, name)
  writeFileSync(path, await doc.save())
  return path
}

const attachment = (
  key: string,
  title: string,
  extra: Partial<ZoteroItemJson['data']> = {}
): ZoteroItemJson => ({
  key,
  data: {
    itemType: 'attachment',
    title,
    contentType: 'application/pdf',
    linkMode: 'imported_file',
    ...extra
  }
})

describe('a paper’s file name', () => {
  it('is made from authors, year and title, safe for a file system', () => {
    expect(paperFileName({ creators: 'Smith et al.', year: '2020', title: 'Faces: a/b?' })).toBe(
      'Smith et al. (2020) Faces a b.pdf'
    )
    expect(paperFileName({ creators: '', year: null, title: '' })).toBe('Paper.pdf')
    expect(
      paperFileName({ creators: 'A', year: '1999', title: 'x'.repeat(300) }).length
    ).toBeLessThan(130)
  })
})

describe('picking a paper’s PDF from its attachments', () => {
  it('leaves out supplementary material and prefers a file Zotero holds itself', () => {
    const list = [
      attachment('SUPP0001', 'Supplementary Materials.pdf'),
      attachment('LINK0001', 'Linked copy.pdf', { linkMode: 'linked_file' }),
      attachment('MAIN0001', 'Full Text PDF'),
      {
        key: 'SNAP0001',
        data: { itemType: 'attachment', title: 'Snapshot', contentType: 'text/html' }
      }
    ]
    expect(pickPdf(list)?.key).toBe('MAIN0001')
    expect(pickPdf([list[0]])?.key).toBe('SUPP0001') // better than nothing
    expect(pickPdf([list[3]])).toBeNull()
    expect(pickPdf([])).toBeNull()
  })

  it('finds the file Zotero points to, only if it is there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-rp-'))
    const file = await samplePdf(dir, 'a b.pdf')
    expect(localFile(pathToFileURL(file).href)).toBe(file)
    expect(localFile(pathToFileURL(join(dir, 'gone.pdf')).href)).toBeNull()
    expect(localFile('https://example.com/a.pdf')).toBeNull()
    expect(localFile(undefined)).toBeNull()
  })

  it('asks Zotero for the children, and follows its redirect when it has to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-rp-'))
    const file = await samplePdf(dir, 'paper.pdf')
    const real = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (url: string) => {
      seen.push(url)
      if (url.includes('/children')) {
        return Response.json([attachment('ATTACH01', 'Full Text PDF')])
      }
      // The file itself: Zotero answers with a redirect to where it is.
      return new Response(null, { status: 302, headers: { location: pathToFileURL(file).href } })
    }) as typeof fetch
    try {
      const z = new LocalZotero('http://zotero.test/api/users/0')
      expect(await z.pdfFile('PAPER001')).toBe(file)
      expect(seen[0]).toContain('/items/PAPER001/children')
      expect(seen[1]).toContain('/items/ATTACH01/file')
      await expect(z.pdfFile('../etc')).rejects.toThrow('Invalid item')
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('getting a paper’s PDF ready to drag out', () => {
  it('copies it under the paper’s name with a white page, and never touches Zotero’s file', async () => {
    const db = open()
    const row = db.select().from(t.readingItems).all()[0]
    const dir = mkdtempSync(join(tmpdir(), 'engram-rp-'))
    const original = await samplePdf(dir, 'zotero-own-name.pdf')
    const before = readFileSync(original)
    let asked = 0
    const source = {
      pdfFile: async () => (asked++, original)
    } as unknown as ReadingSource
    const pdfs = new ReadingPdfs(
      () => source,
      () => join(dir, 'out'),
      () => db
    )

    const path = await pdfs.prepare(row.id)
    expect(path).not.toBeNull()
    expect(basename(path!)).toBe(paperFileName(row))
    expect(readFileSync(path!).includes('EngramWhiteBackground')).toBe(true)
    expect(readFileSync(original).equals(before)).toBe(true)

    // Asked again with nothing changed: the same copy, not made again.
    const stamp = statSync(path!).mtimeMs
    expect(await pdfs.prepare(row.id)).toBe(path)
    expect(statSync(path!).mtimeMs).toBe(stamp)
    expect(asked).toBe(2)
  })

  it('says so when Zotero has no PDF, and refuses an unknown paper', async () => {
    const db = open()
    const row = db.select().from(t.readingItems).all()[0]
    const none = { pdfFile: async () => null } as unknown as ReadingSource
    const pdfs = new ReadingPdfs(
      () => none,
      () => tmpdir(),
      () => db
    )
    expect(await pdfs.prepare(row.id)).toBeNull()
    await expect(pdfs.prepare('NOPE0000')).rejects.toThrow('not found')
  })
})
