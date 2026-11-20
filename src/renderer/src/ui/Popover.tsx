/**
 * A small popover drawn over the page (in a portal), under the element it belongs to. Use it
 * when the anchor sits inside something that clips (`overflow: hidden`), such as a one-line
 * table cell. It follows its anchor when the page scrolls, and closes on Escape or a click
 * outside.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import s from './Popover.module.css'

interface Props {
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  ariaLabel?: string
}

export function Popover({ anchor, onClose, children, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    // Under the anchor, kept on screen (above it when there's no room below).
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const el = ref.current
      if (!a || !el) return
      const { width, height } = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8))
      const below = a.bottom + 4
      const top = below + height > window.innerHeight - 8 ? Math.max(8, a.top - 4 - height) : below
      setPos({ left, top })
    }
    place()
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Scrolling (the page, or the clipped line the anchor sits in) moves the anchor.
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) place()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={ref}
      className={s.popover}
      role="dialog"
      aria-label={ariaLabel}
      style={pos ?? { visibility: 'hidden', left: 0, top: 0 }}
    >
      {children}
    </div>,
    document.body
  )
}
