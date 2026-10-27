/**
 * podstart capture worklet
 *
 * Runs on the audio render thread. Hand-written plain JS and served as a static
 * file because AudioWorklet modules are fetched by URL, not bundled.
 *
 * Three jobs:
 *
 *  1. Hand the untouched Float32 samples up to the main thread in useful-sized
 *     blocks. No resampling, no gain, no clipping -- whatever the microphone
 *     gave us is exactly what gets written to disk.
 *
 *  2. Report the frame index of the very first sample it ever emitted. Combined
 *     with AudioContext.getOutputTimestamp() on the main thread, that single
 *     number is what lets two phones 2700 km apart be lined up to the sample.
 *
 *  3. Emit a cheap peak/RMS envelope at ~50 Hz for the live waveform, so the
 *     UI never has to touch the audio data itself.
 */

const BLOCK_FRAMES = 4096      // ~85 ms at 48 kHz: few messages, low latency
const ENVELOPE_HZ = 50         // live waveform resolution

class CaptureProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return []
  }

  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}

    this.channels = opts.channels || 1
    this.recording = false
    this.stopped = false

    // Interleaved staging buffer, flushed every BLOCK_FRAMES.
    this.block = new Float32Array(BLOCK_FRAMES * this.channels)
    this.blockFill = 0

    // Absolute frame counter of recorded audio, independent of currentFrame so
    // that arming latency never shows up as an offset.
    this.framesWritten = 0
    this.startFrame = -1

    this.envelopeInterval = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ))
    this.envAcc = 0
    this.envPeak = 0
    this.envSum = 0
    this.envCount = 0

    this.port.onmessage = (event) => {
      const msg = event.data
      if (msg.type === 'start') {
        this.recording = true
      } else if (msg.type === 'stop') {
        this.recording = false
        this.stopped = true
        this.flush(true)
        this.port.postMessage({ type: 'stopped', framesWritten: this.framesWritten })
      }
    }
  }

  flush(final) {
    if (this.blockFill === 0) {
      if (final) this.port.postMessage({ type: 'end' })
      return
    }
    const frames = this.blockFill / this.channels
    const out = this.block.slice(0, this.blockFill)
    this.port.postMessage(
      {
        type: 'audio',
        buffer: out.buffer,
        frames,
        channels: this.channels,
        // Frame index of this block's first sample within the recording.
        startSample: this.framesWritten - frames,
        final: Boolean(final),
      },
      [out.buffer],
    )
    this.blockFill = 0
    if (final) this.port.postMessage({ type: 'end' })
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return !this.stopped

    const frames = input[0].length
    const chans = Math.min(this.channels, input.length)

    // Envelope is computed whether or not we are recording, so the meters are
    // live while you are still setting your levels.
    for (let i = 0; i < frames; i += 1) {
      let mono = 0
      for (let c = 0; c < chans; c += 1) mono += input[c][i]
      mono /= chans

      const mag = mono < 0 ? -mono : mono
      if (mag > this.envPeak) this.envPeak = mag
      this.envSum += mono * mono
      this.envCount += 1
      this.envAcc += 1

      if (this.envAcc >= this.envelopeInterval) {
        this.port.postMessage({
          type: 'envelope',
          peak: this.envPeak,
          rms: Math.sqrt(this.envSum / Math.max(1, this.envCount)),
          atFrame: this.recording ? this.framesWritten + i : -1,
        })
        this.envAcc = 0
        this.envPeak = 0
        this.envSum = 0
        this.envCount = 0
      }
    }

    if (!this.recording) return true

    if (this.startFrame < 0) {
      this.startFrame = currentFrame
      // The anchor the whole sync scheme hangs off. currentTime is the render
      // clock; the main thread pairs it with a wall clock immediately.
      this.port.postMessage({
        type: 'first-sample',
        startFrame: currentFrame,
        contextTime: currentTime,
        sampleRate,
      })
    }

    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < this.channels; c += 1) {
        const src = c < chans ? input[c] : input[chans - 1]
        this.block[this.blockFill] = src[i]
        this.blockFill += 1
      }
      this.framesWritten += 1
      if (this.blockFill >= this.block.length) this.flush(false)
    }

    return true
  }
}

registerProcessor('podstart-capture', CaptureProcessor)
