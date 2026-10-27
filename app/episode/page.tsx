'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import { WaveformTape } from '@/components/WaveformTape'
import { Timecode } from '@/components/Transport'
import { Button, Card, Notice, Pill, Row, Slider, Spinner, Toggle } from '@/components/ui'
import { EnvelopeTrack } from '@/lib/audio/envelope'
import { useEpisode } from '@/lib/store/useEpisode'
import { forgetSessionAudio, placeJingle, removePlacement, saveMix, uploadJingle } from '@/lib/store/db'
import { ensureSignedIn, supabase } from '@/lib/supabase/client'
import { bytes, signedDb, timecode } from '@/lib/util/format'
import { wavBlob } from '@/lib/audio/wav'
import type { Jingle } from '@/lib/supabase/types'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export default function EpisodePage() {
  return (
    <Suspense fallback={<Centered><Spinner label="Opening the take" /></Centered>}>
      <Episode />
    </Suspense>
  )
}

function Episode() {
  const params = useSearchParams()
  const sessionId = params.get('id') ?? ''
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    void ensureSignedIn().then(setUserId).catch(() => undefined)
  }, [])

  const episode = useEpisode(sessionId, userId, BASE)
  const { state } = episode
  const [position, setPosition] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  if (!sessionId) {
    return <Centered><Notice tone="warn">No take in the link.</Notice></Centered>
  }

  if (state.loading) {
    return (
      <Centered>
        <Spinner label={state.loading} />
        {state.progress > 0 && (
          <progress value={state.progress} max={1} style={{ width: 240 }} />
        )}
      </Centered>
    )
  }

  if (state.error && state.stems.length === 0) {
    return <Centered><Notice tone="warn">{state.error}</Notice></Centered>
  }

  const friend = state.stems.find((s) => !s.isMine)
  const mine = state.stems.find((s) => s.isMine)
  const empty = new EnvelopeTrack()

  const pick = (stem: typeof friend) => {
    if (!stem) return empty
    return state.useCleaned && stem.envelopeCleaned ? stem.envelopeCleaned : stem.envelopeRaw
  }

  const spreadMs =
    friend && mine
      ? Math.abs(friend.track.start_epoch_ms - mine.track.start_epoch_ms)
      : 0

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '14px 16px 64px', display: 'grid', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <a href={`${BASE}/`} style={{ color: 'var(--accent)', width: 44, minHeight: 'var(--tap)', display: 'grid', placeItems: 'center' }}>‹</a>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>{state.session?.title ?? 'Take'}</h1>
          <p style={{ fontSize: 13, color: 'var(--label-secondary)' }}>
            {state.stems.length} tracks ·{' '}
            {timecode(Math.max(...state.stems.map((s) => s.raw.length / s.sampleRate), 0), false)}
          </p>
        </div>
      </header>

      {state.error && <Notice tone="warn">{state.error}</Notice>}

      <SyncProof spreadMs={spreadMs} stems={state.stems} />

      <WaveformTape
        friend={pick(friend)}
        mine={pick(mine)}
        positionSec={position}
        live={false}
        friendName={(friend?.track.display_name ?? 'Friend').toUpperCase()}
        myName={(mine?.track.display_name ?? 'You').toUpperCase()}
        pxPerSecond={Math.max(4, 700 / Math.max(10, state.mix?.durationSec ?? 60))}
        onScrub={setPosition}
        height={300}
      />

      <Timecode seconds={position} live={false} />

      <Card style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 className="slate">Cleanup</h2>
          {state.stems.some((s) => s.cleaned) && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant={state.useCleaned ? 'quiet' : 'plain'}
                onClick={() => episode.setUseCleaned(false)}
                style={{ minHeight: 36, padding: '0 14px', fontSize: 15 }}
              >
                As recorded
              </Button>
              <Button
                variant={state.useCleaned ? 'primary' : 'plain'}
                onClick={() => episode.setUseCleaned(true)}
                style={{ minHeight: 36, padding: '0 14px', fontSize: 15 }}
              >
                Cleaned
              </Button>
            </div>
          )}
        </div>

        <Slider
          label="Noise removal"
          value={state.settings.denoise}
          min={0}
          max={1}
          format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)}
          onChange={(denoise) => episode.setSettings({ ...state.settings, denoise })}
        />
        <Slider
          label="Room echo removal"
          value={state.settings.dereverb}
          min={0}
          max={1}
          format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)}
          onChange={(dereverb) => episode.setSettings({ ...state.settings, dereverb })}
        />
        <Slider
          label="Sibilance"
          value={state.settings.deEss}
          min={0}
          max={1}
          format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)}
          onChange={(deEss) => episode.setSettings({ ...state.settings, deEss })}
        />
        <Slider
          label="Target loudness"
          value={state.settings.targetLufs}
          min={-24}
          max={-12}
          step={0.5}
          format={(v) => `${v} LUFS`}
          onChange={(targetLufs) => episode.setSettings({ ...state.settings, targetLufs })}
        />

        {state.processing ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <Spinner label={state.processing.stage} />
            <progress value={state.processing.fraction} max={1} style={{ width: '100%' }} />
          </div>
        ) : (
          <Button variant="primary" full onClick={() => void episode.clean()}>
            {state.stems.some((s) => s.cleaned) ? 'Run cleanup again' : 'Clean up both tracks'}
          </Button>
        )}

        {state.stems.map((stem) =>
          stem.report ? (
            <details key={stem.track.id} style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 15, minHeight: 32 }}>
                {stem.track.display_name}: what changed
              </summary>
              <div style={{ paddingTop: 8 }}>
                <Row
                  label="Noise floor"
                  value={`${stem.report.noiseFloorBeforeDb.toFixed(1)} → ${stem.report.noiseFloorAfterDb.toFixed(1)} dB`}
                  tone="good"
                />
                <Row label="Room decay measured" value={`${stem.report.rt60Seconds.toFixed(2)} s`} />
                <Row label="Loudness" value={`${stem.report.before.lufs.toFixed(1)} → ${stem.report.after.lufs.toFixed(1)} LUFS`} />
                <Row label="Gain applied" value={`${signedDb(stem.report.gainAppliedDb)} dB`} />
                <Row label="True peak" value={`${stem.report.after.truePeakDb.toFixed(1)} dBTP`} />
                <Row label="Clicks repaired" value={`${stem.report.clicksRepaired}`} />
                <Row label="Denoiser" value={stem.report.engineUsed === 'neural' ? 'RNNoise' : 'Spectral'} />
                <Row label="Took" value={`${(stem.report.elapsedMs / 1000).toFixed(1)} s`} />
              </div>
            </details>
          ) : null,
        )}
      </Card>

      <JingleCard episode={episode} sessionId={sessionId} />

      <Card style={{ display: 'grid', gap: 12 }}>
        <h2 className="slate">Mix</h2>

        <Toggle
          label="Trim the lead-in"
          description="Cuts the countdown and the “can you hear me” before the first word."
          checked={state.mixSettings.trimHead}
          onChange={(trimHead) => episode.setMixSettings({ ...state.mixSettings, trimHead })}
        />
        <Toggle
          label="Stereo"
          description="Mono is the podcast default and halves the file. Stereo only if you want the voices separated."
          checked={state.mixSettings.channels === 2}
          onChange={(stereo) =>
            episode.setMixSettings({ ...state.mixSettings, channels: stereo ? 2 : 1 })
          }
        />

        {state.stems.map((stem, index) => (
          <div key={stem.track.id} style={{ paddingTop: 6 }}>
            <Slider
              label={`${stem.track.display_name} level`}
              value={stem.gainDb}
              min={-12}
              max={12}
              step={0.5}
              format={(v) => `${signedDb(v)} dB`}
              onChange={(gainDb) =>
                episode.setStems((previous) =>
                  previous.map((s, i) => (i === index ? { ...s, gainDb } : s)),
                )
              }
            />
            <Slider
              label={`${stem.track.display_name} nudge`}
              value={stem.nudgeMs}
              min={-200}
              max={200}
              step={1}
              format={(v) => `${v > 0 ? '+' : ''}${v} ms`}
              onChange={(nudgeMs) =>
                episode.setStems((previous) =>
                  previous.map((s, i) => (i === index ? { ...s, nudgeMs } : s)),
                )
              }
            />
          </div>
        ))}

        <Button variant="primary" full onClick={() => void episode.buildMix()}>
          Build the synced mix
        </Button>

        {state.mix && (
          <>
            <Row label="Length" value={timecode(state.mix.durationSec, false)} />
            <Row label="Loudness" value={`${state.mix.loudness.lufs.toFixed(1)} LUFS`} tone="good" />
            <Row label="True peak" value={`${state.mix.loudness.truePeakDb.toFixed(1)} dBTP`} />
            <Row label="Loudness range" value={`${state.mix.loudness.lra.toFixed(1)} LU`} />

            <audio
              ref={audioRef}
              controls
              style={{ width: '100%', marginTop: 8 }}
              src={URL.createObjectURL(wavBlob(state.mix.samples, state.mix.sampleRate, state.mix.channels, 24))}
            />

            <ExportRow episode={episode} sessionId={sessionId} />
          </>
        )}
      </Card>

      <Card style={{ display: 'grid', gap: 12 }}>
        <h2 className="slate">Storage</h2>
        <p style={{ fontSize: 14, color: 'var(--label-secondary)', lineHeight: 1.5 }}>
          Lossless stems are large, and a free Supabase project holds 1 GB. Once you have
          downloaded everything you need, clear this take’s audio to make room for the next
          episode. The take’s settings and reports stay.
        </p>
        <Button
          variant="danger"
          onClick={async () => {
            if (!confirm('Delete this take’s uploaded audio? Downloaded files are unaffected.')) return
            await forgetSessionAudio(sessionId)
            alert('Cleared. The next episode has room.')
          }}
        >
          Clear this take’s audio
        </Button>
      </Card>
    </main>
  )
}

