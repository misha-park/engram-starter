import { Temporal } from 'temporal-polyfill'
import type { Todo } from '../shared/types'

/**
 * The next due date of a recurring todo after the one just completed: daily → the next day;
 * weekly → the next of its weekdays. Counted from the later of the old due date and today, so
 * catching up on an old one doesn't create a backlog of past instances.
 */
export function nextDueDate(
  recurrence: NonNullable<Todo['recurrence']>,
  dueDate: string | null,
  today: Temporal.PlainDate
): string {
  const due = dueDate ? Temporal.PlainDate.from(dueDate) : today
  const from = Temporal.PlainDate.compare(due, today) > 0 ? due : today
  if (recurrence.freq === 'daily') return from.add({ days: 1 }).toString()
  const days = recurrence.byWeekday?.length ? recurrence.byWeekday : [from.dayOfWeek]
  for (let i = 1; i <= 7; i++) {
    const d = from.add({ days: i })
    if (days.includes(d.dayOfWeek)) return d.toString()
  }
  return from.add({ weeks: 1 }).toString()
}

export function isOverdue(
  todo: Pick<Todo, 'done' | 'archived' | 'dueDate'>,
  today: Temporal.PlainDate
): boolean {
  return !todo.done && !todo.archived && !!todo.dueDate && todo.dueDate < today.toString()
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_WORD = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`

/**
 * A due date typed at the end of a quick todo: "Return books tomorrow", "Email Sam by fri",
 * "Hand in form on 3 Dec", "… next week" (next Monday), "… today". Returns the title without
 * it. A weekday means the next one (today counts only as "today"); a date already past this
 * year means next year's.
 */
export function parseQuickTodo(
  text: string,
  today: Temporal.PlainDate
): { title: string; dueDate: string | null } {
  const raw = text.trim()
  const lower = raw.toLowerCase()
  const end = (re: RegExp) => re.exec(lower)
  const result = (m: RegExpExecArray, date: Temporal.PlainDate | null) => {
    const title = raw.slice(0, m.index).trim()
    return date && title ? { title, dueDate: date.toString() } : { title: raw, dueDate: null }
  }
  const lead = String.raw`(?:^|\s)(?:(?:by|on|due|for)\s+)?`
  let m = end(new RegExp(`${lead}(today|tonight)$`))
  if (m) return result(m, today)
  m = end(new RegExp(`${lead}(tomorrow|tmrw|tmr)$`))
  if (m) return result(m, today.add({ days: 1 }))
  m = end(new RegExp(`${lead}next week$`))
  if (m) return result(m, today.add({ days: 8 - today.dayOfWeek }))
  m = end(
    new RegExp(
      `${lead}(?:next\\s+)?(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$`
    )
  )
  if (m) {
    const day = WEEKDAYS.indexOf(m[1].slice(0, 3)) + 1
    const ahead = (day - today.dayOfWeek + 7) % 7 || 7
    return result(m, today.add({ days: ahead }))
  }
  // "3 Dec", "3rd December", "Dec 3"
  m =
    end(new RegExp(`${lead}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORD}$`)) ??
    end(new RegExp(`${lead}${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?$`))
  if (m) {
    const dayFirst = /^\d/.test(m[1])
    const day = Number(dayFirst ? m[1] : m[2])
    const month = MONTHS.indexOf((dayFirst ? m[2] : m[1]).slice(0, 3)) + 1
    try {
      let date = Temporal.PlainDate.from({ year: today.year, month, day }, { overflow: 'reject' })
      if (Temporal.PlainDate.compare(date, today) < 0) date = date.add({ years: 1 })
      return result(m, date)
    } catch {
      return { title: raw, dueDate: null }
    }
  }
  return { title: raw, dueDate: null }
}
