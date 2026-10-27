'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { EnvelopeTrack } from '@/lib/audio/envelope'
import { DEFAULT_CLEANUP, type CleanupReport, type CleanupSettings } from '@/lib/dsp/pipeline'
import { DEFAULT_MIX, mixdown, mixToWav, type JinglePlacement, type MixResult, type MixSettings, type Stem } from '@/lib/mix/mixdown'
import { downloadTrack } from '@/lib/store/uploads'
import {
  getSession, loadJingleAudio, myJingles, placementsForSession, tracksForSession,
} from '@/lib/store/db'
import type { Jingle, Session, SessionJingle, Track } from '@/lib/supabase/types'

/**
 * Post-production state.
 *
 * Both stems are fetched once and kept in memory in two versions -- as
 * recorded, and cleaned -- so the A/B comparison is instant and honest. The
 * cleanup itself runs in a worker; nothing here blocks the interface.
 */

export interface LoadedStem {
  track: Track
  raw: Float32Array
  cleaned: Float32Array | null
  report: CleanupReport | null
  envelopeRaw: EnvelopeTrack
  envelopeCleaned: EnvelopeTrack | null
  sampleRate: number
  gainDb: number
  nudgeMs: number
  muted: boolean
  isMine: boolean
}

export interface EpisodeState {
  session: Session | null
  stems: LoadedStem[]
  jingles: Jingle[]
  placements: SessionJingle[]
  loading: string | null
  progress: number
  processing: { stage: string; fraction: number } | null
  mix: MixResult | null
  error: string | null
  useCleaned: boolean
  settings: CleanupSettings
  mixSettings: MixSettings
}

