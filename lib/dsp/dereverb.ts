import { processSpectral } from '@/lib/dsp/stft'

/**
 * Room echo removal (dereverberation).
 *
 * The problem: a phone recorded in a normal room picks up the voice, then the
 * same voice again a few milliseconds later off every wall. That smear is what
 * makes home recordings sound "far away" and no amount of EQ fixes it.
 *
 * The method: in any given frequency band, late reverberation is a decayed
 * copy of what that band was doing a moment ago. So we track a running
 * estimate of the reverberant tail
 *
 *     R[k,t] = g * R[k,t-1] + (1-g) * |X[k, t-D]|^2
 *
 * where D is the pre-delay (direct sound is kept; only the tail is targeted)
 * and g comes from the room's measured decay time. Then we apply a Wiener-style
 * gain that removes the estimated tail power while leaving the direct sound:
 *
 *     G[k,t] = max(floor, sqrt(1 - strength * R / |X|^2))
 *
 * The gain is smoothed across time and frequency, because an unsmoothed
 * spectral gain produces the warbling "underwater" artefact that gives cheap
 * noise reduction away.
 */

export interface DereverbOptions {
  /** 0 = off, 1 = remove as much tail as the estimate supports. */
  strength: number
  /** Reverb time in seconds. Measured automatically when omitted. */
  rt60?: number
  /** Direct sound to protect, in milliseconds. */
  preDelayMs?: number
  /** Deepest cut allowed, in dB. Limiting it keeps the result natural. */
  maxAttenuationDb?: number
}

/**
 * Estimates RT60 from the signal's own decays.
 *
 * Speech constantly stops, and what is left ringing in the gaps IS the room.
 * We collect the steepest sustained decay slopes in the broadband energy
 * envelope and extrapolate each to -60 dB.
 */
export function estimateRt60(input: Float32Array, sampleRate: number): number {
  const windowSize = Math.round(sampleRate * 0.02) // 20 ms
  const frames = Math.floor(input.length / windowSize)
  if (frames < 20) return 0.3

  const envelope = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    const base = f * windowSize
    for (let i = 0; i < windowSize; i += 1) {
      const s = input[base + i] as number
      sum += s * s
    }
    envelope[f] = 10 * Math.log10(Math.max(sum / windowSize, 1e-12))
  }

  const slopes: number[] = []
  const minRun = 5 // at least 100 ms of continuous decay
  let runStart = -1

  for (let f = 1; f < frames; f += 1) {
    const falling = (envelope[f] as number) < (envelope[f - 1] as number)
    if (falling) {
      if (runStart < 0) runStart = f - 1
    } else {
      if (runStart >= 0 && f - runStart >= minRun) {
        const drop = (envelope[runStart] as number) - (envelope[f - 1] as number)
        const seconds = ((f - 1 - runStart) * windowSize) / sampleRate
        // Only trust decays deep enough to be a tail rather than a syllable.
        if (drop > 12 && seconds > 0) slopes.push(drop / seconds)
      }
      runStart = -1
    }
  }

  if (slopes.length < 3) return 0.3

  slopes.sort((a, b) => a - b)
  // The median of the gentlest half: the steepest slopes are speech stopping,
  // not the room ringing out.
  const gentle = slopes.slice(0, Math.max(1, Math.floor(slopes.length / 2)))
  const median = gentle[Math.floor(gentle.length / 2)] as number
  const rt60 = 60 / Math.max(median, 1)
  return Math.min(1.5, Math.max(0.12, rt60))
}

export function dereverb(
  input: Float32Array,
  sampleRate: number,
  options: DereverbOptions,
): { output: Float32Array; rt60: number } {
  const strength = Math.max(0, Math.min(1, options.strength))
  if (strength === 0) return { output: input, rt60: options.rt60 ?? 0 }

  const rt60 = options.rt60 ?? estimateRt60(input, sampleRate)

  const frameSize = 1024
  const hop = 256
  const hopSeconds = hop / sampleRate
  const bins = frameSize / 2 + 1

  // Energy decays by 60 dB over rt60 seconds; per hop that is:
  const decayPerHop = 10 ** ((-60 * hopSeconds) / rt60 / 10)
  const smoothing = Math.min(0.95, Math.max(0.5, decayPerHop))

  const preDelayFrames = Math.max(
    1,
    Math.round(((options.preDelayMs ?? 45) / 1000) * sampleRate / hop),
  )
  const floorGain = 10 ** (-(options.maxAttenuationDb ?? 14) / 20)

  // Ring buffer of past frame power, for the delayed term.
  const history: Float32Array[] = []
  for (let i = 0; i <= preDelayFrames; i += 1) history.push(new Float32Array(bins))
  let cursor = 0

  const tail = new Float32Array(bins)
  const previousGain = new Float32Array(bins).fill(1)
  const gain = new Float32Array(bins)

  const output = processSpectral(
    input,
    sampleRate,
    (frame) => {
      const power = history[cursor] as Float32Array
      for (let k = 0; k < bins; k += 1) {
        const m = frame.magnitude[k] as number
        power[k] = m * m
      }

      const delayed = history[(cursor + 1) % history.length] as Float32Array

      for (let k = 0; k < bins; k += 1) {
        tail[k] = smoothing * (tail[k] as number) + (1 - smoothing) * (delayed[k] as number)

        const signal = power[k] as number
        const ratio = (tail[k] as number) / Math.max(signal, 1e-12)
        const reduction = 1 - strength * Math.min(ratio, 1)
        gain[k] = Math.max(floorGain, Math.sqrt(Math.max(reduction, 0)))
      }

      // Smooth across frequency: three-bin box. Neighbouring bins of one voice
      // should not receive wildly different gains.
      for (let k = 1; k < bins - 1; k += 1) {
        gain[k] = ((gain[k - 1] as number) + (gain[k] as number) * 2 + (gain[k + 1] as number)) / 4
      }

      // Smooth across time, asymmetrically: open fast so transients survive,
      // close slowly so the tail is suppressed smoothly.
      for (let k = 0; k < bins; k += 1) {
        const target = gain[k] as number
        const prev = previousGain[k] as number
        const a = target > prev ? 0.4 : 0.85
        const smoothed = a * prev + (1 - a) * target
        previousGain[k] = smoothed
        frame.real[k] = (frame.real[k] as number) * smoothed
        frame.imag[k] = (frame.imag[k] as number) * smoothed
      }

      cursor = (cursor + 1) % history.length
    },
    frameSize,
    hop,
  )

  return { output, rt60 }
}
