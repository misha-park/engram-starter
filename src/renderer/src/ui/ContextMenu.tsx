/** The right-click menu itself (opened with `openContextMenu` from './menuStore'). */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { toast } from './toastStore'
import {
  closeContextMenu,
  currentMenu,
  subscribeMenu,
  type MenuItem,
  type OpenMenu
} from './menuStore'
import s from './ContextMenu.module.css'

export function ContextMenuHost() {
  const menu = useSyncExternalStore(subscribeMenu, currentMenu)
  if (!menu) return null
  return createPortal(<Menu key={`${menu.x},${menu.y}`} menu={menu} />, document.body)
}

function Menu({ menu }: { menu: OpenMenu }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  const [asking, setAsking] = useState<MenuItem | null>(null)
  const items = menu.entries.filter((x): x is MenuItem => typeof x === 'object' && 'label' in x)
  const [active, setActive] = useState(-1)

  // Keep it on screen: flip left or up when it would run off the edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = menu.x + width > window.innerWidth - 8 ? Math.max(8, menu.x - width) : menu.x
    const top = menu.y + height > window.innerHeight - 8 ? Math.max(8, menu.y - height) : menu.y
    setPos({ left, top })
  }, [menu, asking])

  const run = async (item: MenuItem) => {
    if (item.disabled) return
    if (item.confirm && asking !== item) {
      setAsking(item)
      return
    }
    closeContextMenu()
    try {
      await item.onSelect()
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(e),
        { tone: 'error' }
      )
    }
  }

  useEffect(() => {
    const close = () => closeContextMenu()
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (asking) setAsking(null)
        else closeContextMenu()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => {
          let next = i
          for (let n = 0; n < items.length; n++) {
            next = (next + step + items.length) % items.length
            if (!items[next].disabled) return next
          }
          return i
        })
      } else if (e.key === 'Enter' && active >= 0 && !asking) {
        e.preventDefault()
        void run(items[active])
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  })

  return (
    <div
      ref={ref}
      className={s.menu}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {asking ? (
        <div className={s.confirm}>
          <div className={s.question}>{asking.confirm}</div>
          <div className={s.confirmActions}>
            <button className={s.cancel} onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button
              className={asking.danger ? s.dangerButton : s.okButton}
              autoFocus
              onClick={() => void run(asking)}
            >
              {asking.label.replace(/…$/, '')}
            </button>
          </div>
        </div>
      ) : (
        menu.entries.map((entry, i) => {
          if (entry === 'separator') return <div key={i} className={s.separator} />
          if ('heading' in entry)
            return (
              <div key={i} className={s.heading}>
                {entry.heading}
              </div>
            )
          const Icon = entry.icon
          const index = items.indexOf(entry)
          return (
            <button
              key={i}
              role="menuitem"
              className={s.item}
              data-danger={entry.danger || undefined}
              data-active={index === active || undefined}
              disabled={entry.disabled}
              onMouseEnter={() => setActive(index)}
              onClick={() => void run(entry)}
            >
              <span className={s.icon}>{Icon && <Icon size={14} />}</span>
              <span className={s.label}>{entry.label}</span>
              {entry.hint && <span className={s.hint}>{entry.hint}</span>}
            </button>
          )
        })
      )}
    </div>
  )
}
