import type { ReactNode } from 'react'
import { useProfile } from './lib/queries'
import { startRemembering } from './lib/remember'

/**
 * Waits for the active profile (one quick call) so what's remembered per profile (lib/remember)
 * is read from the right one, and the last page is reopened before the router reads the address.
 */
export function WithProfile({ children }: { children: ReactNode }) {
  const { data: profile } = useProfile()
  if (!profile) return null
  startRemembering(profile.active)
  return children
}
