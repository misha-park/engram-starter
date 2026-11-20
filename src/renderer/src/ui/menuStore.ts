import type { LucideIcon } from 'lucide-react'

/**
 * Right-click menus. Anything can open one with `openContextMenu(event, entries)`; the one
 * `ContextMenuHost` (in App) draws it at the pointer. An item that fails shows its error as a
 * toast. A `confirm` item asks once more, in the menu, before it runs.
 */
export interface MenuItem {
  label: string
  icon?: LucideIcon
  onSelect: () => unknown
  danger?: boolean
  disabled?: boolean
  /** Ask before running: the question shown in the menu, e.g. "Delete this event?" */
  confirm?: string
  /** A short hint on the right, e.g. a shortcut or the target date. */
  hint?: string
}
export type MenuEntry = MenuItem | 'separator' | { heading: string } | null | false | undefined | ''

export interface OpenMenu {
  x: number
  y: number
  entries: (MenuItem | 'separator' | { heading: string })[]
}

let current: OpenMenu | null = null
const listeners = new Set<() => void>()
const set = (next: OpenMenu | null) => {
  current = next
  listeners.forEach((l) => l())
}

export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
  entries: MenuEntry[]
) {
  e.preventDefault()
  e.stopPropagation()
  const clean = entries.filter((x): x is MenuItem | 'separator' | { heading: string } => !!x)
  // No separators at the ends or next to each other.
  const tidy = clean.filter(
    (x, i, all) => x !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'separator')
  )
  if (!tidy.some((x) => typeof x === 'object' && 'label' in x)) return
  set({ x: e.clientX, y: e.clientY, entries: tidy })
}

export function closeContextMenu() {
  set(null)
}

export function subscribeMenu(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const currentMenu = () => current
