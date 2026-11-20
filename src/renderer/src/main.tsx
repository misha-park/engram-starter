import './theme/tokens.css'
import './theme/base.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter } from 'react-router'
import { App } from './App'
import { AssistantProvider } from './assistant/AssistantContext'
import { onEvent } from './lib/api'
import { WithProfile } from './WithProfile'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } }
})

// Main tells us when data changed outside our own mutations (reset, the assistant; sync later).
onEvent('data:changed', () => queryClient.invalidateQueries())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WithProfile>
        <HashRouter>
          <AssistantProvider>
            <App />
          </AssistantProvider>
        </HashRouter>
      </WithProfile>
    </QueryClientProvider>
  </StrictMode>
)
