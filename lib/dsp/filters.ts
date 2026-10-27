/**
 * Small, surgical fixes that run either side of the big spectral stages.
 */

interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number
}

function applyBiquad(input: Float32Array, c: Biquad, output = new Float32Array(input.length)) {
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

function highpassCoefficients(sampleRate: number, frequency: number, q: number): Biquad {
  const w = (2 * Math.PI * frequency) / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

/**
 * Rumble filter.
 *
 * Below about 80 Hz a spoken voice has nothing but desk bumps, footsteps,
 * traffic and the handling noise of a phone being held. Two cascaded
 * second-order sections give a 24 dB/octave slope, steep enough to clear it
 * without touching the body of the voice.
 */
export function highpass(input: Float32Array, sampleRate: number, frequency = 80): Float32Array {
  const stage1 = highpassCoefficients(sampleRate, frequency, 0.54)
  const stage2 = highpassCoefficients(sampleRate, frequency, 1.31)
  return applyBiquad(applyBiquad(input, stage1), stage2)
}

/**
 * De-click.
 *
 * Phone recordings pick up isolated sample-level discontinuities from buffer
 * glitches and from fingernails on a case. We find samples whose neighbours
 * disagree with them far more than the local signal justifies, and replace
 * each with an interpolation of its surroundings.
 */
export function declick(input: Float32Array, sensitivity = 1): { output: Float32Array; repaired: number } {
  const output = Float32Array.from(input)
  const window = 32
  let repaired = 0

  for (let i = 2; i < input.length - 2; i += 1) {
    const predicted = ((output[i - 1] as number) + (output[i + 1] as number)) / 2
    const error = Math.abs((output[i] as number) - predicted)
    if (error < 0.02) continue

    // Local activity, so a loud passage is not flagged as a click.
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - window); j < Math.min(input.length, i + window); j += 1) {
      sum += Math.abs(input[j] as number)
      count += 1
    }
    const local = sum / Math.max(count, 1)

    if (error > Math.max(0.05, local * 6) / sensitivity) {
      output[i] = predicted
      repaired += 1
    }
  }

  return { output, repaired }
}

/**
 * Gentle de-esser.
 *
 * Phone microphones exaggerate sibilance, and denoising makes it worse by
 * removing everything around it. This pulls down 5-9 kHz only while an "s" is
 * actually happening, which is the difference between a de-esser and simply
 * dulling the recording.
 */
export function deEss(input: Float32Array, sampleRate: number, amount = 0.5): Float32Array {
  if (amount <= 0) return input

  // Band-pass the sibilance region to use as the detector.
  const low = highpassCoefficients(sampleRate, 5000, 0.7)
  const detector = applyBiquad(input, low)

  const output = Float32Array.from(input)
  const attack = Math.exp(-1 / (0.001 * sampleRate))
  const release = Math.exp(-1 / (0.05 * sampleRate))
  const threshold = 0.08
  let envelope = 0

  for (let i = 0; i < input.length; i += 1) {
    const level = Math.abs(detector[i] as number)
    const coefficient = level > envelope ? attack : release
    envelope = coefficient * envelope + (1 - coefficient) * level

    if (envelope > threshold) {
      const excess = (envelope - threshold) / threshold
      const reduction = 1 - Math.min(0.7, excess * amount)
      // Only the sibilant band is attenuated; the rest passes untouched.
      output[i] = (input[i] as number) - (detector[i] as number) * (1 - reduction)
    }
  }

  return output
}

/**
 * Fades, applied at the very ends so a stem never starts or stops on a step.
 */
export function fadeEnds(samples: Float32Array, sampleRate: number, ms = 8): Float32Array {
  const n = Math.min(Math.round((ms / 1000) * sampleRate), Math.floor(samples.length / 2))
  for (let i = 0; i < n; i += 1) {
    const g = i / n
    samples[i] = (samples[i] as number) * g
    samples[samples.length - 1 - i] = (samples[samples.length - 1 - i] as number) * g
  }
  return samples
}
