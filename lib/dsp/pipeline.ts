import { declick, deEss, fadeEnds, highpass } from '@/lib/dsp/filters'
import { denoise, measureNoiseFloor } from '@/lib/dsp/denoise'
import { dereverb, estimateRt60 } from '@/lib/dsp/dereverb'
import { measureLoudness, normalise, PODCAST_TARGET_LUFS, type LoudnessReport } from '@/lib/dsp/loudness'
import { rnnoiseDenoise } from '@/lib/dsp/rnnoise'

/**
 * The cleanup chain, in the order it has to run.
 *
 * Order is not a matter of taste here:
 *
 *   1. de-click first, so a single bad sample is not smeared across a whole
 *      spectral frame by everything downstream;
 *   2. high-pass next, because rumble steals headroom from every later stage
 *      and contributes nothing to a voice;
 *   3. denoise before dereverb, since the reverb estimator assumes what it is
 *      watching decay is the room and not a fan;
 *   4. dereverb;
 *   5. de-ess, because the two stages above make sibilance more prominent by
 *      removing what used to mask it;
 *   6. loudness last, so the number we deliver is the number of the finished
 *      audio.
 */

export interface CleanupSettings {
  denoise: number    // 0..1
  dereverb: number   // 0..1
  deEss: number      // 0..1
  highpassHz: number // 0 disables
  declick: boolean
  targetLufs: number
  /** RNNoise when available, the classical path otherwise. */
  engine: 'neural' | 'classical'
}

export const DEFAULT_CLEANUP: CleanupSettings = {
  // Deliberately short of 1. Full-strength denoising eats breaths and room
  // tone, and a podcast with no breaths sounds like a hostage video.
  denoise: 0.85,
  dereverb: 0.6,
  deEss: 0.4,
  highpassHz: 80,
  declick: true,
  targetLufs: PODCAST_TARGET_LUFS,
  engine: 'neural',
}

export interface CleanupReport {
  before: LoudnessReport
  after: LoudnessReport
  noiseFloorBeforeDb: number
  noiseFloorAfterDb: number
  rt60Seconds: number
  clicksRepaired: number
  gainAppliedDb: number
  speechConfidence: number | null
  engineUsed: 'neural' | 'classical'
  elapsedMs: number
}

export interface CleanupResult {
  output: Float32Array
  report: CleanupReport
}

export type ProgressFn = (stage: string, fraction: number) => void

export async function runCleanup(
  input: Float32Array,
  sampleRate: number,
  settings: CleanupSettings,
  basePath: string,
  onProgress: ProgressFn = () => {},
): Promise<CleanupResult> {
  const startedAt = Date.now()
  const before = measureLoudness(input, sampleRate)
  const noiseFloorBeforeDb = measureNoiseFloor(input, sampleRate)

  let signal = input
  let clicksRepaired = 0
  let speechConfidence: number | null = null
  let engineUsed: CleanupSettings['engine'] = settings.engine

  if (settings.declick) {
    onProgress('Repairing clicks', 0.05)
    const result = declick(signal)
    signal = result.output
    clicksRepaired = result.repaired
  }

  if (settings.highpassHz > 0) {
    onProgress('Clearing rumble', 0.15)
    signal = highpass(signal, sampleRate, settings.highpassHz)
  }

  if (settings.denoise > 0) {
    onProgress('Removing noise', 0.25)
    let done = false
    if (settings.engine === 'neural' && sampleRate === 48000) {
      try {
        const result = await rnnoiseDenoise(
          signal,
          sampleRate,
          basePath,
          settings.denoise,
          (f) => onProgress('Removing noise', 0.25 + f * 0.3),
        )
        signal = result.output
        speechConfidence = result.speechConfidence
        done = true
      } catch {
        // Falling back is better than failing: the classical denoiser needs no
        // WebAssembly and works at any sample rate.
        engineUsed = 'classical'
      }
    } else {
      engineUsed = 'classical'
    }

    if (!done) {
      const result = denoise(signal, sampleRate, { strength: settings.denoise })
      signal = result.output
    }
  }

  let rt60Seconds = 0
  if (settings.dereverb > 0) {
    onProgress('Removing room echo', 0.6)
    const result = dereverb(signal, sampleRate, { strength: settings.dereverb })
    signal = result.output
    rt60Seconds = result.rt60
  } else {
    rt60Seconds = estimateRt60(signal, sampleRate)
  }

  if (settings.deEss > 0) {
    onProgress('Taming sibilance', 0.8)
    signal = deEss(signal, sampleRate, settings.deEss)
  }

  onProgress('Setting loudness', 0.9)
  const normalised = normalise(signal, sampleRate, settings.targetLufs)
  const output = fadeEnds(normalised.output, sampleRate)

  onProgress('Done', 1)

  return {
    output,
    report: {
      before,
      after: normalised.applied,
      noiseFloorBeforeDb,
      noiseFloorAfterDb: measureNoiseFloor(output, sampleRate),
      rt60Seconds,
      clicksRepaired,
      gainAppliedDb: normalised.gainDb,
      speechConfidence,
      engineUsed,
      elapsedMs: Date.now() - startedAt,
    },
  }
}
