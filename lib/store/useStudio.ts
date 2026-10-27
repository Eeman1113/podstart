'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { EnvelopeTrack } from '@/lib/audio/envelope'
import { openMicrophone, talkbackHurtsQuality, type Capture } from '@/lib/audio/capture'
import { Recorder } from '@/lib/audio/recorder'
import { Room, type RemotePresence, type RemoteStatus } from '@/lib/room/room'
import { SegmentUploader, type UploadProgress } from '@/lib/store/uploads'
import { createSession, createTrack, joinRoom, roomByCode, updateSession, updateTrack } from '@/lib/store/db'
import { ensureSignedIn, supabase } from '@/lib/supabase/client'
import type { ProcessingMode, Room as RoomRow, Session } from '@/lib/supabase/types'

/**
 * Everything the studio screen does, in one hook.
 *
 * The ordering rules that matter are all here:
 *
 *  - the recorder is fully prepared BEFORE the countdown, so starting costs a
 *    postMessage rather than a buffer allocation;
 *  - the clock is re-measured immediately before every downbeat, because an
 *    offset measured ten minutes ago is a guess;
 *  - stopping waits for the upload queue to drain before the take is marked
 *    finished, and never blocks on it longer than it should.
 */

export type StudioPhase =
  | 'loading' | 'needs-mic' | 'ready' | 'armed' | 'recording' | 'finishing' | 'done' | 'error'

export interface StudioState {
  phase: StudioPhase
  room: RoomRow | null
  session: Session | null
  isHost: boolean
  myName: string
  remote: RemotePresence | null
  remoteStatus: RemoteStatus | null
  capture: Capture | null
  elapsedSec: number
  countdown: number | null
  myEnvelope: EnvelopeTrack
  friendEnvelope: EnvelopeTrack
  myLevel: { peak: number; rms: number }
  friendLevel: { peak: number; rms: number }
  clipped: boolean
  upload: UploadProgress
  clockOffsetMs: number
  clockRttMs: number | null
  clockJitterMs: number | null
  dataChannelOpen: boolean
  warnings: string[]
  error: string | null
  talkbackMuted: boolean
  qualityConflict: boolean
  /**
   * Chosen before the take and recorded on it. Raw means nothing will ever be
   * applied to these samples, in the studio or afterwards.
   */
  processing: ProcessingMode
  /** True once the lossless local file exists and can be saved to disk. */
  hasLocalCopy: boolean
}

const EMPTY_UPLOAD: UploadProgress = { uploaded: 0, pending: 0, failed: 0, bytesUploaded: 0 }

