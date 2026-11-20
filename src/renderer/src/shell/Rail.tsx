import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import {
  Bell,
  CircleExclamationPoint,
  FileText,
  Megaphone,
  MessageSquareText,
  Timer,
  X
} from 'lucide-react'
import type { NotificationItem } from '@shared/types'
import { useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { requestBriefPlan } from '../lib/files'
import { useBacklog, useNotifications } from '../lib/queries'
import { PAGES, type PageDef } from '../pages/registry'
import { toast } from '../ui/toastStore'
import { ExamSeasonButton } from './ExamSeasonButton'
import s from './Rail.module.css'

/** Ask the time-tracking dialogs to show any check-ins now (even ones put off with "Later"). */
export const OPEN_CHECKINS_EVENT = 'engram:open-checkins'

export function Rail() {
  const top = PAGES.filter((p) => p.placement === 'top')
  const bottom = PAGES.filter((p) => p.placement === 'bottom')
  const { data: backlog = [] } = useBacklog()

  return (
    <nav className={s.rail} aria-label="Main">
      {top.map((p) => (
        <RailLink key={p.id} page={p} badge={p.id === 'backlog' ? backlog.length : 0} />
      ))}
      <div className={s.spacer} />
      <ExamSeasonButton />
      <Notifications />
      {bottom.map((p) => (
        <RailLink key={p.id} page={p} />
      ))}
    </nav>
  )
}

function RailLink({ page, badge = 0 }: { page: PageDef; badge?: number }) {
  const Icon = page.icon
  return (
    <NavLink
      to={page.path}
      end={page.path === '/'}
      title={badge ? `${page.label} (${badge})` : page.label}
      aria-label={page.label}
      className={({ isActive }) => `${s.item} ${isActive ? s.active : ''}`}
    >
      <Icon size={18} strokeWidth={1.5} />
      {badge > 0 && <span className={`${s.badge} num`}>{badge > 99 ? '99+' : badge}</span>}
    </NavLink>
  )
}

const ICON: Record<NotificationItem['kind'], typeof Bell> = {
  debrief: MessageSquareText,
  checkin: Timer,
  'overdue-todo': CircleExclamationPoint,
  'moodle-brief': FileText,
  'moodle-forum': Megaphone
}

/** Pending debriefs, check-ins waiting, missed or overdue todos, and news from Moodle. */
function Notifications() {
  const [open, setOpen] = useState(false)
  const { data: items = [] } = useNotifications()
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()
  const dismiss = async (item: NotificationItem) => {
    if (item.kind === 'moodle-forum' && item.postId !== undefined)
      await call('moodle:dismissForumPost', item.postId)
    else await call('moodle:dismissBrief', item.key.replace(/^moodle-brief:/, ''))
    await qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const openPost = async (postId: number) => {
    try {
      if (!(await call('moodle:openForumPost', postId)))
        toast('This is a demo post, so there’s no page on Moodle to open.')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t open the post.', { tone: 'error' })
    }
    await qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const act = (item: NotificationItem) => {
    setOpen(false)
    if (item.kind === 'moodle-brief' && item.attachmentId) requestBriefPlan(item.attachmentId, null)
    else if (item.kind === 'moodle-forum' && item.postId !== undefined) void openPost(item.postId)
    else if (item.kind === 'checkin') window.dispatchEvent(new Event(OPEN_CHECKINS_EVENT))
    else if (item.kind === 'debrief' && item.blockId) navigate(`/?block=${item.blockId}`)
    else navigate('/backlog')
  }

  return (
    <div className={s.popoverAnchor} ref={ref}>
      <button
        className={s.item}
        title={items.length ? `Notifications (${items.length})` : 'Notifications'}
        aria-label={items.length ? `Notifications (${items.length})` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={18} strokeWidth={1.5} />
        {items.length > 0 && <span className={`${s.badge} num`}>{items.length}</span>}
      </button>
      {open && (
        <div className={s.popover} role="dialog" aria-label="Notifications">
          <div className={s.popoverTitle}>Notifications</div>
          {items.length === 0 && <p className={s.popoverEmpty}>Nothing needs you right now.</p>}
          <ul className={s.notes}>
            {items.map((n) => {
              const Icon = ICON[n.kind]
              return (
                <li key={n.key}>
                  <button className={s.note} data-kind={n.kind} onClick={() => act(n)}>
                    <Icon size={14} className={s.noteIcon} />
                    <span className={s.noteText}>
                      <span className={s.noteTitle}>{n.title}</span>
                      <span className={s.noteDetail}>{n.detail}</span>
                    </span>
                  </button>
                  {(n.kind === 'moodle-brief' || n.kind === 'moodle-forum') && (
                    <button
                      className={s.noteDismiss}
                      title={
                        n.kind === 'moodle-forum'
                          ? 'Dismiss (the post stays on Moodle)'
                          : 'Dismiss (the brief stays in the module’s files)'
                      }
                      aria-label={`Dismiss ${n.title}`}
                      onClick={() => void dismiss(n)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
