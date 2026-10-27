'use client'

/**
 * The level history behind the live waveform.
 *
 * Both halves of the tape are drawn from these: your own filled by the capture
 * worklet, your friend's by envelope packets arriving over the data channel.
 * Storing a fixed 50 points per second (rather than one per packet) means the
 * two halves share an x-axis even though they arrive on different schedules
 * over a connection with jitter -- which is what makes the picture an honest
 * representation of sync rather than a drawing of network conditions.
 */

export const ENVELOPE_HZ = 50

export class EnvelopeTrack {
  private peaks: Float32Array
  private rmsValues: Float32Array
  private count = 0

  constructor(initialSeconds = 120) {
    const capacity = Math.max(1, Math.round(initialSeconds * ENVELOPE_HZ))
    this.peaks = new Float32Array(capacity)
    this.rmsValues = new Float32Array(capacity)
  }

  get length(): number {
    return this.count
  }

  get durationSec(): number {
    return this.count / ENVELOPE_HZ
  }

  /**
   * Writes a level at a position in SECONDS, not at "the next slot".
   *
   * A late or duplicated packet lands where it belongs on the timeline, and a
   * dropped one leaves a gap that is drawn as a gap, instead of shifting
   * everything after it leftward and quietly faking alignment.
   */
  writeAt(seconds: number, peak: number, rms: number): void {
    const index = Math.max(0, Math.round(seconds * ENVELOPE_HZ))
    this.ensure(index + 1)
    this.peaks[index] = Math.max(this.peaks[index] as number, peak)
    this.rmsValues[index] = Math.max(this.rmsValues[index] as number, rms)
    if (index + 1 > this.count) this.count = index + 1
  }

  push(peak: number, rms: number): void {
    this.ensure(this.count + 1)
    this.peaks[this.count] = peak
    this.rmsValues[this.count] = rms
    this.count += 1
  }

  peakAt(index: number): number {
    return index >= 0 && index < this.count ? (this.peaks[index] as number) : 0
  }

  rmsAt(index: number): number {
    return index >= 0 && index < this.count ? (this.rmsValues[index] as number) : 0
  }

  /** Highest peak over a span, so zooming out never hides a clip. */
  peakOver(from: number, to: number): number {
    let max = 0
    const start = Math.max(0, Math.floor(from))
    const end = Math.min(this.count, Math.ceil(to))
    for (let i = start; i < end; i += 1) {
      const v = this.peaks[i] as number
      if (v > max) max = v
    }
    return max
  }

  rmsOver(from: number, to: number): number {
    let sum = 0
    let n = 0
    const start = Math.max(0, Math.floor(from))
    const end = Math.min(this.count, Math.ceil(to))
    for (let i = start; i < end; i += 1) {
      sum += this.rmsValues[i] as number
      n += 1
    }
    return n > 0 ? sum / n : 0
  }

  clear(): void {
    this.peaks.fill(0)
    this.rmsValues.fill(0)
    this.count = 0
  }

  /** Builds an envelope from finished audio, for the review screen. */
  static fromSamples(samples: Float32Array, sampleRate: number): EnvelopeTrack {
    const track = new EnvelopeTrack(samples.length / sampleRate + 1)
    const window = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ))
    for (let start = 0; start < samples.length; start += window) {
      let peak = 0
      let sum = 0
      const end = Math.min(samples.length, start + window)
      for (let i = start; i < end; i += 1) {
        const s = samples[i] as number
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
        sum += s * s
      }
      track.push(peak, Math.sqrt(sum / Math.max(1, end - start)))
    }
    return track
  }

  private ensure(size: number): void {
    if (size <= this.peaks.length) return
    let capacity = this.peaks.length
    while (capacity < size) capacity *= 2
    const peaks = new Float32Array(capacity)
    peaks.set(this.peaks)
    const rms = new Float32Array(capacity)
    rms.set(this.rmsValues)
    this.peaks = peaks
    this.rmsValues = rms
  }
}