export function useStudio(roomCode: string, basePath: string) {
  const [room, setRoom] = useState<RoomRow | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [phase, setPhase] = useState<StudioPhase>('loading')
  const [isHost, setIsHost] = useState(false)
  const [myName, setMyName] = useState('You')
  const [remote, setRemote] = useState<RemotePresence | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [myLevel, setMyLevel] = useState({ peak: 0, rms: 0 })
  const [friendLevel, setFriendLevel] = useState({ peak: 0, rms: 0 })
  const [clipped, setClipped] = useState(false)
  const [upload, setUpload] = useState<UploadProgress>(EMPTY_UPLOAD)
  const [clock, setClock] = useState<{ offset: number; rtt: number | null; jitter: number | null }>({
    offset: 0, rtt: null, jitter: null,
  })
  const [dataChannelOpen, setDataChannelOpen] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [talkbackMuted, setTalkbackMuted] = useState(false)
  const [processing, setProcessing] = useState<ProcessingMode>('clean')
  const [hasLocalCopy, setHasLocalCopy] = useState(false)

  const myEnvelope = useMemo(() => new EnvelopeTrack(), [])
  const friendEnvelope = useMemo(() => new EnvelopeTrack(), [])

  const roomRef = useRef<Room | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  const uploaderRef = useRef<SegmentUploader | null>(null)
  const trackIdRef = useRef<string | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const startEpochRef = useRef(0)
  const userIdRef = useRef<string | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)

  const warn = useCallback((message: string) => {
    setWarnings((previous) => (previous.includes(message) ? previous : [...previous, message]))
  }, [])

  // -------------------------------------------------------------- room setup

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const storedName = localStorage.getItem('podstart:name') || 'You'
        setMyName(storedName)
        if (localStorage.getItem('podstart:processing') === 'raw') setProcessing('raw')

        const userId = await ensureSignedIn(storedName)
        userIdRef.current = userId

        let found = await roomByCode(roomCode)
        if (!found) found = await joinRoom(roomCode)
        if (cancelled) return

        setRoom(found)
        setIsHost(found.owner_id === userId)
        setPhase('needs-mic')
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
          setPhase('error')
        }
      }
    })()

    return () => { cancelled = true }
  }, [roomCode])

  // ------------------------------------------------------- microphone + peer

  const setup = useCallback(
    async (deviceId?: string, useBrowserProcessing = false) => {
      if (!room || !userIdRef.current) return
      setError(null)

      try {
        const opened = await openMicrophone({ deviceId, useBrowserProcessing })
        setCapture(opened)

        if (opened.report.path === 'processed') {
          warn(
            'This browser would not switch off its voice processing, so this track is ' +
              'captured through the call pipeline. It will still sync perfectly, but it ' +
              'will not match an unprocessed track for quality.',
          )
        }

        const recorder = new Recorder({
          trackId: crypto.randomUUID(),
          capture: opened,
          basePath,
          calibrationMs: Number(localStorage.getItem('podstart:calibration') ?? 0),
          // A raw take uploads 32-bit float so that nothing, not even a
          // quantisation to 24-bit, is applied to the samples.
          bitsPerSample: processing === 'raw' ? 32 : 24,
          events: {
            onEnvelope: (peak, rms, atFrame) => {
              setMyLevel({ peak, rms })
              if (peak >= 0.995) setClipped(true)
              if (atFrame >= 0) {
                const seconds = atFrame / opened.sampleRate
                myEnvelope.writeAt(seconds, peak, rms)
                roomRef.current?.send({ t: 'env', peak, rms, at: seconds })
              }
            },
            onSegment: (segment) => {
              const sessionId = sessionRef.current?.id
              const trackId = trackIdRef.current
              if (!sessionId || !trackId) return
              uploaderRef.current?.enqueue({
                trackId, sessionId,
                idx: segment.idx,
                codec: segment.codec,
                bytes: segment.bytes,
                startSample: segment.startSample,
                frames: segment.frames,
              })
            },
            onWarning: warn,
            onStarted: (startEpochMs) => {
              startEpochRef.current = startEpochMs
              void registerTrack(startEpochMs, opened)
            },
            onFinished: async (summary) => {
              setHasLocalCopy(summary.hasLocalCopy)
              const trackId = trackIdRef.current
              if (trackId) {
                await updateTrack(trackId, {
                  duration_sec: summary.durationSec,
                  drift_ppm: summary.driftPpm,
                  segment_count: uploaderRef.current?.progress.uploaded ?? 0,
                  state: 'uploading',
                }).catch(() => undefined)
              }
            },
          },
        })

        await recorder.prepare()
        recorderRef.current = recorder

        uploaderRef.current = new SegmentUploader(setUpload, warn)

        const peerRoom = new Room({
          roomId: room.id,
          userId: userIdRef.current,
          displayName: localStorage.getItem('podstart:name') || 'You',
          isHost: room.owner_id === userIdRef.current,
          turn: turnFromEnv(),
          events: {
            onPresence: setRemote,
            onConnection: (_state, open) => setDataChannelOpen(open),
            onRemoteStream: (stream) => attachRemoteAudio(stream),
            onRemoteStatus: setRemoteStatus,
            onRemoteEnvelope: (peak, rms, at) => {
              setFriendLevel({ peak, rms })
              if (at >= 0) friendEnvelope.writeAt(at, peak, rms)
            },
            onClock: (result) =>
              setClock({ offset: result.offsetMs, rtt: result.rttMs, jitter: result.jitterMs }),
            onDownbeat: (sessionId, localEpochMs, countdownMs) =>
              beginAt(sessionId, localEpochMs, countdownMs),
            onStopCommand: () => void finish(),
            onError: (caught) => warn(caught.message),
          },
        })

        await peerRoom.connect()
        peerRoom.addTalkback(opened.stream)
        roomRef.current = peerRoom

        setPhase('ready')
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
        setPhase('error')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, basePath, warn, processing],
  )

  const attachRemoteAudio = (stream: MediaStream) => {
    let element = remoteAudioRef.current
    if (!element) {
      element = document.createElement('audio')
      element.autoplay = true
      element.setAttribute('playsinline', '')
      document.body.appendChild(element)
      remoteAudioRef.current = element
    }
    element.srcObject = stream
    void element.play().catch(() => {
      warn('Tap anywhere to let this browser play your friend’s audio.')
    })
  }

  const registerTrack = async (startEpochMs: number, opened: Capture) => {
    const current = sessionRef.current
    if (!current) return
    try {
      const track = await createTrack({
        sessionId: current.id,
        displayName: localStorage.getItem('podstart:name') || 'You',
        sampleRate: opened.sampleRate,
        channels: opened.channels,
        codec: 'flac',
        startEpochMs,
        clockOffsetMs: roomRef.current?.offsetMs ?? 0,
        clockRttMs: roomRef.current?.clock?.rttMs ?? null,
        capture: opened.report,
      })
      trackIdRef.current = track.id
    } catch (caught) {
      warn(`The take is recording locally, but could not be registered: ${
        caught instanceof Error ? caught.message : String(caught)
      }`)
    }
  }

  // ---------------------------------------------------------------- transport

  const beginAt = useCallback((sessionId: string, localEpochMs: number, countdownMs: number) => {
    const recorder = recorderRef.current
    if (!recorder) return

    sessionRef.current = sessionRef.current?.id === sessionId
      ? sessionRef.current
      : ({ id: sessionId } as Session)

    setPhase('armed')
    setCountdown(Math.ceil(countdownMs / 1000))

    const tick = () => {
      const remaining = localEpochMs - (performance.timeOrigin + performance.now())
      if (remaining <= 0) {
        setCountdown(null)
        setPhase('recording')
        return
      }
      setCountdown(Math.ceil(remaining / 1000))
      setTimeout(tick, 200)
    }
    tick()

    myEnvelope.clear()
    friendEnvelope.clear()
    setClipped(false)
    recorder.start(localEpochMs)
    void requestWakeLock()
  }, [myEnvelope, friendEnvelope])

  const record = useCallback(async () => {
    const peerRoom = roomRef.current
    if (!room || !peerRoom) return

    try {
      // An offset measured minutes ago is stale; re-measure at the last moment.
      if (peerRoom.connected) await peerRoom.measureClock()

      const created = await createSession(room.id, defaultTakeTitle(), processing)
      sessionRef.current = created
      setSession(created)

      await updateSession(created.id, { state: 'armed' })
      const at = peerRoom.scheduleDownbeat(created.id, 3000)
      await updateSession(created.id, { downbeat_epoch_ms: at, state: 'recording' })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [room, processing])

  const finish = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return

    setPhase('finishing')
    recorder.stop()
    void releaseWakeLock()

    // Let the final segment encode and enter the queue before draining it.
    await new Promise((resolve) => setTimeout(resolve, 900))
    const drained = await uploaderRef.current?.flush()

    const current = sessionRef.current
    const trackId = trackIdRef.current

    if (trackId) {
      await updateTrack(trackId, { state: drained ? 'complete' : 'failed' }).catch(() => undefined)
    }
    if (current?.id) {
      await updateSession(current.id, {
        state: drained ? 'stopped' : 'failed',
        stopped_epoch_ms: performance.timeOrigin + performance.now(),
      }).catch(() => undefined)
    }

    if (!drained) {
      warn(
        'Some segments did not upload. The lossless copy on this device is intact — ' +
          'open the take and use "Retry upload" when you have a better connection.',
      )
    }

    setPhase('done')
  }, [warn])

  const stop = useCallback(() => {
    const current = sessionRef.current
    if (current?.id) roomRef.current?.stopAll(current.id)
    else void finish()
  }, [finish])

  // ------------------------------------------------------------------ timers

  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => {
      setElapsedSec((performance.timeOrigin + performance.now() - startEpochRef.current) / 1000)
    }, 50)
    return () => clearInterval(id)
  }, [phase])

  // Keep the other side honestly informed, once a second.
  useEffect(() => {
    const id = setInterval(() => {
      const peerRoom = roomRef.current
      if (!peerRoom || !capture) return
      peerRoom.send({
        t: 'status',
        name: myName,
        armed: phase === 'armed',
        recording: phase === 'recording',
        muted: talkbackMuted,
        quality: capture.report.path,
        sampleRate: capture.sampleRate,
        uploaded: upload.uploaded,
        pending: upload.pending,
      })
    }, 1000)
    return () => clearInterval(id)
  }, [phase, capture, myName, talkbackMuted, upload])

  // A phone that sleeps mid-take stops recording. This is the whole reason
  // long mobile sessions fail, and the wake lock is the only defence a web
  // page has.
  const requestWakeLock = async () => {
    try {
      wakeLockRef.current = await navigator.wakeLock?.request('screen')
    } catch {
      warn('Keep this screen awake and in the foreground — the browser stops recording otherwise.')
    }
  }

  const releaseWakeLock = async () => {
    try {
      await wakeLockRef.current?.release()
    } catch {
      /* already released */
    }
    wakeLockRef.current = null
  }

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && phase === 'recording') void requestWakeLock()
      if (document.visibilityState === 'hidden' && phase === 'recording') {
        warn('This tab went to the background. Keep it in front while recording.')
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Closing the tab mid-take would silently lose the ending.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'armed') return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [phase])

  useEffect(() => () => {
    void roomRef.current?.leave()
    void recorderRef.current?.dispose()
    capture?.stop()
    remoteAudioRef.current?.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleTalkback = useCallback(() => {
    const element = remoteAudioRef.current
    if (!element) return
    element.muted = !element.muted
    setTalkbackMuted(element.muted)
  }, [])

  const state: StudioState = {
    phase, room, session, isHost, myName, remote, remoteStatus, capture,
    elapsedSec, countdown, myEnvelope, friendEnvelope, myLevel, friendLevel, clipped,
    upload,
    clockOffsetMs: clock.offset,
    clockRttMs: clock.rtt,
    clockJitterMs: clock.jitter,
    dataChannelOpen, warnings, error, talkbackMuted,
    qualityConflict: talkbackHurtsQuality() && !talkbackMuted,
    processing, hasLocalCopy,
  }

  const chooseProcessing = useCallback((next: ProcessingMode) => {
    setProcessing(next)
    localStorage.setItem('podstart:processing', next)
  }, [])

  /**
   * Hands back the untouched local recording as a 32-bit float WAV.
   *
   * This is the most faithful artefact podstart can produce: the samples go
   * from the microphone into local storage and out to this file without ever
   * being converted, scaled or quantised.
   */
  const saveLocalCopy = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current
    if (!recorder) return null
    const samples = await recorder.readLocalCopy()
    if (!samples) return null
    const { wavBlob } = await import('@/lib/audio/wav')
    return wavBlob(samples, recorder.sampleRate, recorder.channels, 32)
  }, [])

  return {
    state,
    setup,
    record,
    stop,
    toggleTalkback,
    setProcessing: chooseProcessing,
    saveLocalCopy,
    dismissWarning: (message: string) =>
      setWarnings((previous) => previous.filter((w) => w !== message)),
  }
}

function defaultTakeTitle(): string {
  const now = new Date()
  return now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

function turnFromEnv() {
  const url = process.env.NEXT_PUBLIC_TURN_URL
  if (!url) return null
  return {
    url,
    username: process.env.NEXT_PUBLIC_TURN_USERNAME ?? '',
    credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? '',
  }
}

/** Realtime is only used for signalling, but keeping the import honest. */
export const realtimeClient = supabase
