'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import { LevelMeter } from '@/components/LevelMeter'
import { Timecode, Transport } from '@/components/Transport'
import { WaveformTape } from '@/components/WaveformTape'
import { Button, Card, Notice, Pill, Row, Spinner } from '@/components/ui'
import { listInputs, talkbackHurtsQuality, type InputDevice } from '@/lib/audio/capture'
import { useStudio } from '@/lib/store/useStudio'
import { bytes } from '@/lib/util/format'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export default function StudioPage() {
  return (
    <Suspense fallback={<Centered><Spinner label="Opening the studio" /></Centered>}>
      <Studio />
    </Suspense>
  )
}

function Studio() {
  const params = useSearchParams()
  const code = (params.get('room') ?? '').toUpperCase()
  const { state, setup, record, stop, toggleTalkback, dismissWarning } = useStudio(code, BASE)
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (state.capture) void listInputs().then(setDevices)
  }, [state.capture])

  if (!code) {
    return (
      <Centered>
        <Notice tone="warn">No room code in the link. Go back and start or join a room.</Notice>
      </Centered>
    )
  }

  if (state.phase === 'error') {
    return (
      <Centered>
        <Notice tone="warn">{state.error}</Notice>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </Centered>
    )
  }

  if (state.phase === 'loading') {
    return <Centered><Spinner label="Finding the room" /></Centered>
  }

  const live = state.phase === 'recording'
  const friendName = state.remote?.name ?? 'Your friend'
  const bothPresent = Boolean(state.remote)

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '14px 16px 48px', display: 'grid', gap: 18 }}>
      <TopBar code={code} title={state.room?.name ?? 'Studio'} live={live} />

      <StatusStrip
        friendName={friendName}
        present={bothPresent}
        connected={state.dataChannelOpen}
        rttMs={state.clockRttMs}
        jitterMs={state.clockJitterMs}
        quality={state.capture?.report.path ?? 'unknown'}
        sampleRate={state.capture?.sampleRate ?? 0}
      />

      {state.phase === 'needs-mic' ? (
        <SetupCard onStart={() => setup(deviceId)} />
      ) : (
        <>
          <WaveformTape
            friend={state.friendEnvelope}
            mine={state.myEnvelope}
            positionSec={state.elapsedSec}
            live={live}
            friendName={friendName.toUpperCase()}
            myName={(state.myName || 'You').toUpperCase()}
            friendConnected={bothPresent}
            height={340}
          />

          {state.countdown !== null ? (
            <Countdown value={state.countdown} />
          ) : (
            <Timecode seconds={state.elapsedSec} live={live} />
          )}

          <Transport
            recording={live}
            armed={state.phase === 'armed'}
            playing={false}
            canRecord={state.phase === 'ready' && bothPresent}
            onRecord={() => void record()}
            onStop={stop}
            onPlayPause={() => undefined}
            onSkip={() => undefined}
            disabledReason={
              !bothPresent
                ? `Waiting for ${friendName} to join. Share the code ${code}.`
                : state.phase === 'finishing'
                  ? 'Finishing the take…'
                  : undefined
            }
          />

          <div style={{ display: 'grid', gap: 14 }}>
            <LevelMeter
              peak={state.friendLevel.peak}
              rms={state.friendLevel.rms}
              label={friendName}
              tone="friend"
            />
            <LevelMeter
              peak={state.myLevel.peak}
              rms={state.myLevel.rms}
              label="You"
              tone="mine"
              clipped={state.clipped}
            />
          </div>
        </>
      )}

      {state.qualityConflict && state.phase !== 'needs-mic' && (
        <Notice tone="info">
          On iPhone, playing your friend’s voice through the browser forces the microphone
          into call mode and costs you real quality.{' '}
          <button onClick={toggleTalkback} style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Mute talkback and use a phone call instead
          </button>
          {' '}for the best recording.
        </Notice>
      )}

      {state.warnings.map((warning) => (
        <Notice key={warning} tone="warn" onDismiss={() => dismissWarning(warning)}>
          {warning}
        </Notice>
      ))}

      {(state.phase === 'recording' || state.phase === 'finishing' || state.phase === 'done') && (
        <Card>
          <h2 className="slate" style={{ marginBottom: 10 }}>This take</h2>
          <Row label="Segments uploaded" value={`${state.upload.uploaded}`} />
          <Row label="Waiting to upload" value={`${state.upload.pending}`} tone={state.upload.pending > 4 ? 'warn' : 'default'} />
          <Row label="Sent" value={bytes(state.upload.bytesUploaded)} />
          {state.upload.failed > 0 && (
            <Row label="Failed" value={`${state.upload.failed}`} tone="warn" />
          )}
        </Card>
      )}

      {state.phase === 'done' && state.session && (
        <Card style={{ display: 'grid', gap: 14 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Take finished</h2>
          <p style={{ color: 'var(--label-secondary)', fontSize: 15 }}>
            Both stems are stored. Open the take to clean them up, drop your jingles in
            and export the synced mix.
          </p>
          <Button
            variant="primary"
            full
            onClick={() => { window.location.href = `${BASE}/episode/?id=${state.session?.id}` }}
          >
            Open the take
          </Button>
        </Card>
      )}

      {state.phase === 'ready' && devices.length > 1 && (
        <Card>
          <label htmlFor="device" className="slate" style={{ display: 'block', marginBottom: 10 }}>
            Microphone
          </label>
          <select
            id="device"
            value={deviceId ?? ''}
            onChange={(event) => {
              setDeviceId(event.target.value || undefined)
              void setup(event.target.value || undefined)
            }}
          >
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
            ))}
          </select>
        </Card>
      )}
    </main>
  )
}

