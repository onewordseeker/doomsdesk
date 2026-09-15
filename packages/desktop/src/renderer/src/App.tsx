import React, { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import Home from './pages/Home'
import Session from './pages/Session'

type Route = 'home' | 'session'
interface SessionState {
  peerId: string
  role: 'controller' | 'agent'
}

export default function App() {
  const [route, setRoute] = useState<Route>('home')
  const [session, setSession] = useState<SessionState | null>(null)

  useEffect(() => {
    // Check URL params — agent windows are opened with ?peer=xxx&role=agent
    const params = new URLSearchParams(window.location.search)
    const peer = params.get('peer')
    const role = params.get('role') as 'controller' | 'agent' | null
    if (peer && role) {
      setSession({ peerId: peer, role })
      setRoute('session')
      return // Don't set up listeners in the agent banner window
    }

    const unsubStart = listen<SessionState>('start-session', (e) => {
      setSession(e.payload)
      setRoute('session')
    })
    const unsubEnd = listen<void>('session-ended', () => {
      setRoute('home')
      setSession(null)
    })

    return () => {
      unsubStart.then((f) => f())
      unsubEnd.then((f) => f())
    }
  }, [])

  if (route === 'session' && session) {
    return (
      <Session
        peerId={session.peerId}
        role={session.role}
        onEnd={() => {
          setRoute('home')
          setSession(null)
        }}
      />
    )
  }
  return <Home />
}
