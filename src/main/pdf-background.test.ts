import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, rgb } from 'pdf-lib'
import { ensureWhite, queueWhiten, whitenPdf } from './pdf-background'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-pdf-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function sample(name: string, pages = 2): Promise<string> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(i === 0 ? [600, 400] : [300, 300])
    page.drawRectangle({ x: 20, y: 20, width: 100, height: 50, color: rgb(0, 0, 0) })
  }
  const path = join(dir, name)
  writeFileSync(path, await doc.save())
  return path
}

describe('white backgrounds in PDFs', () => {
  it('draws a white page first on every page and keeps the rest', async () => {
    const path = await sample('a.pdf')
    expect(await whitenPdf(path)).toBe('whitened')
    const doc = await PDFDocument.load(readFileSync(path))
    expect(doc.getPageCount()).toBe(2)
    const sizes = doc.getPages().map((p) => [p.getWidth(), p.getHeight()])
    expect(sizes).toEqual([
      [600, 400],
      [300, 300]
    ])
    for (const page of doc.getPages()) {
      const list = page.node.Contents()
      expect(list).toBeInstanceOf(PDFArray)
      const streams = (list as PDFArray).asArray().map((ref) => doc.context.lookup(ref))
      expect(streams.length).toBe(2) // the white page, then the original drawing
      const first = streams[0] as PDFRawStream
      const text = Buffer.from(first.getContents()).toString('latin1')
      expect(text).toBe(`q 1 1 1 rg 0 0 ${page.getWidth()} ${page.getHeight()} re f Q\n`)
    }
    expect(doc.catalog.has(PDFName.of('EngramWhiteBackground'))).toBe(true)
  })

  it('does it once: a second go leaves the file as it was', async () => {
    const path = await sample('b.pdf')
    await whitenPdf(path)
    const once = readFileSync(path)
    expect(await whitenPdf(path)).toBe('already')
    expect(readFileSync(path).equals(once)).toBe(true)
  })

  it('leaves a file it can’t read untouched', async () => {
    const path = join(dir, 'broken.pdf')
    writeFileSync(path, 'this is not a pdf')
    expect(await whitenPdf(path)).toBe('skipped')
    expect(readFileSync(path, 'utf8')).toBe('this is not a pdf')
  })

  it('ignores other kinds of file, and waits for a PDF before handing it on', async () => {
    const txt = join(dir, 'n.txt')
    writeFileSync(txt, 'hello')
    expect(await queueWhiten(txt)).toBe('skipped')
    expect(readFileSync(txt, 'utf8')).toBe('hello')

    const path = await sample('c.pdf', 1)
    void queueWhiten(path)
    await ensureWhite(path)
    expect(readFileSync(path).includes('EngramWhiteBackground')).toBe(true)
  })
})
