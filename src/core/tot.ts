// Tot sync (Phase 8): pure logic, no I/O. The todos live in the Tot dot whose first line is
// "UNI" (a trailing colon is fine). Each smart-bullet line is a todo: "○ name" open, "● name"
// ticked (Tot's other default pairs work too). A sync compares the dot and the app with the
// state saved at the last sync (the links), so it can tell which side changed.

/** Smart-bullet pairs: [open, ticked]. Tot's defaults; the user's dot uses ○ / ●. */
export const BULLET_PAIRS: [string, string][] = [
  ['○', '●'],
  ['□', '■'],
  ['▷', '▶'],
  ['☆', '★']
]

const OPEN = new Map(BULLET_PAIRS.map(([o, d]) => [o, d]))
const TICKED = new Map(BULLET_PAIRS.map(([o, d]) => [d, o]))
const BULLET_LINE = new RegExp(
  `^(\\s*)(${BULLET_PAIRS.flat()
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})[ \\t]+(.*?)\\s*$`
)

export interface TotItem {
  /** Line number in the dot's text (0-based). */
  line: number
  text: string
  done: boolean
  bullet: string
}

/** True when this is the UNI dot: its first line is "UNI" or "UNI:" (any case). */
export function isUniDot(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? ''
  return /^\s*uni\s*:?\s*$/i.test(first)
}

/** The smart-bullet lines of a dot (the header line is never one). */
export function parseDot(text: string): TotItem[] {
  const items: TotItem[] = []
  text.split('\n').forEach((raw, line) => {
    if (line === 0) return
    const m = BULLET_LINE.exec(raw)
    if (!m || !m[3]) return
    items.push({ line, text: m[3], done: TICKED.has(m[2]), bullet: m[2] })
  })
  return items
}

/** What was true for a linked todo at the last sync. */
export interface TotLink {
  todoId: string
  text: string
  done: boolean
  /** Index among the dot's items, used to recognise a line renamed in Tot. */
  position: number
}

export interface SyncTodo {
  id: string
  title: string
  done: boolean
  archived: boolean
}

export interface TotEdits {
  setDone: { line: number; done: boolean }[]
  rename: { line: number; text: string }[]
  remove: number[]
  append: string[]
}

export interface SyncPlan {
  app: {
    /** New todos from new open lines. `position` is the item index, for the new link. */
    create: { text: string; position: number }[]
    setDone: { todoId: string; done: boolean }[]
    rename: { todoId: string; title: string }[]
    archive: string[]
  }
  tot: TotEdits
  /** Links after the sync, except those for todos still to be created (see `create`). */
  links: TotLink[]
  /** Links for app todos that get appended: their position once appended. */
  appended: { todoId: string; text: string; position: number }[]
}

/** Titles become one line in Tot. */
export const lineText = (title: string) => title.replace(/\s+/g, ' ').trim()

/**
 * Work out one sync. `items` is the dot as just read; `links` the state saved at the last sync;
 * `todos` every todo the links refer to plus every open todo (unlinked ones get appended);
 * `previous` the item texts at the last sync, to recognise renames.
 * `readOnly`: changes only flow from Tot to the app (the dot is never edited); links follow
 * the dot, so app-side differences stay as they are without being re-imported.
 */
