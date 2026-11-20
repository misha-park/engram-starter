import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  isUniDot,
  parseDot,
  planSync,
  relink,
  type SyncTodo,
  type TotLink
} from './tot'

const DOT = [
  'UNI:',
  '○ Parkinsons write-up',
  '● Print the handout',
  'not a todo',
  '○ Email Stocker',
  ''
].join('\n')

describe('reading a dot', () => {
  it('finds the UNI dot by its first line', () => {
    expect(isUniDot('UNI:\n○ a')).toBe(true)
    expect(isUniDot('  uni \nx')).toBe(true)
    expect(isUniDot('To Do:\n○ a')).toBe(false)
    expect(isUniDot('University')).toBe(false)
  })

  it('reads smart-bullet lines only, with their tick', () => {
    expect(parseDot(DOT)).toEqual([
      { line: 1, text: 'Parkinsons write-up', done: false, bullet: '○' },
      { line: 2, text: 'Print the handout', done: true, bullet: '●' },
      { line: 4, text: 'Email Stocker', done: false, bullet: '○' }
    ])
    expect(parseDot('UNI\n□ a\n■ b\n  ▷ c\n○\n')).toMatchObject([
      { text: 'a', done: false },
      { text: 'b', done: true },
      { text: 'c', done: false }
    ])
  })
})

/** One fake world: the dot's text, the app's todos and the saved links. Sync applies a plan. */
function world(text: string, readOnly = false) {
  const w = {
    text,
    todos: [] as SyncTodo[],
    links: [] as TotLink[],
    previous: null as string[] | null,
    next: 1
  }
  const sync = () => {
    const items = parseDot(w.text)
    const plan = planSync(items, w.links, w.todos, w.previous, { readOnly })
    const created: TotLink[] = []
    for (const c of plan.app.create) {
      const id = `t${w.next++}`
      w.todos.push({ id, title: c.text, done: false, archived: false })
      created.push({ todoId: id, text: c.text, done: false, position: c.position })
    }
    for (const d of plan.app.setDone) w.todos.find((t) => t.id === d.todoId)!.done = d.done
    for (const r of plan.app.rename) w.todos.find((t) => t.id === r.todoId)!.title = r.title
    for (const id of plan.app.archive) w.todos.find((t) => t.id === id)!.archived = true
    w.text = applyEdits(w.text, items, plan.tot)
    const appended = plan.appended.map((a) => ({ ...a, done: false }))
    const now = parseDot(w.text)
    w.links = relink([...plan.links, ...created, ...appended], now)
    w.previous = now.map((i) => i.text)
    return plan
  }
  const todo = (title: string) => w.todos.find((t) => t.title === title)!
  return { w, sync, todo }
}

