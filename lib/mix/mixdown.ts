'use client'

import { correctDrift, resample } from '@/lib/mix/resample'
import { limit, measureLoudness, PODCAST_TARGET_LUFS, type LoudnessReport } from '@/lib/dsp/loudness'
import { wavBlob } from '@/lib/audio/wav'

/**
 * The mixdown: two independently recorded stems and some jingles, rendered to
 * one aligned file.
 *
 * Alignment comes from the numbers the recorders captured, not from listening:
 *
 *   - every stem knows the shared-clock instant of its own first sample, so
 *     the gap between them is a subtraction rather than a guess;
 *   - every stem knows how far its capture clock drifted, which is corrected
 *     by resampling before anything is placed.
 *
 * That is the step you have been doing by hand, and it is exact.
 */

export interface Stem {
  id: string
  name: string
  samples: Float32Array
  sampleRate: number
  /** Shared-clock epoch of the first sample. */
  startEpochMs: number
  driftPpm: number | null
  gainDb: number
  muted: boolean
  /** -1 hard left to +1 hard right. 0 for a mono-compatible podcast. */
  pan: number
  /** Manual nudge in milliseconds, for taste or device calibration. */
  nudgeMs: number
}

export interface JinglePlacement {
  id: string
  name: string
  samples: Float32Array
  sampleRate: number
  /** Seconds from the start of the programme. */
  atSec: number
  gainDb: number
  fadeInMs: number
  fadeOutMs: number
  /** How far to pull the voices down underneath, in dB. 0 for a sting. */
  duckDb: number
}

export interface MixSettings {
  sampleRate: number
  channels: 1 | 2
  targetLufs: number
  /** Trim leading silence before the first voice. */
  trimHead: boolean
  /** Seconds of room left before the first word and after the last. */
  headroomSec: number

  /**
   * Mastering: bring the programme to the target loudness and hold the
   * inter-sample peak under the ceiling.
   *
   * Switched off for a raw take. Note that off means OFF -- the sum of two
   * voices can and will exceed 0 dBFS, and nothing here will stop it. That is
   * the correct behaviour when you have asked for the samples untouched.
   */
  master: boolean

  /**
   * Resample each stem to undo its measured capture-clock drift.
   *
   * This is the one alignment step that actually rewrites samples, which is
   * why it is separable from the rest. With it off, a long take will slowly
   * drift apart -- but every sample is the one the microphone produced.
   */
  correctDrift: boolean
}

export const DEFAULT_MIX: MixSettings = {
  sampleRate: 48000,
  // Mono by default: speech has no stereo information, mono halves the file,
  // and it removes any chance of one voice vanishing on a phone speaker.
  channels: 1,
  targetLufs: PODCAST_TARGET_LUFS,
  trimHead: true,
  headroomSec: 0.4,
  master: true,
  correctDrift: true,
}

/**
 * Raw: place the stems on one timeline and sum them, and do nothing else.
 *
 * No trim, no loudness, no limiting, no drift resampling. Combined with raw
 * stems this produces a mix whose every sample is traceable to a microphone.
 */
export const RAW_MIX: MixSettings = {
  sampleRate: 48000,
  channels: 1,
  targetLufs: PODCAST_TARGET_LUFS,
  trimHead: false,
  headroomSec: 0,
  master: false,
  correctDrift: false,
}

export interface MixResult {
  samples: Float32Array
  sampleRate: number
  channels: number
  durationSec: number
  loudness: LoudnessReport
  /** Where each stem landed, for the timeline UI and for sanity-checking. */
  placement: { id: string; offsetSec: number; durationSec: number }[]
  /** Gap between the two stems' first samples, in ms. The sync proof. */
  spreadMs: number
  /** Exactly which stages touched the samples, so the UI can say so. */
  applied: {
    driftCorrection: boolean
    headTrim: boolean
    loudnessNormalisation: boolean
    limiting: boolean
    resampling: boolean
  }
}

