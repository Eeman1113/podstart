'use client'

import { useCallback, useState } from 'react'

import { Button, Card, Notice, Pill, Spinner } from '@/components/ui'
import { isIOS, openMicrophone } from '@/lib/audio/capture'
import { measureLoudness } from '@/lib/dsp/loudness'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

/**
 * Device check.
 *
 * Run this on a phone BEFORE an episode, not after. It exercises every piece
 * the recording depends on -- the worklet, the encoder worker, local storage,
 * the denoiser, the clock APIs -- and says plainly which ones this particular
 * browser will actually do. Most remote-recording disasters are a capability
 * that was missing all along and only announced itself at the end.
 */

type Status = 'pass' | 'warn' | 'fail' | 'running' | 'idle'

interface Check {
  id: string
  name: string
  status: Status
  detail: string
}

const INITIAL: Check[] = [
  { id: 'secure', name: 'Secure context', status: 'idle', detail: '' },
  { id: 'worklet', name: 'Audio worklet', status: 'idle', detail: '' },
  { id: 'clock', name: 'Sample-accurate clock', status: 'idle', detail: '' },
  { id: 'opfs', name: 'Local lossless copy', status: 'idle', detail: '' },
  { id: 'flac', name: 'FLAC encoder', status: 'idle', detail: '' },
  { id: 'dsp', name: 'Cleanup engine', status: 'idle', detail: '' },
  { id: 'rnnoise', name: 'Neural denoiser', status: 'idle', detail: '' },
  { id: 'rtc', name: 'Peer connection', status: 'idle', detail: '' },
  { id: 'wake', name: 'Keep screen awake', status: 'idle', detail: '' },
  { id: 'mic', name: 'Raw microphone', status: 'idle', detail: '' },
]

