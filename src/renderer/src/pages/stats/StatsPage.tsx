import { useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Temporal } from 'temporal-polyfill'
import type { StatsOverview, StatsRange } from '@shared/types'
import { formatMinutes } from '@core/time'
import { call } from '../../lib/api'
import { BLOCK_TYPE_ICON } from '../../lib/blockTypes'
import s from './Stats.module.css'

const RANGES: [StatsRange, string][] = [
  ['week', 'This week'],
  ['4w', '4 weeks'],
  ['12w', '12 weeks'],
  ['all', 'All time']
]
const RANGE_KEY = 'stats.range'

const TYPE_LABEL: Record<string, string> = {
  'write-up': 'Write-ups',
  'assignment-stage': 'Assignments',
  dissertation: 'Dissertation',
  review: 'Reviews',
  lecture: 'Lectures',
  practical: 'Practicals',
  workshop: 'Workshops',
  pbl: 'Problem-based learning',
  presentation: 'Presentations',
  assessment: 'Assessments',
  viva: 'Vivas',
  meeting: 'Meetings',
  other: 'Other'
}

const hours = (m: number) => formatMinutes(Math.round(m))
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0)

/** Hours per module and session type, weekly totals, planned vs actual, and estimates. */
export function StatsPage() {
  const [range, setRange] = useState<StatsRange>(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY) as StatsRange | null
      return v && RANGES.some(([r]) => r === v) ? v : '4w'
    } catch {
      return '4w'
    }
  })
  const { data } = useQuery({
    queryKey: ['stats', range],
    queryFn: () => call('stats:overview', range)
  })
  const choose = (r: StatsRange) => {
    setRange(r)
    try {
      localStorage.setItem(RANGE_KEY, r)
    } catch {
      // Not essential.
    }
  }

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>Stats</h1>
        <span className={s.spacer} />
        <div className={s.segmented} role="group" aria-label="Period">
          {RANGES.map(([r, label]) => (
            <button key={r} aria-pressed={range === r} onClick={() => choose(r)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {data &&
        (data.totalMinutes === 0 && data.weeks.every((w) => w.minutes === 0) ? (
          <p className={s.muted}>No time logged yet. Stats appear once sessions are logged.</p>
        ) : (
          <Overview data={data} />
        ))}
    </div>
  )
}

function Overview({ data }: { data: StatsOverview }) {
  const p = data.planned
  const target = data.weekTargetMinutes
  const est = data.estimates
  return (
    <>
      <div className={s.tiles}>
        <Tile label="Studied" value={hours(data.totalMinutes)} />
        <Tile
          label="Per week"
          value={hours(data.averagePerWeek)}
          note={target ? `target ${hours(target)}` : undefined}
        />
        <Tile
          label="Planned work done"
          value={p.blocks ? `${pct(p.done, p.blocks)}%` : '–'}
          note={p.blocks ? `${p.done} of ${p.blocks} blocks` : 'nothing planned yet'}
        />
        <Tile
          label="Estimates"
          value={est.ratio === null ? '–' : estimateWords(est.ratio).headline}
          note={est.ratio === null ? 'no finished stages yet' : estimateWords(est.ratio).note}
        />
      </div>

      <div className={s.grid}>
        <Card title="By module">
          <Bars
            rows={data.byModule.map((m) => ({
              key: m.categoryId ?? 'none',
              label: m.name,
              title: m.label,
              minutes: m.minutes,
              colour: m.colour
            }))}
            total={data.totalMinutes}
          />
        </Card>
        <Card title="By session type">
          <Bars
            rows={data.byType.map((t) => {
              const Icon = BLOCK_TYPE_ICON[t.type as keyof typeof BLOCK_TYPE_ICON]
              return {
                key: t.type,
                label: TYPE_LABEL[t.type] ?? t.type,
                title: TYPE_LABEL[t.type] ?? t.type,
                icon: Icon ? <Icon size={12} /> : null,
                minutes: t.minutes,
                colour: null
              }
            })}
            total={data.totalMinutes}
          />
        </Card>
        <Card title="Last 12 weeks" wide>
          <Weeks weeks={data.weeks} target={target} />
        </Card>
        <Card title="Planned vs done">
          <Outcomes planned={p} />
        </Card>
        <Card title="Estimates vs time taken">
          <Estimates est={est} />
        </Card>
      </div>
    </>
  )
}

function estimateWords(ratio: number) {
  const off = Math.round(Math.abs(ratio - 1) * 100)
  if (off < 5)
    return { headline: 'On target', note: 'finished stages took about as long as estimated' }
  return ratio > 1
    ? { headline: `+${off}%`, note: 'finished stages took longer than estimated' }
    : { headline: `−${off}%`, note: 'finished stages took less time than estimated' }
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={s.tile}>
      <div className={s.tileLabel}>{label}</div>
      <div className={`${s.tileValue} num`}>{value}</div>
      {note && <div className={s.tileNote}>{note}</div>}
    </div>
  )
}

function Card({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={s.card} data-wide={wide || undefined}>
      <h2 className={s.cardTitle}>{title}</h2>
      {children}
    </section>
  )
}

/** Horizontal bars: the label on the left, the value on the right, the colour for identity. */
function Bars({
  rows,
  total
}: {
  rows: {
    key: string
    label: string
    title: string
    icon?: ReactNode
    minutes: number
    colour: string | null
  }[]
  total: number
}) {
  if (!rows.length) return <p className={s.muted}>Nothing logged in this period.</p>
  const max = Math.max(...rows.map((r) => r.minutes))
  return (
    <ul className={s.bars}>
      {rows.map((r) => (
        <li
          key={r.key}
          className={s.barRow}
          title={`${r.title}: ${hours(r.minutes)} (${pct(r.minutes, total)}%)`}
        >
          <span className={s.barLabel}>
            {r.icon}
            {r.label}
          </span>
          <span className={s.barTrack}>
            <span
              className={s.bar}
              style={
                {
                  width: `${Math.max(1.5, (r.minutes / max) * 100)}%`,
                  '--bar': r.colour ?? 'var(--accent)'
                } as CSSProperties
              }
            />
          </span>
          <span className={`${s.barValue} num`}>{hours(r.minutes)}</span>
        </li>
      ))}
    </ul>
  )
}

/** One column per week, the target as a dashed line. */
function Weeks({ weeks, target }: { weeks: StatsOverview['weeks']; target: number | null }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(target ?? 0, ...weeks.map((w) => w.minutes), 60) * 1.1
  const label = (d: string) =>
    Temporal.PlainDate.from(d).toLocaleString('en-GB', { day: 'numeric', month: 'short' })
  return (
    <div className={s.weeks} onMouseLeave={() => setHover(null)}>
      <div className={s.plot}>
        {target !== null && (
          <div className={s.target} style={{ bottom: `${(target / max) * 100}%` }}>
            <span>Target {hours(target)}</span>
          </div>
        )}
        {weeks.map((w, i) => (
          <div
            key={w.weekStart}
            className={s.col}
            data-current={i === weeks.length - 1 || undefined}
            data-hover={hover === i || undefined}
            onMouseEnter={() => setHover(i)}
            aria-label={`Week of ${label(w.weekStart)}: ${hours(w.minutes)}`}
          >
            <div className={s.colBar} style={{ height: `${(w.minutes / max) * 100}%` }} />
            {hover === i && (
              <div className={s.tip}>
                <strong className="num">{hours(w.minutes)}</strong>
                <span>week of {label(w.weekStart)}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={s.axis}>
        {weeks.map((w, i) => (
          <span key={w.weekStart}>{i % 2 === weeks.length % 2 ? label(w.weekStart) : ''}</span>
        ))}
      </div>
    </div>
  )
}

/** How the planned blocks went, as one segmented bar with a legend. */
function Outcomes({ planned: p }: { planned: StatsOverview['planned'] }) {
  if (!p.blocks) return <p className={s.muted}>No planned work has ended in this period.</p>
  const parts = [
    { key: 'done', label: 'Done', n: p.done },
    { key: 'partial', label: 'Partly done', n: p.partial },
    { key: 'skipped', label: 'Skipped', n: p.skipped },
    { key: 'none', label: 'Not marked', n: p.unmarked }
  ].filter((x) => x.n > 0)
  return (
    <div className={s.outcomes}>
      <div
        className={s.stack}
        role="img"
        aria-label={parts.map((x) => `${x.label} ${x.n}`).join(', ')}
      >
        {parts.map((x) => (
          <span
            key={x.key}
            className={s.segment}
            data-outcome={x.key}
            style={{ flexGrow: x.n }}
            title={`${x.label}: ${x.n} (${pct(x.n, p.blocks)}%)`}
          />
        ))}
      </div>
      <ul className={s.legend}>
        {parts.map((x) => (
          <li key={x.key}>
            <span className={s.swatch} data-outcome={x.key} /> {x.label}{' '}
            <span className="num">{x.n}</span>
          </li>
        ))}
      </ul>
      <p className={s.muted}>
        <span className="num">{hours(p.loggedMinutes)}</span> logged against{' '}
        <span className="num">{hours(p.plannedMinutes)}</span> planned.
      </p>
    </div>
  )
}

function Estimates({ est }: { est: StatsOverview['estimates'] }) {
  if (!est.stages) {
    return <p className={s.muted}>Shown once assignment stages with logged time are ticked off.</p>
  }
  return (
    <table className={s.table}>
      <thead>
        <tr>
          <th>Stage</th>
          <th className="num">Estimate</th>
          <th className="num">Took</th>
        </tr>
      </thead>
      <tbody>
        {est.furthestOff.map((x) => (
          <tr key={`${x.assignment}/${x.stage}`}>
            <td>
              {x.stage}
              <span className={s.muted}> · {x.assignment}</span>
            </td>
            <td className="num">{hours(x.estimate)}</td>
            <td className="num" data-over={x.ratio > 1.15 || undefined}>
              {hours(x.logged)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
