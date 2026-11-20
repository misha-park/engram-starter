import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import type { ZoteroCollection } from '../shared/types'

// The dissertation reading list comes from one Zotero collection, including all its
// subcollections (a dissertation folder usually has a folder per topic). In the real profile it is
// read from Zotero 7's local API (http://localhost:23119/api/, read-only, no key; Zotero must
// be open with "Allow other applications on this computer to communicate with Zotero" on).
// The demo reads a fixture file in the same JSON format.

/** The parts of a Zotero item (API v3 JSON) the reading list uses. */
export interface ZoteroItemJson {
  key: string
  data: {
    itemType: string
    title?: string
    /** Attachments: what the file is, how Zotero holds it, and its title. */
    contentType?: string
    linkMode?: string
    filename?: string
    creators?: { creatorType: string; firstName?: string; lastName?: string; name?: string }[]
    date?: string
    publicationTitle?: string
    bookTitle?: string
    DOI?: string
    url?: string
  }
  meta?: { creatorSummary?: string; parsedDate?: string }
  links?: { enclosure?: { href?: string; type?: string } }
}

interface ZoteroCollectionJson {
  key: string
  data: { name: string; parentCollection: string | false }
  meta?: { numItems?: number }
}

export interface ReadingSource {
  collections(): Promise<ZoteroCollection[]>
  /** The collection's items, and those of all its subcollections (each item once). */
  items(collectionKey: string): Promise<ZoteroItemJson[]>
  /** Where a paper's PDF is on this Mac (Zotero's own copy, never to be changed), if it has one. */
  pdfFile(itemKey: string): Promise<string | null>
}

/**
 * The PDF to use among an item's attachments: not the supplementary material, and one Zotero
 * holds itself in preference to a link to a file elsewhere. Null when there is none.
 */
export function pickPdf(children: ZoteroItemJson[]): ZoteroItemJson | null {
  const pdfs = children.filter(
    (c) => c.data.itemType === 'attachment' && c.data.contentType === 'application/pdf'
  )
  const score = (c: ZoteroItemJson) =>
    (/supplement|appendix|\bsi\b/i.test(`${c.data.title ?? ''} ${c.data.filename ?? ''}`) ? 2 : 0) +
    (c.data.linkMode?.startsWith('imported') ? 0 : 1)
  return [...pdfs].sort((a, b) => score(a) - score(b))[0] ?? null
}

