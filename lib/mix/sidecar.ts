import type { Track } from '@/lib/supabase/types'

/**
 * Alignment delivered as numbers instead of as edits.
 *
 * In raw mode podstart will not touch your samples, which means it cannot
 * align them for you either. What it can do is tell you exactly how far apart
 * the two recordings started and how fast each device's clock ran, so you can
 * apply that in whatever editor you already use.
 *
 * Two files come out of this: machine-readable JSON, and a plain-text note
 * that tells you what to type into your DAW. The second one is the one you
 * will actually use at midnight on a Sunday.
 */

export interface SidecarTrack {
  name: string
  file: string
  sampleRate: number
  channels: number
  startEpochMs: number
  driftPpm: number | null
  durationSec: number
  capturedRaw: boolean
}

export interface Sidecar {
  take: string
  generatedAt: string
  reference: string
  tracks: (SidecarTrack & {
    /** Milliseconds to delay this track so it lines up with the reference. */
    offsetMs: number
    offsetSamples: number
    /** Rate to resample to, to undo this device's clock drift. */
    driftCorrectedRate: number | null
  })[]
}

export function buildSidecar(
  takeTitle: string,
  tracks: { track: Track; durationSec: number; filename: string }[],
  generatedAtIso: string,
): Sidecar {
  // The earliest recording is the reference; everything else is delayed
  // relative to it, so every offset is positive and nothing needs trimming.
  const origin = Math.min(...tracks.map((t) => t.track.start_epoch_ms))
  const reference = tracks.find((t) => t.track.start_epoch_ms === origin)

  return {
    take: takeTitle,
    generatedAt: generatedAtIso,
    reference: reference?.track.display_name ?? 'unknown',
    tracks: tracks.map(({ track, durationSec, filename }) => {
      const offsetMs = track.start_epoch_ms - origin
      return {
        name: track.display_name,
        file: filename,
        sampleRate: track.sample_rate,
        channels: track.channels,
        startEpochMs: track.start_epoch_ms,
        driftPpm: track.drift_ppm,
        durationSec,
        capturedRaw: (track.capture as { path?: string })?.path === 'raw',
        offsetMs,
        offsetSamples: Math.round((offsetMs / 1000) * track.sample_rate),
        driftCorrectedRate: track.drift_ppm
          ? Math.round(track.sample_rate * (1 + track.drift_ppm / 1e6) * 1000) / 1000
          : null,
      }
    }),
  }
}

/** The version you read rather than parse. */
export function sidecarReadme(sidecar: Sidecar): string {
  const lines: string[] = []

  lines.push(`podstart — sync notes for "${sidecar.take}"`)
  lines.push(`Generated ${sidecar.generatedAt}`)
  lines.push('')
  lines.push('These stems are exactly what the microphones produced. Nothing has been')
  lines.push('applied to them — no noise reduction, no loudness, no resampling. That')
  lines.push('also means they are not aligned yet. Here is how to align them.')
  lines.push('')
  lines.push(`Reference track (starts first): ${sidecar.reference}`)
  lines.push('')

  for (const track of sidecar.tracks) {
    lines.push(`${track.name}  —  ${track.file}`)
    lines.push(`  Format          ${track.sampleRate} Hz, ${track.channels} ch`)
    lines.push(`  Length          ${track.durationSec.toFixed(3)} s`)
    lines.push(
      `  Delay by        ${track.offsetMs.toFixed(2)} ms  (${track.offsetSamples} samples)`,
    )

    if (track.driftPpm !== null && Math.abs(track.driftPpm) >= 1) {
      const slipMsPerHour = Math.abs(track.driftPpm) * 3.6
      lines.push(
        `  Clock drift     ${track.driftPpm.toFixed(1)} ppm  ` +
          `(~${slipMsPerHour.toFixed(0)} ms per hour)`,
      )
      lines.push(
        `  To correct it   interpret this file at ${track.driftCorrectedRate} Hz, ` +
          `or resample it to ${track.sampleRate} Hz from that rate`,
      )
    } else {
      lines.push('  Clock drift     negligible, no correction needed')
    }

    if (!track.capturedRaw) {
      lines.push('  NOTE            this browser applied its own voice processing at capture')
    }
    lines.push('')
  }

  lines.push('In most editors:')
  lines.push('  1. Drop both files on separate tracks, both starting at 00:00.')
  lines.push('  2. Move each one later by its "Delay by" figure above.')
  lines.push('  3. If a drift figure is listed and the take is long, apply the rate')
  lines.push('     change before step 2 — the offset assumes the drift is gone.')
  lines.push('')
  lines.push('The offsets come from each device measuring the wall-clock instant of its')
  lines.push('own first sample against a clock the two browsers synchronised to each')
  lines.push('other. They are measurements, not estimates from listening.')

  return lines.join('\n')
}