export default function CheckPage() {
  const [checks, setChecks] = useState<Check[]>(INITIAL)
  const [running, setRunning] = useState(false)

  const set = useCallback((id: string, status: Status, detail: string) => {
    setChecks((previous) => previous.map((c) => (c.id === id ? { ...c, status, detail } : c)))
  }, [])

  const run = useCallback(async () => {
    setRunning(true)
    setChecks(INITIAL.map((c) => ({ ...c, status: 'running', detail: '' })))

    // ---------------------------------------------------------- secure context
    set(
      'secure',
      window.isSecureContext ? 'pass' : 'fail',
      window.isSecureContext
        ? 'https or localhost, so the microphone is allowed'
        : 'Microphones only work over https. Open this page over https.',
    )

    // ----------------------------------------------------------------- worklet
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext({ sampleRate: 48000 })
      await ctx.audioWorklet.addModule(`${BASE}/worklets/capture.js`)
      set('worklet', 'pass', `Loaded. Context running at ${ctx.sampleRate} Hz.`)
    } catch (error) {
      set('worklet', 'fail', message(error))
    }

    // ------------------------------------------------------------------- clock
    try {
      const timestamp = ctx?.getOutputTimestamp?.()
      if (timestamp && typeof timestamp.performanceTime === 'number') {
        set('clock', 'pass', 'getOutputTimestamp available: sync will be sample-accurate.')
      } else {
        set(
          'clock',
          'warn',
          'No getOutputTimestamp. Sync falls back to clock sampling, usually within a few ms.',
        )
      }
    } catch (error) {
      set('clock', 'warn', message(error))
    }

    // --------------------------------------- recorder worker: OPFS and FLAC
    // Both are probed by booting the REAL recorder worker rather than by
    // feature-testing here. Synchronous access handles are only exposed inside
    // a worker, so a main-thread check reports a failure that does not exist.
    try {
      const result = await probeRecorderWorker()

      const estimate = await navigator.storage.estimate()
      const free = estimate.quota ? Math.round((estimate.quota - (estimate.usage ?? 0)) / 1e9) : null
      set(
        'opfs',
        result.hasLocalCopy ? 'pass' : 'warn',
        result.hasLocalCopy
          ? free !== null
            ? `Working. About ${free} GB free — roughly ${Math.floor(free * 2)} hours of lossless audio.`
            : 'Working: every take keeps a lossless copy on this device.'
          : 'No local safety copy on this browser. Recording still works, but the upload ' +
            'becomes the only copy.',
      )

      set(
        'flac',
        result.codec === 'flac' ? 'pass' : 'warn',
        result.codec === 'flac'
          ? 'FLAC available: stems upload at about half the size, losslessly.'
          : 'FLAC unavailable; stems upload as WAV. Lossless either way, just larger.',
      )
    } catch (error) {
      set('opfs', 'fail', message(error))
      set('flac', 'fail', message(error))
    }

    // ---------------------------------------------------------- cleanup engine
    try {
      const { lufs, elapsedMs, engine } = await probeDspWorker()
      set(
        'dsp',
        'pass',
        `Worker ran a full cleanup pass in ${elapsedMs} ms (measured ${lufs.toFixed(1)} LUFS).`,
      )
      set(
        'rnnoise',
        engine === 'neural' ? 'pass' : 'warn',
        engine === 'neural'
          ? 'RNNoise loaded.'
          : 'RNNoise did not load; the spectral denoiser will be used instead.',
      )
    } catch (error) {
      set('dsp', 'fail', message(error))
      set('rnnoise', 'fail', 'Not reached.')
    }

    // ------------------------------------------------------------------- WebRTC
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pc.createDataChannel('probe')
      await pc.setLocalDescription(await pc.createOffer())
      const reachable = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000)
        pc.onicecandidate = ({ candidate }) => {
          if (candidate && /typ (srflx|relay)/.test(candidate.candidate)) {
            clearTimeout(timer)
            resolve(true)
          }
        }
      })
      pc.close()
      set(
        'rtc',
        reachable ? 'pass' : 'warn',
        reachable
          ? 'A direct peer connection is reachable from this network.'
          : 'No public candidate found. Talkback may relay or fail — recording is unaffected.',
      )
    } catch (error) {
      set('rtc', 'warn', message(error))
    }

    // ---------------------------------------------------------------- wake lock
    if ('wakeLock' in navigator) {
      try {
        const lock = await navigator.wakeLock.request('screen')
        await lock.release()
        set('wake', 'pass', 'The screen can be held awake during a take.')
      } catch (error) {
        set('wake', 'warn', message(error))
      }
    } else {
      set('wake', 'warn', 'Not supported. Keep the screen on manually, or the recording stops.')
    }

    // ------------------------------------------------------------------- mic
    try {
      const capture = await openMicrophone()
      const raw = capture.report.path === 'raw'
      set(
        'mic',
        raw ? 'pass' : 'warn',
        `${capture.report.deviceLabel} · ${capture.report.sampleRate} Hz · ` +
          (raw
            ? 'raw capture, browser voice processing defeated'
            : 'this browser insists on its call processing, so quality is capped'),
      )
      capture.stop()
    } catch (error) {
      set('mic', 'fail', message(error))
    }

    await ctx?.close().catch(() => undefined)
    setRunning(false)
  }, [set])

  const failed = checks.filter((c) => c.status === 'fail').length
  const warned = checks.filter((c) => c.status === 'warn').length
  const done = checks.every((c) => c.status !== 'idle' && c.status !== 'running')

  return (
    <main style={{ maxWidth: 620, margin: '0 auto', padding: '32px 18px 64px', display: 'grid', gap: 20 }}>
      <header style={{ display: 'grid', gap: 8 }}>
        <span className="slate">Before you record</span>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>Device check</h1>
        <p style={{ color: 'var(--label-secondary)', fontSize: 16 }}>
          Run this on the phone you are going to record on. It takes about ten seconds and
          tells you what this browser will actually do, before it matters.
        </p>
      </header>

      {isIOS() && (
        <Notice tone="info">
          On iPhone, keep Safari in the foreground and the screen awake for the whole take.
          A backgrounded tab stops recording and there is no way for a web page to prevent it.
        </Notice>
      )}

      <Button variant="primary" full onClick={() => void run()} disabled={running}>
        {running ? 'Checking…' : 'Run the check'}
      </Button>

      {done && (
        <Notice tone={failed > 0 ? 'warn' : warned > 0 ? 'info' : 'good'}>
          {failed > 0
            ? `${failed} thing${failed > 1 ? 's' : ''} will stop a recording working here.`
            : warned > 0
              ? `Everything essential works. ${warned} thing${warned > 1 ? 's are' : ' is'} degraded — see below.`
              : 'Everything works. This device will record at full quality.'}
        </Notice>
      )}

      <Card style={{ display: 'grid', gap: 2 }}>
        {checks.map((check) => (
          <div
            key={check.id}
            style={{
              display: 'grid',
              gap: 4,
              padding: '13px 0',
              borderBottom: '1px solid var(--separator)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 16 }}>{check.name}</span>
              <StatusPill status={check.status} />
            </div>
            {check.detail && (
              <span style={{ fontSize: 14, color: 'var(--label-secondary)', lineHeight: 1.45 }}>
                {check.detail}
              </span>
            )}
          </div>
        ))}
      </Card>

      <a href={`${BASE}/`} style={{ fontSize: 15 }}>‹ Back to podstart</a>
    </main>
  )
}

function StatusPill({ status }: { status: Status }) {
  if (status === 'running') return <Spinner label="" />
  if (status === 'idle') return <Pill>Not run</Pill>
  if (status === 'pass') return <Pill tone="good">Pass</Pill>
  if (status === 'warn') return <Pill tone="warn">Degraded</Pill>
  return <Pill tone="live">Fail</Pill>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Boots the real recorder worker and reports what it found.
 *
 * This is deliberately the production worker, not a reimplementation: the only
 * answer worth having is what the thing that records you will actually do.
 */
function probeRecorderWorker(): Promise<{ codec: string; hasLocalCopy: boolean }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`${BASE}/workers/recorder.js`)
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error('The recorder worker did not respond within 15 seconds.'))
    }, 15000)

    worker.onmessage = (event) => {
      if (event.data?.type !== 'ready') return
      clearTimeout(timer)
      const { codec, hasLocalCopy } = event.data
      worker.postMessage({ type: 'discard-local', trackId: 'device-check' })
      setTimeout(() => worker.terminate(), 200)
      resolve({ codec, hasLocalCopy: Boolean(hasLocalCopy) })
    }
    worker.onerror = (event) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error(event.message || 'The recorder worker failed to start.'))
    }

    worker.postMessage({
      type: 'init',
      basePath: BASE,
      trackId: 'device-check',
      sampleRate: 48000,
      channels: 1,
      bitsPerSample: 24,
      segmentSeconds: 30,
      codec: 'flac',
    })
  })
}