/** The file path a Zotero `file://` address points to, if it's a file that exists. */
export function localFile(href: string | null | undefined): string | null {
  if (!href?.startsWith('file://')) return null
  try {
    const path = fileURLToPath(href)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** A collection's key and the keys of every collection below it. */
export function withSubcollections(list: ZoteroCollectionJson[], key: string): string[] {
  const children = new Map<string, string[]>()
  for (const c of list) {
    const parent = c.data.parentCollection
    if (parent) children.set(parent, [...(children.get(parent) ?? []), c.key])
  }
  const out: string[] = []
  const visit = (k: string) => {
    if (out.includes(k)) return
    out.push(k)
    for (const child of children.get(k) ?? []) visit(child)
  }
  visit(key)
  return out
}

/**
 * The collections as a tree, in order (each parent before its children), with "Parent /
 * Child" paths and counts that include subfolders.
 */
export function collectionPaths(list: ZoteroCollectionJson[]): ZoteroCollection[] {
  const byKey = new Map(list.map((c) => [c.key, c]))
  const chain = (c: ZoteroCollectionJson): ZoteroCollectionJson[] => {
    const out = [c]
    let cur = c
    while (cur.data.parentCollection && out.length < 10) {
      const parent = byKey.get(cur.data.parentCollection)
      if (!parent) break
      out.unshift(parent)
      cur = parent
    }
    return out
  }
  return list
    .map((c) => {
      const parts = chain(c)
      return {
        key: c.key,
        name: c.data.name,
        path: parts.map((p) => p.data.name).join(' / '),
        depth: parts.length - 1,
        ownItems: c.meta?.numItems ?? 0,
        numItems: withSubcollections(list, c.key).reduce(
          (sum, k) => sum + (byKey.get(k)?.meta?.numItems ?? 0),
          0
        ),
        // Sort by the names along the path, so children follow their parent.
        sortKey: parts.map((p) => p.data.name.toLowerCase()).join('\u0000')
      }
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((c) => {
      const { sortKey, ...rest } = c
      void sortKey
      return rest
    })
}

/** Items once each, in the order first seen. */
function unique(items: ZoteroItemJson[]): ZoteroItemJson[] {
  const seen = new Set<string>()
  return items.filter((i) => !seen.has(i.key) && !!seen.add(i.key))
}

/** Items worth listing: no attachments or notes. */
export const isReadable = (item: ZoteroItemJson) =>
  !['attachment', 'note', 'annotation'].includes(item.data.itemType)

/** "Smith & Jones" / "Smith et al." from the creators (Zotero's own summary when present). */
export function creatorSummary(item: ZoteroItemJson): string {
  if (item.meta?.creatorSummary) return item.meta.creatorSummary
  const authors = (item.data.creators ?? []).filter((c) => c.creatorType === 'author')
  const names = (authors.length ? authors : (item.data.creators ?? [])).map(
    (c) => c.lastName ?? c.name ?? ''
  )
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  return `${names[0]} et al.`
}

export function itemYear(item: ZoteroItemJson): string | null {
  const parsed = item.meta?.parsedDate ?? item.data.date ?? ''
  return /\b(\d{4})\b/.exec(parsed)?.[1] ?? null
}

export const ZOTERO_BASE = 'http://localhost:23119/api/users/0'

export class LocalZotero implements ReadingSource {
  constructor(private readonly base = ZOTERO_BASE) {}

  /** Every page of a list (the API sends 25 at a time unless asked for more). */
  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = []
    const PAGE = 100
    for (let start = 0; start < 50_000; start += PAGE) {
      const sep = path.includes('?') ? '&' : '?'
      const page = await this.get<T[]>(`${path}${sep}limit=${PAGE}&start=${start}`)
      out.push(...page)
      if (page.length < PAGE) break
    }
    return out
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(10_000) })
    } catch (e) {
      throw new Error('Zotero isn’t running. Open Zotero and try again.', { cause: e })
    }
    if (res.status === 403) {
      throw new Error(
        'Zotero isn’t sharing its library. In Zotero, open Settings → Advanced and turn on “Allow other applications on this computer to communicate with Zotero”.'
      )
    }
    if (!res.ok) throw new Error(`Zotero answered ${res.status}.`)
    return (await res.json()) as T
  }

  async collections(): Promise<ZoteroCollection[]> {
    return collectionPaths(await this.all<ZoteroCollectionJson>('/collections'))
  }

  async pdfFile(itemKey: string): Promise<string | null> {
    if (!/^[A-Z0-9]{8}$/.test(itemKey)) throw new Error('Invalid item.')
    const pdf = pickPdf(await this.all<ZoteroItemJson>(`/items/${itemKey}/children`))
    if (!pdf) return null
    const direct = localFile(pdf.links?.enclosure?.href)
    if (direct) return direct
    // Otherwise ask Zotero for the file: it answers with a redirect to where it is.
    try {
      const res = await fetch(`${this.base}/items/${pdf.key}/file`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000)
      })
      return localFile(res.headers.get('location'))
    } catch (e) {
      throw new Error('Zotero isn’t running. Open Zotero and try again.', { cause: e })
    }
  }

  async items(collectionKey: string): Promise<ZoteroItemJson[]> {
    if (!/^[A-Z0-9]{8}$/.test(collectionKey)) throw new Error('Invalid collection.')
    const keys = withSubcollections(
      await this.all<ZoteroCollectionJson>('/collections'),
      collectionKey
    )
    const items: ZoteroItemJson[] = []
    for (const key of keys)
      items.push(...(await this.all<ZoteroItemJson>(`/collections/${key}/items/top`)))
    return unique(items).filter(isReadable)
  }
}

/** The demo's reading list: a fixture file in the local API's format. */
export class FixtureZotero implements ReadingSource {
  constructor(private readonly file: string) {}

  private load(): { collections: ZoteroCollectionJson[]; items: Record<string, ZoteroItemJson[]> } {
    return JSON.parse(readFileSync(this.file, 'utf8'))
  }

  async collections(): Promise<ZoteroCollection[]> {
    return collectionPaths(this.load().collections)
  }

  /** The demo has no PDFs. */
  async pdfFile(): Promise<string | null> {
    return null
  }

  async items(collectionKey: string): Promise<ZoteroItemJson[]> {
    const { collections, items } = this.load()
    return unique(
      withSubcollections(collections, collectionKey).flatMap((k) => items[k] ?? [])
    ).filter(isReadable)
  }
}
