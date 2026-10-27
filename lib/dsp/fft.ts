/**
 * Iterative radix-2 complex FFT, in place.
 *
 * Written out rather than pulled from a library because the whole DSP chain
 * runs in a worker on a phone, and this is the hot loop: a thousand frames per
 * second of audio, each transformed twice.
 */

export class FFT {
  private readonly cos: Float32Array
  private readonly sin: Float32Array
  private readonly reverse: Uint32Array

  constructor(readonly size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two')

    this.cos = new Float32Array(size / 2)
    this.sin = new Float32Array(size / 2)
    for (let i = 0; i < size / 2; i += 1) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size)
    }

    const bits = Math.log2(size)
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i += 1) {
      let r = 0
      for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.reverse[i] = r
    }
  }

  /** Forward transform. `inverse` conjugates and scales for the round trip. */
  transform(real: Float32Array, imag: Float32Array, inverse = false): void {
    const n = this.size

    for (let i = 0; i < n; i += 1) {
      const j = this.reverse[i] as number
      if (j > i) {
        const tr = real[i] as number
        real[i] = real[j] as number
        real[j] = tr
        const ti = imag[i] as number
        imag[i] = imag[j] as number
        imag[j] = ti
      }
    }

    const sign = inverse ? -1 : 1

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j += 1, k += step) {
          const wr = this.cos[k] as number
          const wi = (this.sin[k] as number) * sign
          const a = j + half
          const tr = wr * (real[a] as number) - wi * (imag[a] as number)
          const ti = wr * (imag[a] as number) + wi * (real[a] as number)
          real[a] = (real[j] as number) - tr
          imag[a] = (imag[j] as number) - ti
          real[j] = (real[j] as number) + tr
          imag[j] = (imag[j] as number) + ti
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i += 1) {
        real[i] = (real[i] as number) / n
        imag[i] = (imag[i] as number) / n
      }
    }
  }
}

/** Periodic Hann, square-rooted so analysis and synthesis together sum to one. */
export function sqrtHann(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i += 1) {
    w[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / size)))
  }
  return w
}
