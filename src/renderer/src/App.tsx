import { useEffect } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { call, onEvent } from './lib/api'
import { useProfile } from './lib/queries'
import { remember } from './lib/remember'
import { useAssistant } from './assistant/store'
import { BriefPlanHost } from './pages/BriefPlanDialog'
import { PAGES } from './pages/registry'
import { ClaudePanel } from './shell/ClaudePanel'
import { Rail } from './shell/Rail'
import { TopBar } from './shell/TopBar'
import { TimeTracking } from './timer/TimeTracking'
import { ContextMenuHost } from './ui/ContextMenu'
import { ToastHost } from './ui/Toast'
import { PromptHost } from './ui/PromptHost'
import { useUndoShortcut } from './ui/useUndoShortcut'
import s from './App.module.css'

export function App() {
  const { state, toggle } = useAssistant()
  useOpenSetup()
  useRememberPage()
  useUndoShortcut()
  useMenuNavigation()

  // ⌘J toggles the Claude panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  return (
    <div className={s.app}>
      <TopBar claudeOpen={state.open} onToggleClaude={toggle} />
      <Rail />
      <div className={s.body}>
        <main className={s.main}>
          <Routes>
            {PAGES.map(({ id, path, component: Page }) => (
              <Route key={id} path={path} element={<Page />} />
            ))}
          </Routes>
        </main>
        <ClaudePanel />
      </div>
      <TimeTracking />
      <BriefPlanHost />
      <ContextMenuHost />
      <ToastHost />
      <PromptHost />
    </div>
  )
}

/** The menu bar asks for a page (Engram → Settings… ⌘,). */
function useMenuNavigation() {
  const navigate = useNavigate()
  useEffect(() => onEvent('app:navigate', (path) => navigate(path)), [navigate])
}

/** Keep the page that's open, so the next launch opens it again (main.tsx). Not the wizard. */
function useRememberPage() {
  const { pathname, search } = useLocation()
  useEffect(() => {
    if (pathname !== '/setup') remember('lastPage', pathname + search)
  }, [pathname, search])
}

/**
 * Real data that hasn't been set up yet opens the setup wizard, once per launch (so it can be
 * left to look around and opened again from Settings).
 */
function useOpenSetup() {
  const { data: profile } = useProfile()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { data: setup } = useQuery({
    queryKey: ['setup'],
    queryFn: () => call('setup:get'),
    enabled: profile?.active === 'real'
  })
  useEffect(() => {
    if (profile?.active !== 'real' || !setup || setup.completedAt || pathname === '/setup') return
    let shown = false
    try {
      shown = sessionStorage.getItem('setup.opened') === '1'
      sessionStorage.setItem('setup.opened', '1')
    } catch {
      // Storage unavailable: open it anyway.
    }
    if (!shown) navigate('/setup')
  }, [profile?.active, setup, pathname, navigate])
}