/**
 * The number that justifies the whole app: how far apart the two recordings
 * actually started, measured rather than claimed.
 */
function SyncProof({
  spreadMs,
  stems,
}: {
  spreadMs: number
  stems: { track: { drift_ppm: number | null; display_name: string; capture: Record<string, unknown> } }[]
}) {
  const worstDrift = stems.reduce(
    (max, s) => Math.max(max, Math.abs(s.track.drift_ppm ?? 0)),
    0,
  )

  return (
    <Card style={{ display: 'grid', gap: 10 }}>
      <h2 className="slate">Sync</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Pill tone={spreadMs < 50 ? 'good' : 'warn'}>
          Starts {spreadMs.toFixed(0)} ms apart
        </Pill>
        <Pill tone={worstDrift < 50 ? 'good' : 'warn'}>
          Drift {worstDrift.toFixed(0)} ppm
        </Pill>
        {stems.map((s) => (
          <Pill key={s.track.display_name} tone={s.track.capture?.path === 'raw' ? 'good' : 'warn'}>
            {s.track.display_name}: {s.track.capture?.path === 'raw' ? 'raw' : 'processed'}
          </Pill>
        ))}
      </div>
      <p style={{ fontSize: 13, color: 'var(--label-secondary)', lineHeight: 1.5 }}>
        Both offsets are corrected automatically in the mix — the gap above is what was
        measured, not what is left. Drift is the difference between the two devices’ audio
        clocks and is resampled out before anything is placed.
      </p>
    </Card>
  )
}

