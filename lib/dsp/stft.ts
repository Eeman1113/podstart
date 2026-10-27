import { FFT, sqrtHann } from '@/lib/dsp/fft'

/**
 * Overlap-add STFT with a spectral callback.
 *
 * 1024 / 256 at 48 kHz is 21 ms frames at 75 % overlap: fine enough in
 * frequency to separate a voice from room tone, short enough in time not to
 * smear consonants. Square-root Hann on both ends makes the overlap-add exact,
 * so a pass-through callback returns the signal bit for bit.
 */

export interface SpectralFrame {
  real: Float32Array
  imag: Float32Array
  /** |X| for each bin, filled before the callback runs. */
  magnitude: Float32Array
  /** Frame index since the start of the signal. */
  index: number
  bins: number
  binHz: number
}

export type SpectralProcessor = (frame: SpectralFrame) => void

export function processSpectral(
  input: Float32Array,
  sampleRate: number,
  process: SpectralProcessor,
  frameSize = 1024,
  hop = 256,
): Float32Array {
  const fft = new FFT(frameSize)
  const window = sqrtHann(frameSize)
  const bins = frameSize / 2 + 1
  const binHz = sampleRate / frameSize

  const output = new Float32Array(input.length)
  const real = new Float32Array(frameSize)
  const imag = new Float32Array(frameSize)
  const magnitude = new Float32Array(bins)

  let index = 0
  // Start negative so the first real samples get full overlap-add coverage.
  for (let start = -frameSize + hop; start < input.length; start += hop) {
    for (let i = 0; i < frameSize; i += 1) {
      const s = start + i
      real[i] = s >= 0 && s < input.length ? (input[s] as number) * (window[i] as number) : 0
      imag[i] = 0
    }

    fft.transform(real, imag, false)

    for (let k = 0; k < bins; k += 1) {
      const re = real[k] as number
      const im = imag[k] as number
      magnitude[k] = Math.sqrt(re * re + im * im)
    }

    process({ real, imag, magnitude, index, bins, binHz })

    // Restore conjugate symmetry so the inverse transform stays real.
    for (let k = 1; k < frameSize / 2; k += 1) {
      real[frameSize - k] = real[k] as number
      imag[frameSize - k] = -(imag[k] as number)
    }
    imag[0] = 0
    imag[frameSize / 2] = 0

    fft.transform(real, imag, true)

    for (let i = 0; i < frameSize; i += 1) {
      const s = start + i
      if (s >= 0 && s < output.length) {
        output[s] = (output[s] as number) + (real[i] as number) * (window[i] as number)
      }
    }

    index += 1
  }

  return output
}
