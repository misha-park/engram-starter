import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import s from './SidePanel.module.css'

/** A panel that slides in from the right for occasional things (settings, mappings). */
export function SidePanel({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={s.backdrop} onMouseDown={onClose}>
      <aside
        className={s.panel}
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.header}>
          <h2 className={s.title}>{title}</h2>
          <button className={s.close} onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <div className={s.body}>{children}</div>
      </aside>
    </div>
  )
}
