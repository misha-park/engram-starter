import { execFile } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { extname } from 'path'

// Reading text out of documents on this Mac, with no extra libraries: plain text directly,
// Word/RTF/HTML/Pages through textutil, PDF through PDFKit (JavaScript for Automation), and
// Excel (.xlsx) by unzipping it and reading the sheets' XML.
// Used by plan import, attachments and assignment briefs.

const TEXT = ['.txt', '.md', '.markdown', '.csv']
const TEXTUTIL = ['.docx', '.doc', '.rtf', '.odt', '.html', '.htm', '.pages']
const PDF = ['.pdf']
const SHEET = ['.xlsx']

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 }, (error, out, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(out)
    )
  )

const PDF_SCRIPT = `ObjC.import('PDFKit')
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]))
  return doc.isNil() ? '' : ObjC.unwrap(doc.string)
}`

/** Whether text can be read from a file of this name. */
export function isReadableDocument(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return [...TEXT, ...TEXTUTIL, ...PDF, ...SHEET].includes(ext)
}

/** The text of a document, trimmed and cut to `maxChars`. Throws when there's none. */
export async function readDocument(path: string, maxChars: number): Promise<string> {
  if (statSync(path).size > 25 * 1024 * 1024) throw new Error('That file is too large to read.')
  const ext = extname(path).toLowerCase()
  let text: string
  if (TEXT.includes(ext)) text = readFileSync(path, 'utf8')
  else if (TEXTUTIL.includes(ext))
    text = await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', path])
  else if (PDF.includes(ext))
    text = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_SCRIPT, path])
  else if (SHEET.includes(ext)) text = await xlsxText(path)
  else throw new Error('Text can only be read from Word, Excel, PDF, RTF, Pages or text files.')
  text = text.trim()
  if (!text) throw new Error('No text could be read from that file.')
  return text.slice(0, maxChars)
}

const unescapeXml = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/**
 * An Excel number as text. Excel stores dates as days since 1899-12-30 and times as fractions
 * of a day, and only the cell's style says which; for timetables, whole numbers in the range
 * of recent years are dates and fractions are times, which is right for lecture lists.
 */
export function excelValue(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n) || raw.trim() === '') return raw
  if (n > 0 && n < 1) {
    const minutes = Math.round(n * 24 * 60)
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  }
  if (Number.isInteger(n) && n > 40000 && n < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000)
    return d.toISOString().slice(0, 10)
  }
  if (n > 40000 && n < 60000) {
    // A date with a time.
    const ms = Date.UTC(1899, 11, 30) + n * 86_400_000
    return new Date(Math.round(ms / 60_000) * 60_000).toISOString().slice(0, 16).replace('T', ' ')
  }
  return raw
}

/** The sheets of an .xlsx file as tab-separated text, one block per sheet. */
export async function xlsxText(path: string): Promise<string> {
  const list = (await run('/usr/bin/unzip', ['-Z1', path])).split('\n').map((l) => l.trim())
  const read = (entry: string) => run('/usr/bin/unzip', ['-p', path, entry])
  const strings = list.includes('xl/sharedStrings.xml')
    ? [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        unescapeXml(m[1])
      )
    : []
  const names = list.includes('xl/workbook.xml')
    ? [...(await read('xl/workbook.xml')).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) =>
        unescapeXml(m[1])
      )
    : []
  const sheets = list
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const out: string[] = []
  for (const [i, sheet] of sheets.entries()) {
    const xml = await read(sheet)
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
      [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
        .map((c) => {
          const attrs = c[1]
          const inner = c[2] ?? ''
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
          if (/t="s"/.test(attrs) && v !== undefined) return strings[Number(v)] ?? ''
          if (/t="inlineStr"/.test(attrs)) return unescapeXml(inner)
          return v === undefined ? '' : excelValue(unescapeXml(v))
        })
        .join('\t')
    )
    out.push(`## Sheet: ${names[i] ?? i + 1}`, ...rows.filter((r) => r.trim()), '')
  }
  return out.join('\n')
}
