/**
 * Resampling, used for two jobs: correcting capture-clock drift, and bringing
 * a stem recorded at 44.1 kHz onto the 48 kHz timeline.
 *
 * Catmull-Rom interpolation rather than linear. For drift correction the ratio
 * is within a hair of 1:1 and linear would be fine, but a jingle imported at
 * 44.1 kHz is a real ratio change, and linear interpolation there audibly
 * dulls the top octave.
 */
export function resample(input: Float32Array, ratio: number): Float32Array {
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-9) return input

  const length = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(length)

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const t = position - index

    const p0 = input[Math.max(0, index - 1)] as number
    const p1 = input[Math.min(input.length - 1, index)] as number
    const p2 = input[Math.min(input.length - 1, index + 1)] as number
    const p3 = input[Math.min(input.length - 1, index + 2)] as number

    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3
    const c = -0.5 * p0 + 0.5 * p2

    output[i] = ((a * t + b) * t + c) * t + p1
  }

  return output
}

/**
 * Corrects a stem for measured capture-clock drift.
 *
 * A device whose audio clock ran 40 ppm fast produced 40 extra samples per
 * million, so its recording is slightly LONGER than the real time it covers.
 * Left uncorrected the two voices separate by about 150 ms across an hour,
 * which is the slow drift that makes long remote recordings fall apart even
 * when the start was aligned perfectly.
 */
export function correctDrift(input: Float32Array, driftPpm: number | null): Float32Array {
  if (!driftPpm || !Number.isFinite(driftPpm) || Math.abs(driftPpm) < 1) return input
  return resample(input, 1 + driftPpm / 1e6)
}