export async function mixdown(
  stems: Stem[],
  jingles: JinglePlacement[],
  settings: MixSettings = DEFAULT_MIX,
): Promise<MixResult> {
  const active = stems.filter((s) => !s.muted && s.samples.length > 0)
  if (active.length === 0) throw new Error('Nothing to mix: every track is empty or muted.')

  const rate = settings.sampleRate

  // Everything is placed relative to whoever started first.
  const origin = Math.min(...active.map((s) => s.startEpochMs + s.nudgeMs))
  const spreadMs =
    active.length > 1
      ? Math.max(...active.map((s) => s.startEpochMs)) - Math.min(...active.map((s) => s.startEpochMs))
      : 0

  let resampledAnything = false

  const prepared = active.map((stem) => {
    let samples = stem.samples

    if (settings.correctDrift) {
      const corrected = correctDrift(samples, stem.driftPpm)
      if (corrected !== samples) resampledAnything = true
      samples = corrected
    }

    // A rate mismatch has to be resolved even in raw mode: you cannot place
    // 44.1 kHz and 48 kHz audio on one timeline without converting one of them.
    if (stem.sampleRate !== rate) {
      samples = resample(samples, stem.sampleRate / rate)
      resampledAnything = true
    }

    const offsetSec = (stem.startEpochMs + stem.nudgeMs - origin) / 1000
    return { stem, samples, offsetSec }
  })

  const voiceEndSec = Math.max(...prepared.map((p) => p.offsetSec + p.samples.length / rate))
  const jingleEndSec = jingles.reduce(
    (max, j) => Math.max(max, j.atSec + j.samples.length / j.sampleRate),
    0,
  )

  // Leading trim: the countdown and the "are you there?" never belong in the
  // published file, but a hard cut at the first word sounds abrupt.
  let headTrimSec = 0
  if (settings.trimHead) {
    const firstVoice = Math.min(
      ...prepared.map((p) => p.offsetSec + firstSoundSec(p.samples, rate)),
    )
    headTrimSec = Math.max(0, firstVoice - settings.headroomSec)
  }

  const durationSec =
    Math.max(voiceEndSec, jingleEndSec) - headTrimSec + settings.headroomSec
  const frames = Math.ceil(durationSec * rate)
  if (frames <= 0) throw new Error('The mix came out empty.')

  const ctx = new OfflineAudioContext(settings.channels, frames, rate)
  const master = ctx.createGain()
  master.gain.value = 1
  master.connect(ctx.destination)

  // Ducking is one automation curve applied to all voices together, so the two
  // of you never duck by different amounts under the same bed.
  const voiceBus = ctx.createGain()
  voiceBus.gain.value = 1
  voiceBus.connect(master)
  scheduleDucking(ctx, voiceBus.gain, jingles, headTrimSec)

  const placement: MixResult['placement'] = []

  for (const { stem, samples, offsetSec } of prepared) {
    const buffer = ctx.createBuffer(1, samples.length, rate)
    buffer.getChannelData(0).set(samples)

    const source = ctx.createBufferSource()
    source.buffer = buffer

    const gain = ctx.createGain()
    gain.gain.value = 10 ** (stem.gainDb / 20)

    let tail: AudioNode = gain
    if (settings.channels === 2 && stem.pan !== 0) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, stem.pan))
      gain.connect(panner)
      tail = panner
    }

    source.connect(gain)
    tail.connect(voiceBus)

    const at = offsetSec - headTrimSec
    // A stem that starts before the trim point is started mid-buffer rather
    // than late, so its content stays on the timeline.
    if (at >= 0) source.start(at)
    else source.start(0, -at)

    placement.push({ id: stem.id, offsetSec: at, durationSec: samples.length / rate })
  }

  for (const jingle of jingles) {
    const samples =
      jingle.sampleRate === rate ? jingle.samples : resample(jingle.samples, jingle.sampleRate / rate)

    const buffer = ctx.createBuffer(1, samples.length, rate)
    buffer.getChannelData(0).set(samples)

    const source = ctx.createBufferSource()
    source.buffer = buffer

    const gain = ctx.createGain()
    const level = 10 ** (jingle.gainDb / 20)
    const at = Math.max(0, jingle.atSec - headTrimSec)
    const lengthSec = samples.length / rate

    const fadeIn = jingle.fadeInMs / 1000
    const fadeOut = jingle.fadeOutMs / 1000
    gain.gain.setValueAtTime(fadeIn > 0 ? 0.0001 : level, at)
    if (fadeIn > 0) gain.gain.exponentialRampToValueAtTime(level, at + fadeIn)
    if (fadeOut > 0 && lengthSec > fadeOut) {
      gain.gain.setValueAtTime(level, at + lengthSec - fadeOut)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + lengthSec)
    }

    source.connect(gain)
    gain.connect(master)
    source.start(at)
  }

  const rendered = await ctx.startRendering()

  const channels = settings.channels
  const interleaved = new Float32Array(rendered.length * channels)
  for (let c = 0; c < channels; c += 1) {
    const data = rendered.getChannelData(c)
    for (let i = 0; i < rendered.length; i += 1) {
      interleaved[i * channels + c] = data[i] as number
    }
  }

  // Final loudness pass on the finished programme, because the mix of two
  // normalised stems is not itself at the target. Skipped entirely for a raw
  // take: there, the sum is the deliverable, overs and all.
  if (settings.master) {
    const before = measureLoudness(interleaved, rate)
    const gain = 10 ** ((settings.targetLufs - before.lufs) / 20)
    for (let i = 0; i < interleaved.length; i += 1) {
      interleaved[i] = (interleaved[i] as number) * gain
    }
    limit(interleaved, rate, -1)
  }

  return {
    samples: interleaved,
    sampleRate: rate,
    channels,
    durationSec: rendered.length / rate,
    loudness: measureLoudness(interleaved, rate),
    placement,
    spreadMs,
    applied: {
      driftCorrection: settings.correctDrift && resampledAnything,
      headTrim: headTrimSec > 0,
      loudnessNormalisation: settings.master,
      limiting: settings.master,
      resampling: resampledAnything,
    },
  }
}

/** Seconds until the signal first rises meaningfully above its own floor. */
function firstSoundSec(samples: Float32Array, sampleRate: number): number {
  const window = Math.round(sampleRate * 0.02)
  const threshold = 0.012 // about -38 dBFS
  for (let start = 0; start + window < samples.length; start += window) {
    let sum = 0
    for (let i = 0; i < window; i += 1) {
      const s = samples[start + i] as number
      sum += s * s
    }
    if (Math.sqrt(sum / window) > threshold) return start / sampleRate
  }
  return 0
}

function scheduleDucking(
  ctx: BaseAudioContext,
  param: AudioParam,
  jingles: JinglePlacement[],
  headTrimSec: number,
): void {
  const ducks = jingles.filter((j) => j.duckDb < 0)
  param.setValueAtTime(1, 0)
  if (ducks.length === 0) return

  for (const jingle of ducks) {
    const at = Math.max(0, jingle.atSec - headTrimSec)
    const lengthSec = jingle.samples.length / jingle.sampleRate
    const level = 10 ** (jingle.duckDb / 20)
    const ramp = 0.25

    param.setValueAtTime(1, at)
    param.linearRampToValueAtTime(level, at + ramp)
    param.setValueAtTime(level, at + Math.max(ramp, lengthSec - ramp))
    param.linearRampToValueAtTime(1, at + lengthSec)
  }
}

export function mixToWav(result: MixResult): Blob {
  return wavBlob(result.samples, result.sampleRate, result.channels, 24)
}
