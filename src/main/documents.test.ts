import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { excelValue, isReadableDocument, readDocument, xlsxText } from './documents'

/** A minimal .xlsx: one sheet with a header row and a lecture (date, times, title). */
function makeXlsx(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-xlsx-'))
  mkdirSync(join(dir, 'xl', 'worksheets'), { recursive: true })
  writeFileSync(
    join(dir, 'xl', 'workbook.xml'),
    '<workbook><sheets><sheet name="Lectures" sheetId="1"/></sheets></workbook>'
  )
  writeFileSync(
    join(dir, 'xl', 'sharedStrings.xml'),
    '<sst><si><t>Date</t></si><si><t>Start</t></si><si><t>Title</t></si><si><t>Limbic system &amp; memory</t></si></sst>'
  )
  writeFileSync(
    join(dir, 'xl', 'worksheets', 'sheet1.xml'),
    '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2"><v>46301</v></c><c r="B2"><v>0.45833333333333331</v></c><c r="C2" t="s"><v>3</v></c></row>' +
      '</sheetData></worksheet>'
  )
  const file = join(dir, 'list.xlsx')
  execFileSync('/usr/bin/zip', ['-qr', file, 'xl'], { cwd: dir })
  return file
}

describe('reading Excel lecture lists', () => {
  it('turns Excel dates and times into readable ones', () => {
    expect(excelValue('46301')).toBe('2026-10-06')
    expect(excelValue('0.45833333333333331')).toBe('11:00')
    expect(excelValue('0.5')).toBe('12:00')
    expect(excelValue('6')).toBe('6')
    expect(excelValue('Tue')).toBe('Tue')
  })

  it('reads every sheet as tab-separated rows', async () => {
    const file = makeXlsx()
    expect(isReadableDocument(file)).toBe(true)
    const text = await xlsxText(file)
    expect(text.split('\n')).toEqual([
      '## Sheet: Lectures',
      'Date\tStart\tTitle',
      '2026-10-06\t11:00\tLimbic system & memory',
      ''
    ])
    expect(await readDocument(file, 1000)).toContain('Limbic system & memory')
  })
})
