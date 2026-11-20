import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import { parseQuickTodo } from './todos'

const THU = Temporal.PlainDate.from('2026-11-19')
const p = (t: string) => parseQuickTodo(t, THU)

describe('a due date typed at the end of a todo', () => {
  it('reads today, tomorrow, weekdays and next week', () => {
    expect(p('Return books tomorrow')).toEqual({ title: 'Return books', dueDate: '2026-11-20' })
    expect(p('Call home today')).toEqual({ title: 'Call home', dueDate: '2026-11-19' })
    expect(p('Email Sam by fri')).toEqual({ title: 'Email Sam', dueDate: '2026-11-20' })
    expect(p('Lab form on Thursday')).toEqual({ title: 'Lab form', dueDate: '2026-11-26' })
    expect(p('Book room next week')).toEqual({ title: 'Book room', dueDate: '2026-11-23' })
    expect(p('Hoover Mon')).toEqual({ title: 'Hoover', dueDate: '2026-11-23' })
  })

  it('reads dates, rolling past ones into next year', () => {
    expect(p('Hand in form 3 Dec')).toEqual({ title: 'Hand in form', dueDate: '2026-12-03' })
    expect(p('Renew card by December 3rd')).toEqual({ title: 'Renew card', dueDate: '2026-12-03' })
    expect(p('Pay rent 1 Oct')).toEqual({ title: 'Pay rent', dueDate: '2027-10-01' })
  })

  it('leaves everything else alone', () => {
    expect(p('Read about Friday effects')).toEqual({
      title: 'Read about Friday effects',
      dueDate: null
    })
    expect(p('Friday')).toEqual({ title: 'Friday', dueDate: null })
    expect(p('Sundays are for rest')).toEqual({ title: 'Sundays are for rest', dueDate: null })
    expect(p('Mark 31 Feb')).toEqual({ title: 'Mark 31 Feb', dueDate: null })
    expect(p('Monitor results')).toEqual({ title: 'Monitor results', dueDate: null })
    expect(p('Check the monitor')).toEqual({ title: 'Check the monitor', dueDate: null })
    expect(p('Buy satsumas')).toEqual({ title: 'Buy satsumas', dueDate: null })
    expect(p('Find 3 markers')).toEqual({ title: 'Find 3 markers', dueDate: null })
  })
})