export function useEpisode(sessionId: string, myUserId: string | null, basePath: string) {
  const [session, setSession] = useState<Session | null>(null)
  const [stems, setStems] = useState<LoadedStem[]>([])
  const [jingles, setJingles] = useState<Jingle[]>([])
  const [placements, setPlacements] = useState<SessionJingle[]>([])
  const [loading, setLoading] = useState<string | null>('Loading the take')
  const [progress, setProgress] = useState(0)
  const [processing, setProcessing] = useState<{ stage: string; fraction: number } | null>(null)
  const [mix, setMix] = useState<MixResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [useCleaned, setUseCleaned] = useState(true)
  const [settings, setSettings] = useState<CleanupSettings>(DEFAULT_CLEANUP)
  const [mixSettings, setMixSettings] = useState<MixSettings>(DEFAULT_MIX)

  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        setLoading('Loading the take')
        const found = await getSession(sessionId)
        if (!found) throw new Error('That take no longer exists.')
        if (cancelled) return
        setSession(found)

        const tracks = await tracksForSession(sessionId)
        if (tracks.length === 0) throw new Error('This take has no tracks.')

        const loaded: LoadedStem[] = []
        for (let i = 0; i < tracks.length; i += 1) {
          const track = tracks[i] as Track
          setLoading(`Fetching ${track.display_name}’s track`)
          const audio = await downloadTrack(sessionId, track.id, (f) =>
            setProgress((i + f) / tracks.length),
          )
          if (!audio) continue
          loaded.push({
            track,
            raw: audio.samples,
            cleaned: null,
            report: null,
            envelopeRaw: EnvelopeTrack.fromSamples(audio.samples, audio.sampleRate),
            envelopeCleaned: null,
            sampleRate: audio.sampleRate,
            gainDb: 0,
            nudgeMs: 0,
            muted: false,
            isMine: track.user_id === myUserId,
          })
        }

        if (cancelled) return
        // Your friend's track first: it draws on the upper half of the tape.
        loaded.sort((a, b) => Number(a.isMine) - Number(b.isMine))
        setStems(loaded)

        setJingles(await myJingles(found.room_id))
        setPlacements(await placementsForSession(sessionId))
        setLoading(null)
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
          setLoading(null)
        }
      }
    })()

    return () => { cancelled = true }
  }, [sessionId, myUserId])

  const worker = useCallback(() => {
    // Relative, not aliased: the bundler only recognises a worker entry from a
    // relative specifier. With '@/...' it copies the raw .ts out as an asset
    // and the worker 404s at runtime.
    workerRef.current ??= new Worker(new URL('../dsp/dsp.worker.ts', import.meta.url), {
      type: 'module',
    })
    return workerRef.current
  }, [])

  /** Runs the cleanup chain over every stem, one after another. */
  const clean = useCallback(async () => {
    if (stems.length === 0) return
    setError(null)

    const dsp = worker()

    for (let i = 0; i < stems.length; i += 1) {
      const stem = stems[i] as LoadedStem
      const jobId = `${stem.track.id}:${Date.now()}`

      const result = await new Promise<{ samples: Float32Array; report: CleanupReport } | null>(
        (resolve) => {
          const onMessage = (event: MessageEvent) => {
            const message = event.data
            if (message.jobId !== jobId) return

            if (message.type === 'progress') {
              setProcessing({
                stage: `${stem.track.display_name}: ${message.stage}`,
                fraction: (i + message.fraction) / stems.length,
              })
              return
            }
            if (message.type === 'cleaned') {
              dsp.removeEventListener('message', onMessage)
              resolve({ samples: new Float32Array(message.samples), report: message.report })
              return
            }
            if (message.type === 'error') {
              dsp.removeEventListener('message', onMessage)
              setError(`${stem.track.display_name}: ${message.message}`)
              resolve(null)
            }
          }

          dsp.addEventListener('message', onMessage)
          // The worker receives a copy: the original stays intact for A/B.
          const copy = stem.raw.slice()
          dsp.postMessage(
            {
              type: 'cleanup', jobId,
              samples: copy.buffer,
              sampleRate: stem.sampleRate,
              settings, basePath,
            },
            [copy.buffer],
          )
        },
      )

      if (result) {
        setStems((previous) =>
          previous.map((s) =>
            s.track.id === stem.track.id
              ? {
                  ...s,
                  cleaned: result.samples,
                  report: result.report,
                  envelopeCleaned: EnvelopeTrack.fromSamples(result.samples, s.sampleRate),
                }
              : s,
          ),
        )
      }
    }

    setProcessing(null)
    setUseCleaned(true)
  }, [stems, settings, basePath, worker])

  /** Builds the aligned mix from whichever version is currently selected. */
  const buildMix = useCallback(async (): Promise<MixResult | null> => {
    if (stems.length === 0) return null
    setProcessing({ stage: 'Mixing', fraction: 0.5 })

    try {
      const mixStems: Stem[] = stems.map((stem) => ({
        id: stem.track.id,
        name: stem.track.display_name,
        samples: useCleaned && stem.cleaned ? stem.cleaned : stem.raw,
        sampleRate: stem.sampleRate,
        // Both tracks' timestamps are stored in the host's clock already.
        startEpochMs: stem.track.start_epoch_ms,
        driftPpm: stem.track.drift_ppm,
        gainDb: stem.gainDb,
        muted: stem.muted,
        pan: 0,
        nudgeMs: stem.nudgeMs,
      }))

      const placed: JinglePlacement[] = []
      for (const placement of placements) {
        const jingle = jingles.find((j) => j.id === placement.jingle_id)
        if (!jingle) continue
        const audio = await loadJingleAudio(jingle)
        placed.push({
          id: placement.id,
          name: jingle.name,
          samples: audio.samples,
          sampleRate: audio.sampleRate,
          atSec: placement.at_sec,
          gainDb: placement.gain_db,
          fadeInMs: placement.fade_in_ms,
          fadeOutMs: placement.fade_out_ms,
          duckDb: placement.duck_db,
        })
      }

      const result = await mixdown(mixStems, placed, mixSettings)
      setMix(result)
      setProcessing(null)
      return result
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setProcessing(null)
      return null
    }
  }, [stems, placements, jingles, useCleaned, mixSettings])

  useEffect(() => () => workerRef.current?.terminate(), [])

  const state: EpisodeState = {
    session, stems, jingles, placements, loading, progress, processing, mix, error,
    useCleaned, settings, mixSettings,
  }

  return {
    state,
    setSettings,
    setMixSettings,
    setUseCleaned,
    setStems,
    setJingles,
    setPlacements,
    clean,
    buildMix,
    exportWav: () => (mix ? mixToWav(mix) : null),
  }
}