function TopBar({ code, title, live }: { code: string; title: string; live: boolean }) {
  const [copied, setCopied] = useState(false)

  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <a href={`${BASE}/`} aria-label="Leave the studio" style={{ minHeight: 'var(--tap)', display: 'grid', placeItems: 'center', width: 44, color: 'var(--accent)' }}>
        ‹ 
      </a>

      <div style={{ textAlign: 'center', flex: 1 }}>
        <h1 style={{ fontSize: 17, fontWeight: 600 }}>{title}</h1>
        <button
          className="mono"
          onClick={async () => {
            await navigator.clipboard?.writeText(code).catch(() => undefined)
            setCopied(true)
            setTimeout(() => setCopied(false), 1800)
          }}
          aria-label={`Room code ${code.split('').join(' ')}. Copy it.`}
          style={{ fontSize: 13, color: 'var(--label-secondary)', letterSpacing: '0.18em' }}
        >
          {copied ? 'COPIED' : code}
        </button>
      </div>

      <div style={{ width: 44, display: 'grid', placeItems: 'center' }}>
        {live && <Pill tone="live">REC</Pill>}
      </div>
    </header>
  )
}

function StatusStrip({
  friendName, present, connected, rttMs, jitterMs, quality, sampleRate,
}: {
  friendName: string
  present: boolean
  connected: boolean
  rttMs: number | null
  jitterMs: number | null
  quality: 'raw' | 'processed' | 'unknown'
  sampleRate: number
}) {
  const syncTone = jitterMs === null ? 'neutral' : jitterMs < 8 ? 'good' : 'warn'

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Pill tone={present ? 'good' : 'neutral'}>
        {present ? `${friendName} here` : 'Waiting for your friend'}
      </Pill>
      {present && (
        <Pill tone={connected ? 'good' : 'warn'}>
          {connected ? 'Direct link' : 'Relayed'}
        </Pill>
      )}
      {rttMs !== null && Number.isFinite(rttMs) && (
        <Pill tone={syncTone}>
          Sync ±{(jitterMs ?? 0).toFixed(1)}ms
        </Pill>
      )}
      {sampleRate > 0 && (
        <Pill tone={quality === 'raw' ? 'good' : 'warn'}>
          {quality === 'raw' ? `Raw ${(sampleRate / 1000).toFixed(1)}k` : 'Processed'}
        </Pill>
      )}
    </div>
  )
}

function SetupCard({ onStart }: { onStart(): void }) {
  return (
    <Card style={{ display: 'grid', gap: 16 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600 }}>Ready when you are</h2>
      <p style={{ color: 'var(--label-secondary)', fontSize: 15, lineHeight: 1.5 }}>
        podstart needs your microphone. It records the raw signal — no call-style
        noise reduction — and cleans it up afterwards, which is the only way to keep
        a good microphone sounding good.
      </p>
      {talkbackHurtsQuality() && (
        <p style={{ color: 'var(--label-secondary)', fontSize: 14 }}>
          You’re on iPhone: keep this screen awake and in front while recording.
        </p>
      )}
      <Button variant="primary" full onClick={onStart}>Allow microphone</Button>
    </Card>
  )
}

function Countdown({ value }: { value: number }) {
  return (
    <div
      role="status"
      aria-live="assertive"
      className="mono"
      style={{
        textAlign: 'center',
        fontSize: 'clamp(44px, 14vw, 64px)',
        fontWeight: 300,
        color: 'var(--record)',
      }}
    >
      {value > 0 ? value : 'GO'}
      <span className="sr-only">Recording starts in {value} seconds</span>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '70dvh', display: 'grid', placeContent: 'center', gap: 20, padding: 24, maxWidth: 480, margin: '0 auto' }}>
      {children}
    </main>
  )
}