export function planSync(
  items: TotItem[],
  links: TotLink[],
  todos: SyncTodo[],
  previous: string[] | null = null,
  opts: { readOnly?: boolean } = {}
): SyncPlan {
  const readOnly = !!opts.readOnly
  const byId = new Map(todos.map((t) => [t.id, t]))
  const plan: SyncPlan = {
    app: { create: [], setDone: [], rename: [], archive: [] },
    tot: { setDone: [], rename: [], remove: [], append: [] },
    links: [],
    appended: []
  }
  const usedItems = new Set<number>()
  const matched = new Map<string, { item: TotItem; index: number; renamedInTot: boolean }>()

  // 1. Same text, nearest to where it was.
  for (const link of links) {
    let best = -1
    items.forEach((item, i) => {
      if (usedItems.has(i) || item.text !== link.text) return
      if (best < 0 || Math.abs(i - link.position) < Math.abs(best - link.position)) best = i
    })
    if (best >= 0) {
      usedItems.add(best)
      matched.set(link.todoId, { item: items[best], index: best, renamedInTot: false })
    }
  }
  // 2. Still unmatched: when the dot has as many items as last time and the line in the link's
  //    place is new, it's the same line, renamed in Tot.
  if (previous && previous.length === items.length) {
    for (const link of links) {
      const todo = byId.get(link.todoId)
      if (matched.has(link.todoId) || !todo || todo.archived) continue
      const i = link.position
      if (
        i < items.length &&
        !usedItems.has(i) &&
        previous[i] === link.text &&
        !previous.includes(items[i].text)
      ) {
        usedItems.add(i)
        matched.set(link.todoId, { item: items[i], index: i, renamedInTot: true })
      }
    }
  }

  for (const link of links) {
    const todo = byId.get(link.todoId)
    const m = matched.get(link.todoId)
    if (!m) {
      // The line is gone from Tot. Ticked → the todo stays done; unticked → archived.
      if (todo && !todo.archived && !link.done && !todo.done) plan.app.archive.push(todo.id)
      continue
    }
    const { item, index, renamedInTot } = m
    if (!todo || todo.archived) {
      if (readOnly) {
        // Can't remove the line: keep it linked so it isn't imported again.
        if (todo)
          plan.links.push({ todoId: todo.id, text: item.text, done: item.done, position: index })
        continue
      }
      // Archived (or deleted) in the app: the line goes from Tot, ticked or not.
      plan.tot.remove.push(item.line)
      continue
    }
    const totChanged = item.done !== link.done
    const appChanged = todo.done !== link.done
    let done = item.done
    if (appChanged && !totChanged) {
      if (!readOnly) {
        done = todo.done
        plan.tot.setDone.push({ line: item.line, done })
      }
    } else if (totChanged && !appChanged) {
      plan.app.setDone.push({ todoId: todo.id, done })
    } else if (appChanged && totChanged) {
      done = item.done // Both ticked (or both unticked): already the same.
    }
    let text = item.text
    if (renamedInTot) {
      if (lineText(todo.title) !== item.text)
        plan.app.rename.push({ todoId: todo.id, title: item.text })
    } else if (lineText(todo.title) !== link.text && !readOnly) {
      text = lineText(todo.title)
      plan.tot.rename.push({ line: item.line, text })
    }
    plan.links.push({ todoId: todo.id, text, done, position: index })
  }

  // 3. Lines not linked yet: an open todo with the same title takes it (no duplicate);
  //    otherwise an open line becomes a new todo. New ticked lines are ignored.
  const linkedIds = new Set(links.map((l) => l.todoId))
  const unlinkedOpen = todos.filter((t) => !linkedIds.has(t.id) && !t.archived && !t.done)
  const claimed = new Set<string>()
  items.forEach((item, i) => {
    if (usedItems.has(i)) return
    const same = unlinkedOpen.find((t) => !claimed.has(t.id) && lineText(t.title) === item.text)
    if (same) {
      claimed.add(same.id)
      plan.links.push({ todoId: same.id, text: item.text, done: item.done, position: i })
      if (item.done) plan.app.setDone.push({ todoId: same.id, done: true })
      return
    }
    if (!item.done) plan.app.create.push({ text: item.text, position: i })
  })

  // 4. Open app todos with no line: appended to the dot.
  if (readOnly) return plan
  let position = items.length - plan.tot.remove.length
  for (const t of unlinkedOpen) {
    if (claimed.has(t.id)) continue
    const text = lineText(t.title)
    if (!text) continue
    plan.tot.append.push(text)
    plan.appended.push({ todoId: t.id, text, position: position++ })
  }
  return plan
}

/** Apply the Tot side of a plan to the text it was planned from. */
export function applyEdits(text: string, items: TotItem[], edits: TotEdits): string {
  const lines = text.split('\n')
  const byLine = new Map(items.map((i) => [i.line, i]))
  const swap = (item: TotItem, done: boolean) =>
    done ? (OPEN.get(item.bullet) ?? item.bullet) : (TICKED.get(item.bullet) ?? item.bullet)
  const rewrite = (line: number, fn: (item: TotItem) => { bullet?: string; text?: string }) => {
    const item = byLine.get(line)
    if (!item) return
    const m = BULLET_LINE.exec(lines[line])
    if (!m) return
    const next = fn(item)
    lines[line] = `${m[1]}${next.bullet ?? m[2]} ${next.text ?? m[3]}`
  }
  for (const e of edits.setDone) rewrite(e.line, (item) => ({ bullet: swap(item, e.done) }))
  for (const e of edits.rename) rewrite(e.line, () => ({ text: e.text }))

  // New lines go after the last item (or the header), with the dot's own open bullet.
  const open =
    items.find((i) => !i.done)?.bullet ??
    (items[0] ? TICKED.get(items[0].bullet) : undefined) ??
    '○'
  const after = items.length ? items[items.length - 1].line : 0
  const added = edits.append.map((t) => `${open} ${t}`)
  const removed = new Set(edits.remove)
  const out: string[] = []
  lines.forEach((l, i) => {
    if (!removed.has(i)) out.push(l)
    if (i === after) out.push(...added)
  })
  return out.join('\n')
}

/** After writing, the links' positions in the new text (same text, nearest to the old place). */
export function relink(links: TotLink[], items: TotItem[]): TotLink[] {
  const used = new Set<number>()
  const out: TotLink[] = []
  for (const link of [...links].sort((a, b) => a.position - b.position)) {
    let best = -1
    items.forEach((item, i) => {
      if (used.has(i) || item.text !== link.text) return
      if (best < 0 || Math.abs(i - link.position) < Math.abs(best - link.position)) best = i
    })
    if (best < 0) continue
    used.add(best)
    out.push({ ...link, position: best, done: items[best].done })
  }
  return out
}
