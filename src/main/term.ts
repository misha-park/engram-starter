import { Temporal } from 'temporal-polyfill'
import { termTwoEnd } from '../core/term'
import { todayLocalDate, zoned } from '../core/time'
import type { TermStatus } from '../shared/types'
import type { Db } from './db/client'
import * as t from './db/schema'
import { eq } from 'drizzle-orm'
import { getSetting } from './repo'

// The exam-season reminder: shown on the rail once term 2 has ended. A demo-only setting
// pretends it has, so the button can be seen before then.

const SIMULATE_KEY = 'demo.simulateTermEnded'

export function termStatus(db: Db, now: Temporal.Instant, demo: boolean): TermStatus {
  const dates = db
    .select({ start: t.blocks.start })
    .from(t.lectures)
    .innerJoin(t.blocks, eq(t.lectures.blockId, t.blocks.id))
    .all()
    .map((r) => zoned(r.start).toPlainDate())
  const end = termTwoEnd(dates, todayLocalDate(now))
  const simulated = demo && getSetting<boolean>(db, SIMULATE_KEY) === true
  return {
    termTwoEnded: end !== null || simulated,
    lastLecture: end?.toString() ?? null,
    simulated
  }
}

export function setSimulateTermEnded(db: Db, on: boolean, demo: boolean): void {
  if (!demo) throw new Error('Only the demo can pretend term 2 has ended.')
  db.insert(t.settings)
    .values({ key: SIMULATE_KEY, value: on })
    .onConflictDoUpdate({ target: t.settings.key, set: { value: on } })
    .run()
}
