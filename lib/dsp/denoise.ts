import { processSpectral } from '@/lib/dsp/stft'

/**
 * Broadband noise reduction: fans, traffic, hiss, hum, laptop whine.
 *
 * Two engines live in the chain. RNNoise (lib/dsp/rnnoise.ts) is a small
 * recurrent network trained on speech and does the heavy lifting. This module
 * is the classical path -- minimum-statistics noise estimation plus a
 * Wiener-style spectral gain -- and it runs everywhere, with no WebAssembly,
 * as the fallback and as the gentle "preserve the room" option.
 *
 * The noise floor is tracked per frequency band by following the minimum of a
 * sliding window: speech is intermittent, so the quietest thing a band has
 * done recently is a good estimate of what is always there. No "stay silent
 * for five seconds" step required.
 */

export interface DenoiseOptions {
  /** 0 = off, 1 = maximum reduction. */
  strength: number
  /** Deepest cut, in dB. A floor well above silence keeps it natural. */
  maxAttenuationDb?: number
  /** Noise floor tracking window, seconds. */
  windowSeconds?: number
}

export interface DenoiseResult {
  output: Float32Array
  /** Measured input noise floor in dBFS, shown in the UI. */
  noiseFloorDb: number
}

export function denoise(
  input: Float32Array,
  sampleRate: number,
  options: DenoiseOptions,
): DenoiseResult {
  const strength = Math.max(0, Math.min(1, options.strength))
  if (strength === 0) return { output: input, noiseFloorDb: measureNoiseFloor(input, sampleRate) }

  const frameSize = 1024
  const hop = 256
  const bins = frameSize / 2 + 1

  const windowFrames = Math.max(
    8,
    Math.round(((options.windowSeconds ?? 1.5) * sampleRate) / hop),
  )
  const floorGain = 10 ** (-(options.maxAttenuationDb ?? 18) / 20)

  // Sliding minimum per bin, kept cheaply with the two-block trick: track the
  // running minimum and the minimum of the current block, swapping each period.
  const runningMin = new Float32Array(bins).fill(Infinity)
  const blockMin = new Float32Array(bins).fill(Infinity)
  const noise = new Float32Array(bins).fill(1e-6)
  const previousGain = new Float32Array(bins).fill(1)
  let framesInBlock = 0
  let noiseSum = 0
  let noiseCount = 0

  const output = processSpectral(
    input,
    sampleRate,
    (frame) => {
      for (let k = 0; k < bins; k += 1) {
        const m = frame.magnitude[k] as number
        const power = m * m
        if (power < (runningMin[k] as number)) runningMin[k] = power
        if (power < (blockMin[k] as number)) blockMin[k] = power
      }

      framesInBlock += 1
      if (framesInBlock >= windowFrames) {
        for (let k = 0; k < bins; k += 1) {
          runningMin[k] = blockMin[k] as number
          blockMin[k] = Infinity
        }
        framesInBlock = 0
      }

      for (let k = 0; k < bins; k += 1) {
        // The sliding minimum underestimates the true floor by a known factor
        // for a Hann-windowed STFT; 1.5 is the usual bias correction.
        const estimate = (runningMin[k] as number) * 1.5
        // Track upward slowly and downward quickly: a noise floor that rises
        // (an air conditioner starting) should not be mistaken for speech.
        const prev = noise[k] as number
        noise[k] = estimate > prev ? prev * 0.98 + estimate * 0.02 : estimate
      }

      for (let k = 0; k < bins; k += 1) {
        const m = frame.magnitude[k] as number
        const power = m * m
        const n = (noise[k] as number) * (1 + strength * 2)
        // A priori SNR, Wiener gain.
        const snr = Math.max(power - n, 0) / Math.max(n, 1e-12)
        const wiener = snr / (snr + 1)
        const target = Math.max(floorGain, wiener ** (0.5 + strength))

        const prev = previousGain[k] as number
        const a = target > prev ? 0.3 : 0.8
        const smoothed = a * prev + (1 - a) * target
        previousGain[k] = smoothed

        frame.real[k] = (frame.real[k] as number) * smoothed
        frame.imag[k] = (frame.imag[k] as number) * smoothed
      }

      if (frame.index % 8 === 0) {
        let sum = 0
        for (let k = 0; k < bins; k += 1) sum += noise[k] as number
        noiseSum += Math.sqrt(sum / bins)
        noiseCount += 1
      }
    },
    frameSize,
    hop,
  )

  const floor = noiseCount > 0 ? noiseSum / noiseCount : 1e-6
  return { output, noiseFloorDb: 20 * Math.log10(Math.max(floor, 1e-9)) }
}

/** The quietest tenth of the signal, in dBFS: what the room sounds like. */
export function measureNoiseFloor(input: Float32Array, sampleRate: number): number {
  const windowSize = Math.round(sampleRate * 0.05)
  const count = Math.floor(input.length / windowSize)
  if (count < 4) return -90

  const levels = new Float64Array(count)
  for (let w = 0; w < count; w += 1) {
    let sum = 0
    const base = w * windowSize
    for (let i = 0; i < windowSize; i += 1) {
      const s = input[base + i] as number
      sum += s * s
    }
    levels[w] = Math.sqrt(sum / windowSize)
  }

  const sorted = Array.from(levels).sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.1)
  return 20 * Math.log10(Math.max(sorted[idx] as number, 1e-9))
}