/**
 * Runs the genuine cleanup chain over two seconds of synthetic speech-like
 * noise. This is the check that proves the worker bundled and loaded, which is
 * the one failure that would otherwise only appear after an episode.
 */
function probeDspWorker(): Promise<{ lufs: number; elapsedMs: number; engine: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../lib/dsp/dsp.worker.ts', import.meta.url))
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error('The cleanup worker did not respond within 30 seconds.'))
    }, 30000)

    const sampleRate = 48000
    const samples = new Float32Array(sampleRate * 2)
    for (let i = 0; i < samples.length; i += 1) {
      const t = i / sampleRate
      // A tone with an envelope, plus hiss: something the chain can actually act on.
      const voice = Math.sin(2 * Math.PI * 180 * t) * (0.3 + 0.25 * Math.sin(2 * Math.PI * 3 * t))
      samples[i] = voice * 0.5 + (Math.random() - 0.5) * 0.02
    }

    const startedAt = Date.now()

    worker.onmessage = (event) => {
      const data = event.data
      if (data.type === 'error') {
        clearTimeout(timer)
        worker.terminate()
        reject(new Error(data.message))
        return
      }
      if (data.type !== 'cleaned') return

      clearTimeout(timer)
      const cleaned = new Float32Array(data.samples)
      const loudness = measureLoudness(cleaned, sampleRate)
      worker.terminate()
      resolve({
        lufs: loudness.lufs,
        elapsedMs: Date.now() - startedAt,
        engine: data.report.engineUsed,
      })
    }

    worker.onerror = (event) => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error(event.message || 'The cleanup worker failed to load.'))
    }

    worker.postMessage(
      {
        type: 'cleanup',
        jobId: 'device-check',
        samples: samples.buffer,
        sampleRate,
        basePath: BASE,
        settings: {
          denoise: 0.85, dereverb: 0.6, deEss: 0.4, highpassHz: 80,
          declick: true, targetLufs: -16, engine: 'neural',
        },
      },
      [samples.buffer],
    )
  })
}
