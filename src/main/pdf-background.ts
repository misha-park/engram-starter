import { readFile, rename, writeFile } from 'fs/promises'
import { PDFArray, PDFBool, PDFDocument, PDFName, PDFRef } from 'pdf-lib'

// A PDF page has no background of its own: a viewer draws it over its own colour. Many PDFs
// (slides exported from some tools, scans, anything made without a paper colour) leave the page
// transparent, so on a black GoodNotes whiteboard the black text vanishes. This bakes a white
// page behind everything: one filled rectangle drawn first on each page, with the rest of the
// page (text, links, forms, bookmarks) left exactly as it was. Done once per file, marked by a
// key in the catalogue; a file that can't be read or is encrypted is left untouched.

const MARK = 'EngramWhiteBackground'

export type WhitenResult = 'whitened' | 'already' | 'skipped'

const isPdf = (path: string) => path.toLowerCase().endsWith('.pdf')

/** Put a white page behind each page of the PDF at `path` (in place), unless already done. */
export async function whitenPdf(path: string): Promise<WhitenResult> {
  try {
    const bytes = await readFile(path)
    if (bytes.includes(MARK)) return 'already'
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: false
    })
    const context = doc.context
    for (const page of doc.getPages()) {
      const { x, y, width, height } = page.getMediaBox()
      const white = context.register(
        context.stream(`q 1 1 1 rg ${x} ${y} ${width} ${height} re f Q\n`)
      )
      const contents = PDFName.of('Contents')
      const existing = page.node.get(contents)
      const resolved = existing instanceof PDFRef ? context.lookup(existing) : existing
      const list = PDFArray.withContext(context)
      list.push(white)
      if (resolved instanceof PDFArray) for (const item of resolved.asArray()) list.push(item)
      else if (existing) list.push(existing)
      page.node.set(contents, list)
    }
    doc.catalog.set(PDFName.of(MARK), PDFBool.True)
    const out = await doc.save({ useObjectStreams: false })
    // Written beside the original and moved over it, so a failure never leaves half a file.
    const temp = `${path}.white`
    await writeFile(temp, out)
    await rename(temp, path)
    return 'whitened'
  } catch {
    return 'skipped'
  }
}

// Whitening runs in the background when a PDF arrives, so anything that hands the file on
// (drag, copy, download, open) waits for it here first. One at a time per file.
const pending = new Map<string, Promise<WhitenResult>>()

/** Start whitening `path` if it's a PDF (no-op otherwise). The promise settles when it's done. */
export function queueWhiten(path: string): Promise<WhitenResult> {
  if (!isPdf(path)) return Promise.resolve('skipped')
  const running = pending.get(path)
  if (running) return running
  const job = whitenPdf(path).finally(() => pending.delete(path))
  pending.set(path, job)
  return job
}

/** Wait until `path` is ready to hand on: for a PDF, with its white background in. */
export async function ensureWhite(path: string): Promise<void> {
  await queueWhiten(path)
}
