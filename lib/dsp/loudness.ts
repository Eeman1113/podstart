/**
 * Loudness to ITU-R BS.1770-4, which is what every podcast platform measures.
 *
 * Spotify, Apple Podcasts and YouTube all normalise to roughly -16 to -14 LUFS
 * for speech. Delivering at the target yourself means the platform leaves your
 * mix alone instead of turning it up and bringing the noise floor with it --
 * and it is the reason two voices recorded on different phones in different
 * rooms end up sounding like one show.
 *
 * The measurement is: K-weight (a shelf plus a high-pass that approximate how
 * loud we actually perceive things), mean-square over 400 ms blocks, then a
 * two-stage gate that throws away silence so pauses cannot drag the number
 * down.
 */

export const PODCAST_TARGET_LUFS = -16
export const PODCAST_TRUE_PEAK_CEILING_DB = -1

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** Stage 1 of K-weighting: a high-frequency shelf, per BS.1770 Table 1. */
function shelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533
  const G = 3.999843853973347
  const Q = 0.7071752369554196

  const K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = 10 ** (G / 20)
  const Vb = Vh ** 0.4996667741545416
  const denominator = 1 + K / Q + K * K

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / denominator,
    b1: (2 * (K * K - Vh)) / denominator,
    b2: (Vh - (Vb * K) / Q + K * K) / denominator,
    a1: (2 * (K * K - 1)) / denominator,
    a2: (1 - K / Q + K * K) / denominator,
  }
}

/** Stage 2 of K-weighting: a high-pass around 38 Hz. */
function highpass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444
  const Q = 0.5003270373238773
  const K = Math.tan((Math.PI * f0) / sampleRate)
  const denominator = 1 + K / Q + K * K

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / denominator,
    a2: (1 - K / Q + K * K) / denominator,
  }
}

function filter(input: Float32Array, c: Biquad): Float32Array {
  const output = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i] as number
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    output[i] = y
  }
  return output
}

export interface LoudnessReport {
  /** Integrated programme loudness. */
  lufs: number
  /** Loudness range: how much the level moves across the programme. */
  lra: number
  /** Inter-sample peak, in dBTP. */
  truePeakDb: number
  /** Simple sample peak, in dBFS. */
  peakDb: number
}

export function measureLoudness(input: Float32Array, sampleRate: number): LoudnessReport {
  const weighted = filter(filter(input, shelf(sampleRate)), highpass(sampleRate))

  const blockSize = Math.round(sampleRate * 0.4)
  const step = Math.round(blockSize / 4) // 75 % overlap, per the spec
  const blocks: number[] = []

  for (let start = 0; start + blockSize <= weighted.length; start += step) {
    let sum = 0
    for (let i = 0; i < blockSize; i += 1) {
      const s = weighted[start + i] as number
      sum += s * s
    }
    blocks.push(sum / blockSize)
  }

  if (blocks.length === 0) {
    return { lufs: -70, lra: 0, truePeakDb: -Infinity, peakDb: -Infinity }
  }

  const loudnessOf = (meanSquare: number) => -0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-12))

  // Absolute gate at -70 LUFS, then a relative gate 10 dB below the result.
  const aboveAbsolute = blocks.filter((b) => loudnessOf(b) > -70)
  if (aboveAbsolute.length === 0) {
    return { lufs: -70, lra: 0, truePeakDb: -Infinity, peakDb: -Infinity }
  }

  const firstPass = loudnessOf(aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length)
  const relativeGate = firstPass - 10
  const gated = aboveAbsolute.filter((b) => loudnessOf(b) > relativeGate)
  const pool = gated.length > 0 ? gated : aboveAbsolute
  const lufs = loudnessOf(pool.reduce((a, b) => a + b, 0) / pool.length)

  // Loudness range: the 10th to 95th percentile spread of the gated blocks.
  const sorted = pool.map(loudnessOf).sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number
  const lra = at(0.95) - at(0.1)

  let peak = 0
  for (let i = 0; i < input.length; i += 1) {
    const a = Math.abs(input[i] as number)
    if (a > peak) peak = a
  }

  return {
    lufs,
    lra,
    truePeakDb: truePeak(input),
    peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
  }
}

/**
 * Inter-sample peak.
 *
 * A signal that never exceeds 0 dBFS at its sample points can still exceed it
 * between them, and an MP3 or AAC encoder will reconstruct that overshoot and
 * clip it. Four-times oversampling with a short windowed-sinc is the standard
 * approximation and catches the overwhelming majority of it.
 */
export function truePeak(input: Float32Array): number {
  const factor = 4
  const taps = 16
  let peak = 0

  for (let i = 0; i < input.length; i += 1) {
    const direct = Math.abs(input[i] as number)
    if (direct > peak) peak = direct

    for (let phase = 1; phase < factor; phase += 1) {
      const offset = phase / factor
      let sum = 0
      for (let t = -taps / 2; t < taps / 2; t += 1) {
        const index = i + t
        if (index < 0 || index >= input.length) continue
        const x = Math.PI * (offset - t)
        const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x
        // Hann window over the tap range keeps the kernel short and ripple low.
        const w = 0.5 * (1 + Math.cos((2 * Math.PI * (offset - t)) / taps))
        sum += (input[index] as number) * sinc * w
      }
      const a = Math.abs(sum)
      if (a > peak) peak = a
    }
  }

  return 20 * Math.log10(Math.max(peak, 1e-9))
}

/**
 * Brings a signal to the target, then holds the inter-sample peak under the
 * ceiling with a short look-ahead limiter rather than hard clipping.
 */
export function normalise(
  input: Float32Array,
  sampleRate: number,
  targetLufs = PODCAST_TARGET_LUFS,
  ceilingDb = PODCAST_TRUE_PEAK_CEILING_DB,
): { output: Float32Array; applied: LoudnessReport; gainDb: number } {
  const before = measureLoudness(input, sampleRate)
  const gainDb = targetLufs - before.lufs
  const gain = 10 ** (gainDb / 20)

  const output = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 1) output[i] = (input[i] as number) * gain

  limit(output, sampleRate, ceilingDb)

  return { output, applied: measureLoudness(output, sampleRate), gainDb }
}

/**
 * Look-ahead limiter. Gain is reduced smoothly BEFORE a peak arrives, so the
 * ceiling is held without the distortion a clipper would add.
 */
export function limit(samples: Float32Array, sampleRate: number, ceilingDb: number): void {
  const ceiling = 10 ** (ceilingDb / 20)
  const lookAhead = Math.round(sampleRate * 0.005)
  const release = Math.exp(-1 / (0.05 * sampleRate))

  const gains = new Float32Array(samples.length).fill(1)

  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i] as number)
    if (magnitude <= ceiling) continue

    const required = ceiling / magnitude
    // Ramp into the reduction across the look-ahead window.
    for (let j = Math.max(0, i - lookAhead); j <= i; j += 1) {
      const progress = (j - (i - lookAhead)) / lookAhead
      const target = 1 + (required - 1) * progress
      if (target < (gains[j] as number)) gains[j] = target
    }
  }

  // Release: recover gradually so the level does not jump back.
  let current = 1
  for (let i = 0; i < samples.length; i += 1) {
    const target = gains[i] as number
    current = target < current ? target : release * current + (1 - release) * target
    samples[i] = (samples[i] as number) * current
  }
}