describe('syncing', () => {
  it('turns open lines into todos and ignores lines already ticked', () => {
    const { w, sync } = world(DOT)
    sync()
    expect(w.todos.map((t) => t.title)).toEqual(['Parkinsons write-up', 'Email Stocker'])
    expect(w.links).toHaveLength(2)
    // A second sync changes nothing.
    const again = sync()
    expect(again.app.create).toEqual([])
    expect(again.tot).toEqual({ setDone: [], rename: [], remove: [], append: [] })
  })

  it('appends new app todos after the last item, with the dot’s bullet', () => {
    const { w, sync } = world(DOT)
    sync()
    w.todos.push({ id: 'x', title: 'Book  library\nroom', done: false, archived: false })
    sync()
    expect(w.text.split('\n')).toEqual([
      'UNI:',
      '○ Parkinsons write-up',
      '● Print the handout',
      'not a todo',
      '○ Email Stocker',
      '○ Book library room',
      ''
    ])
    expect(w.links.find((l) => l.todoId === 'x')).toMatchObject({ position: 3 })
  })

  it('does not duplicate a todo that already has the same line on the first sync', () => {
    const { w, sync } = world(DOT)
    w.todos.push({ id: 'old', title: 'Email Stocker', done: false, archived: false })
    sync()
    expect(w.todos.filter((t) => t.title === 'Email Stocker')).toHaveLength(1)
    expect(w.text.match(/Email Stocker/g)).toHaveLength(1)
  })

  it('ticks both ways', () => {
    const { w, sync, todo } = world(DOT)
    sync()
    w.text = w.text.replace('○ Email Stocker', '● Email Stocker')
    sync()
    expect(todo('Email Stocker').done).toBe(true)
    todo('Parkinsons write-up').done = true
    sync()
    expect(w.text).toContain('● Parkinsons write-up')
    todo('Parkinsons write-up').done = false
    sync()
    expect(w.text).toContain('○ Parkinsons write-up')
  })

  it('keeps a todo done when its ticked line is deleted, and archives an open one', () => {
    const { w, sync, todo } = world(DOT)
    sync()
    w.text = w.text.replace('○ Email Stocker', '● Email Stocker')
    sync()
    w.text = w.text.replace('● Email Stocker\n', '').replace('○ Parkinsons write-up\n', '')
    const plan = sync()
    expect(todo('Email Stocker')).toMatchObject({ done: true, archived: false })
    expect(todo('Parkinsons write-up')).toMatchObject({ done: false, archived: true })
    expect(plan.app.create).toEqual([])
    expect(w.links).toEqual([])
  })

  it('renames both ways', () => {
    const { w, sync, todo } = world(DOT)
    sync()
    w.text = w.text.replace('Email Stocker', 'Email Stocker about the reference')
    sync()
    expect(todo('Email Stocker about the reference')).toBeDefined()
    expect(w.todos).toHaveLength(2)
    todo('Parkinsons write-up').title = 'Parkinson’s write-up'
    sync()
    expect(w.text).toContain('○ Parkinson’s write-up')
    expect(w.text).not.toContain('Parkinsons write-up')
  })

  it('removes the line when its todo is archived in the app, ticked or not', () => {
    const { w, sync, todo } = world(DOT)
    sync()
    todo('Email Stocker').archived = true
    todo('Parkinsons write-up').done = true
    sync()
    expect(w.text).toContain('● Parkinsons write-up')
    todo('Parkinsons write-up').archived = true
    sync()
    expect(w.text).not.toContain('Email Stocker')
    expect(w.text).not.toContain('Parkinsons write-up')
    expect(w.text).toContain('● Print the handout')
    expect(w.links).toEqual([])
  })

  it('does not mistake a new line for a renamed one when the old todo was archived', () => {
    const { w, sync, todo } = world('UNI\n○ a\n○ b')
    sync()
    todo('b').archived = true
    w.text = 'UNI\n○ a\n○ c'
    sync()
    expect(w.todos.map((t) => [t.title, t.archived])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false]
    ])
    expect(w.text).toBe('UNI\n○ a\n○ c')
  })

  it('handles a dot with only the header', () => {
    const { w, sync } = world('UNI:')
    w.todos.push({ id: 'x', title: 'First', done: false, archived: false })
    sync()
    expect(w.text).toBe('UNI:\n○ First')
  })

  it('keeps identical lines apart', () => {
    const { w, sync } = world('UNI\n○ Read\n○ Read')
    sync()
    expect(w.todos).toHaveLength(2)
    w.todos[1].done = true
    sync()
    expect(w.text).toBe('UNI\n○ Read\n● Read')
  })
})

describe('read-only sync (real Tot: writes would switch the dot to plain text)', () => {
  it('takes new lines, ticks and deletions from Tot and never edits the dot', () => {
    const { w, sync, todo } = world(DOT, true)
    w.todos.push({ id: 'app', title: 'Made in the app', done: false, archived: false })
    const first = sync()
    expect(first.tot).toEqual({ setDone: [], rename: [], remove: [], append: [] })
    expect(w.text).toBe(DOT)
    expect(todo('Email Stocker')).toBeDefined()
    w.text = w.text
      .replace('○ Email Stocker', '● Email Stocker')
      .replace('○ Parkinsons write-up\n', '')
    sync()
    expect(todo('Email Stocker').done).toBe(true)
    expect(todo('Parkinsons write-up').archived).toBe(true)
  })

  it('leaves app-side ticks, renames and removals alone and imports nothing twice', () => {
    const { w, sync, todo } = world(DOT, true)
    sync()
    const text = w.text
    todo('Email Stocker').done = true
    todo('Parkinsons write-up').archived = true
    sync()
    const again = sync()
    expect(w.text).toBe(text)
    expect(again.app).toEqual({ create: [], setDone: [], rename: [], archive: [] })
    expect(w.todos.filter((t) => t.title === 'Parkinsons write-up')).toHaveLength(1)
    expect(todo('Email Stocker').done).toBe(true)
    // Ticked in Tot later too: still done, nothing else happens.
    w.text = w.text.replace('○ Email Stocker', '● Email Stocker')
    expect(sync().app.setDone).toEqual([])
  })
})