function JingleCard({
  episode,
  sessionId,
}: {
  episode: ReturnType<typeof useEpisode>
  sessionId: string
}) {
  const { state } = episode
  const [busy, setBusy] = useState(false)

  const add = async (file: File, kind: Jingle['kind']) => {
    setBusy(true)
    try {
      const ctx = new OfflineAudioContext(1, 1, 48000)
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
      const jingle = await uploadJingle(file, kind, decoded.duration, state.session?.room_id ?? null)
      episode.setJingles((previous) => [jingle, ...previous])
    } catch (caught) {
      alert(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const place = async (jingle: Jingle, where: 'start' | 'end') => {
    const programme = Math.max(...state.stems.map((s) => s.raw.length / s.sampleRate), 0)
    const placement = await placeJingle({
      session_id: sessionId,
      jingle_id: jingle.id,
      // An outro starts one length before the end, so it finishes with the show.
      at_sec: where === 'start' ? 0 : Math.max(0, programme - jingle.duration_sec),
      gain_db: 0,
      fade_in_ms: where === 'start' ? 0 : 600,
      fade_out_ms: 600,
      duck_db: jingle.kind === 'bed' ? -9 : 0,
    })
    episode.setPlacements((previous) => [...previous, placement])
  }

  return (
    <Card style={{ display: 'grid', gap: 12 }}>
      <h2 className="slate">Jingles</h2>

      <label
        style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: 72,
          border: '1.5px dashed var(--separator)',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
          color: 'var(--accent)',
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        {busy ? 'Adding…' : 'Add an intro, outro or sting'}
        <input
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void add(file, 'sting')
          }}
        />
      </label>

      {state.jingles.map((jingle) => (
        <div
          key={jingle.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 0',
            borderBottom: '1px solid var(--separator)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: 1, minWidth: 120 }}>{jingle.name}</span>
          <span className="mono" style={{ fontSize: 13, color: 'var(--label-secondary)' }}>
            {timecode(jingle.duration_sec, false)}
          </span>
          <Button onClick={() => void place(jingle, 'start')} style={{ minHeight: 36, padding: '0 12px', fontSize: 15 }}>
            At start
          </Button>
          <Button onClick={() => void place(jingle, 'end')} style={{ minHeight: 36, padding: '0 12px', fontSize: 15 }}>
            At end
          </Button>
        </div>
      ))}

      {state.placements.length > 0 && (
        <div style={{ paddingTop: 6 }}>
          <h3 className="slate" style={{ marginBottom: 6 }}>On this take</h3>
          {state.placements.map((placement) => {
            const jingle = state.jingles.find((j) => j.id === placement.jingle_id)
            return (
              <div key={placement.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
                <span style={{ flex: 1 }}>{jingle?.name ?? 'Jingle'}</span>
                <span className="mono" style={{ fontSize: 13, color: 'var(--label-secondary)' }}>
                  at {timecode(placement.at_sec, false)}
                </span>
                <Button
                  variant="quiet"
                  onClick={async () => {
                    await removePlacement(placement.id)
                    episode.setPlacements((previous) => previous.filter((p) => p.id !== placement.id))
                  }}
                  style={{ minHeight: 36, padding: '0 10px', fontSize: 15 }}
                >
                  Remove
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function ExportRow({
  episode,
  sessionId,
}: {
  episode: ReturnType<typeof useEpisode>
  sessionId: string
}) {
  const { state } = episode
  const [saving, setSaving] = useState(false)

  const download = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  const title = (state.session?.title ?? 'take').replace(/[^\w-]+/g, '-').toLowerCase()

  return (
    <div style={{ display: 'grid', gap: 10, paddingTop: 8 }}>
      <Button
        variant="primary"
        full
        onClick={() => {
          const blob = episode.exportWav()
          if (blob) download(blob, `${title}-mix.wav`)
        }}
      >
        Download the mix ({state.mix ? bytes(state.mix.samples.length * 3) : '—'})
      </Button>

      <Button
        full
        onClick={() => {
          for (const stem of state.stems) {
            const samples = state.useCleaned && stem.cleaned ? stem.cleaned : stem.raw
            download(
              wavBlob(samples, stem.sampleRate, 1, 24),
              `${title}-${stem.track.display_name.toLowerCase()}.wav`,
            )
          }
        }}
      >
        Download both stems separately
      </Button>

      <Button
        full
        disabled={saving}
        onClick={async () => {
          const blob = episode.exportWav()
          if (!blob || !state.mix) return
          setSaving(true)
          try {
            await saveMix(sessionId, blob, {
              format: 'wav',
              lufs: state.mix.loudness.lufs,
              truePeakDb: state.mix.loudness.truePeakDb,
              durationSec: state.mix.durationSec,
              settings: { cleanup: state.settings, mix: state.mixSettings },
            })
            alert('Mix saved to the room. Your friend can download it too.')
          } catch (caught) {
            alert(caught instanceof Error ? caught.message : String(caught))
          } finally {
            setSaving(false)
          }
        }}
      >
        {saving ? 'Saving…' : 'Save the mix for your friend'}
      </Button>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '70dvh', display: 'grid', placeContent: 'center', gap: 16, padding: 24 }}>
      {children}
    </main>
  )
}

/** Keeps the Supabase import used; the page talks to it through lib/store/db. */
void supabase
