'use client'

import { useEffect, useState } from 'react'

import { Button, Card, Notice, Spinner } from '@/components/ui'
import { createRoom, joinRoom, myRooms, setDisplayName } from '@/lib/store/db'
import { ensureSignedIn, isConfigured } from '@/lib/supabase/client'
import type { Room } from '@/lib/supabase/types'

/**
 * The front door.
 *
 * One decision: start a room or join one. Everything else -- microphone
 * permission, sign-in, device choice -- is deferred until the studio, where it
 * is in context. Nobody should have to make an account before they find out
 * whether the app works.
 */
export default function Home() {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [rooms, setRooms] = useState<Room[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const configured = isConfigured()

  useEffect(() => {
    setName(localStorage.getItem('podstart:name') ?? '')
    if (!configured) return
    void (async () => {
      try {
        await ensureSignedIn()
        setRooms(await myRooms())
      } catch {
        // Not fatal: the landing page still works, you just see no history.
      }
    })()
  }, [configured])

  const remember = (value: string) => {
    setName(value)
    localStorage.setItem('podstart:name', value)
  }

  const start = async () => {
    setError(null)
    setBusy('Creating the room')
    try {
      await ensureSignedIn(name || 'Host')
      if (name) await setDisplayName(name)
      const room = await createRoom(`${name || 'Our'} show`)
      window.location.href = `./studio/?room=${room.code}`
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(null)
    }
  }

  const join = async () => {
    setError(null)
    const cleaned = code.trim().toUpperCase()
    if (cleaned.length !== 6) {
      setError('A room code is six characters, like 7KQW2M.')
      return
    }
    setBusy('Joining')
    try {
      await ensureSignedIn(name || 'Guest')
      if (name) await setDisplayName(name)
      const room = await joinRoom(cleaned)
      window.location.href = `./studio/?room=${room.code}`
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(null)
    }
  }

  return (
    <main
      style={{
        maxWidth: 560,
        margin: '0 auto',
        padding: '48px 20px 64px',
        display: 'grid',
        gap: 28,
      }}
    >
      <header style={{ display: 'grid', gap: 10 }}>
        <span className="slate">Remote recording</span>
        <h1 style={{ fontSize: 'clamp(34px, 9vw, 46px)', fontWeight: 700, letterSpacing: '-0.03em' }}>
          podstart
        </h1>
        <p style={{ fontSize: 17, color: 'var(--label-secondary)', maxWidth: '38ch' }}>
          You both press record once. Each end records itself at full quality, so the
          distance between you never touches the audio. Stop, and the synced mix is
          already made.
        </p>
      </header>

      {!configured && (
        <Notice tone="warn">
          Supabase is not configured yet. Copy <code>.env.example</code> to{' '}
          <code>.env.local</code> and add your project URL and anon key — see the README
          for the two-minute setup.
        </Notice>
      )}

      {error && <Notice tone="warn" onDismiss={() => setError(null)}>{error}</Notice>}

      <Card style={{ display: 'grid', gap: 16 }}>
        <label htmlFor="name" style={{ fontSize: 15, color: 'var(--label-secondary)' }}>
          What should your friend see you called?
        </label>
        <input
          id="name"
          value={name}
          onChange={(event) => remember(event.target.value)}
          placeholder="Your name"
          autoComplete="nickname"
          enterKeyHint="done"
        />

        {busy ? (
          <Spinner label={busy} />
        ) : (
          <Button variant="primary" full onClick={start} disabled={!configured}>
            Start a room
          </Button>
        )}
      </Card>

      <Card style={{ display: 'grid', gap: 16 }}>
        <label htmlFor="code" style={{ fontSize: 15, color: 'var(--label-secondary)' }}>
          Joining your friend? Enter their six-character code.
        </label>
        <input
          id="code"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 6))}
          placeholder="7KQW2M"
          className="mono"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          enterKeyHint="go"
          inputMode="text"
          style={{ fontSize: 24, letterSpacing: '0.22em', textAlign: 'center' }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void join()
          }}
        />
        <Button full onClick={join} disabled={!configured || busy !== null}>
          Join room
        </Button>
      </Card>

      {rooms.length > 0 && (
        <Card style={{ display: 'grid', gap: 4 }}>
          <h2 className="slate" style={{ marginBottom: 8 }}>Your rooms</h2>
          {rooms.map((room) => (
            <a
              key={room.id}
              href={`./studio/?room=${room.code}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '13px 0',
                borderBottom: '1px solid var(--separator)',
                color: 'var(--label)',
                minHeight: 'var(--tap)',
              }}
            >
              <span>{room.name}</span>
              <span className="mono" style={{ color: 'var(--label-secondary)', letterSpacing: '0.1em' }}>
                {room.code}
              </span>
            </a>
          ))}
        </Card>
      )}

      <footer style={{ fontSize: 13, color: 'var(--label-tertiary)', lineHeight: 1.6, display: 'grid', gap: 12 }}>
        <p>
          Best results: both of you in headphones, in the smallest soft room you have.
          Headphones are not a nicety — they are what stops each microphone recording
          the other person, which no amount of processing fully undoes.
        </p>
        <p>
          First time on a device?{' '}
          <a href="./check/">Run the device check</a> — it takes ten seconds and tells you
          what that browser will actually do, before an episode depends on it.
        </p>
      </footer>
    </main>
  )
}
