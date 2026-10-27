'use client'

import { anchorOf, driftPpm, epochAtContextTime, inputLatencyMs } from '@/lib/audio/clock'
import type { Capture } from '@/lib/audio/capture'

/**
 * The local recorder: AudioContext -> capture worklet -> recorder worker.
 *
 * The main thread never touches a sample. It schedules the start, records the
 * one timestamp that sync depends on, and forwards finished segments to
 * whoever wants to upload them.
 */

export interface SegmentPayload {
  idx: number
  codec: 'flac' | 'wav'
  bytes: ArrayBuffer
  startSample: number
  frames: number
  final: boolean
}

export interface RecorderEvents {
  /** ~50 Hz, drives the live waveform and meters. */
  onEnvelope?(peak: number, rms: number, atFrame: number): void
  onSegment?(segment: SegmentPayload): void
  onWarning?(message: string): void
  /** Fires once, the instant the first sample is committed. */
  onStarted?(startEpochMs: number): void
  onFinished?(summary: RecordingSummary): void
}

export interface RecordingSummary {
  frames: number
  durationSec: number
  sampleRate: number
  channels: number
  startEpochMs: number
  driftPpm: number | null
  codec: 'flac' | 'wav'
  hasLocalCopy: boolean
}

export interface RecorderOptions {
  trackId: string
  capture: Capture
  basePath: string
  segmentSeconds?: number
  bitsPerSample?: 16 | 24
  /**
   * Per-device correction for microphone hardware latency, in milliseconds.
   * Positive means this device hears late, so its audio is nudged earlier.
   */
  calibrationMs?: number
  events?: RecorderEvents
}

export class Recorder {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sink: GainNode | null = null
  private worker: Worker | null = null

  private startEpochMs = 0
  private framesWritten = 0
  private codec: 'flac' | 'wav' = 'flac'
  private hasLocalCopy = false
  private readonly events: RecorderEvents

  readonly trackId: string
  readonly sampleRate: number
  readonly channels: number

  constructor(private readonly options: RecorderOptions) {
    this.events = options.events ?? {}
    this.trackId = options.trackId
    this.sampleRate = options.capture.sampleRate
    this.channels = options.capture.channels
  }

  /**
   * Builds the graph and gets the worker's encoder warm, but does NOT record.
   * Doing this ahead of the countdown means `start()` costs nothing but a
   * postMessage, which is what keeps two devices together.
   */
  async prepare(): Promise<void> {
    const { capture, basePath } = this.options

    // Matching the context rate to the track rate avoids a resample, which
    // would otherwise quietly degrade everything we worked to preserve.
    const ctx = new AudioContext({
      sampleRate: capture.sampleRate,
      latencyHint: 'playback',
    })
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()

    await ctx.audioWorklet.addModule(`${basePath}/worklets/capture.js`)

    this.source = ctx.createMediaStreamSource(capture.stream)
    this.node = new AudioWorkletNode(ctx, 'podstart-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [this.channels],
      processorOptions: { channels: this.channels },
    })

    // Chrome and Safari stop pulling on a worklet that leads nowhere, so the
    // graph is terminated in a muted gain node rather than left dangling.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.node)
    this.node.connect(this.sink)
    this.sink.connect(ctx.destination)

    this.node.port.onmessage = (event) => this.onWorkletMessage(event.data)

    const worker = new Worker(`${basePath}/workers/recorder.js`)
    this.worker = worker
    worker.onmessage = (event) => this.onWorkerMessage(event.data)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('The recording engine did not start in time.')),
        15000,
      )
      const onReady = (event: MessageEvent) => {
        if (event.data?.type !== 'ready') return
        clearTimeout(timeout)
        worker.removeEventListener('message', onReady)
        this.codec = event.data.codec
        this.hasLocalCopy = event.data.hasLocalCopy
        resolve()
      }
      worker.addEventListener('message', onReady)
      worker.postMessage({
        type: 'init',
        basePath,
        trackId: this.trackId,
        sampleRate: this.sampleRate,
        channels: this.channels,
        bitsPerSample: this.options.bitsPerSample ?? 24,
        segmentSeconds: this.options.segmentSeconds ?? 30,
        codec: 'flac',
      })
    })
  }

  /** Levels are live from here on, before anything is being written. */
  get isPrepared(): boolean {
    return this.node !== null && this.worker !== null
  }

  get audioContext(): AudioContext | null {
    return this.ctx
  }

  /**
   * Opens the recorder at a precise shared-clock instant.
   *
   * `atEpochMs` is the downbeat both participants agreed on, already converted
   * into this device's local clock by the room's offset measurement. We busy-
   * schedule rather than setTimeout for the final few milliseconds because
   * timer resolution on a backgrounded phone is terrible.
   */
  start(atEpochMs?: number): void {
    if (!this.node) throw new Error('Recorder.prepare() must run first')
    const fire = () => this.node?.port.postMessage({ type: 'start' })

    if (!atEpochMs) return fire()

    const now = performance.timeOrigin + performance.now()
    const waitMs = atEpochMs - now
    if (waitMs <= 0) return fire()

    if (waitMs > 40) {
      setTimeout(() => this.start(atEpochMs), waitMs - 30)
      return
    }
    const spin = () => {
      if (performance.timeOrigin + performance.now() >= atEpochMs) fire()
      else requestAnimationFrame(spin)
    }
    spin()
  }

  stop(): void {
    this.node?.port.postMessage({ type: 'stop' })
  }

  /** Releases the microphone and the audio graph. Safe to call twice. */
  async dispose(): Promise<void> {
    try {
      this.source?.disconnect()
      this.node?.disconnect()
      this.sink?.disconnect()
      await this.ctx?.close()
    } catch {
      /* already torn down */
    }
    this.ctx = null
    this.node = null
    this.source = null
    this.sink = null
  }

  /** Deletes this take's lossless local copy once it is safely uploaded. */
  discardLocalCopy(): void {
    this.worker?.postMessage({ type: 'discard-local', trackId: this.trackId })
  }

  /** Reads back the lossless local copy, for "save the raw file" in the UI. */
  async readLocalCopy(): Promise<Float32Array | null> {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('podstart-takes')
      const handle = await dir.getFileHandle(`${this.trackId}.f32`)
      const file = await handle.getFile()
      return new Float32Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }

  // ----------------------------------------------------------------- private

  private onWorkletMessage(msg: {
    type: string
    buffer?: ArrayBuffer
    frames?: number
    startSample?: number
    peak?: number
    rms?: number
    atFrame?: number
    contextTime?: number
    final?: boolean
  }): void {
    switch (msg.type) {
      case 'first-sample': {
        const ctx = this.ctx
        if (!ctx) return
        const anchor = anchorOf(ctx)
        const latency =
          inputLatencyMs(this.options.capture.track, ctx) + (this.options.calibrationMs ?? 0)
        // The first sample entered the microphone `latency` ms before the
        // graph saw it, so the recording genuinely begins that much earlier.
        this.startEpochMs = epochAtContextTime(anchor, msg.contextTime ?? ctx.currentTime) - latency
        this.events.onStarted?.(this.startEpochMs)
        return
      }
      case 'audio': {
        if (!msg.buffer) return
        this.worker?.postMessage({ type: 'block', buffer: msg.buffer }, [msg.buffer])
        return
      }
      case 'envelope': {
        this.events.onEnvelope?.(msg.peak ?? 0, msg.rms ?? 0, msg.atFrame ?? -1)
        return
      }
      case 'stopped': {
        this.worker?.postMessage({ type: 'stop' })
        return
      }
      default:
    }
  }

  private onWorkerMessage(msg: {
    type: string
    idx?: number
    codec?: 'flac' | 'wav'
    bytes?: ArrayBuffer
    startSample?: number
    frames?: number
    final?: boolean
    framesWritten?: number
    message?: string
  }): void {
    switch (msg.type) {
      case 'segment': {
        if (!msg.bytes) return
        this.events.onSegment?.({
          idx: msg.idx ?? 0,
          codec: msg.codec ?? 'wav',
          bytes: msg.bytes,
          startSample: msg.startSample ?? 0,
          frames: msg.frames ?? 0,
          final: Boolean(msg.final),
        })
        return
      }
      case 'warning': {
        this.events.onWarning?.(msg.message ?? 'Recorder warning')
        return
      }
      case 'finished': {
        this.framesWritten = msg.framesWritten ?? 0
        const ctx = this.ctx
        const endEpoch = ctx
          ? epochAtContextTime(anchorOf(ctx), ctx.currentTime)
          : performance.timeOrigin + performance.now()
        this.events.onFinished?.({
          frames: this.framesWritten,
          durationSec: this.framesWritten / this.sampleRate,
          sampleRate: this.sampleRate,
          channels: this.channels,
          startEpochMs: this.startEpochMs,
          driftPpm: driftPpm(this.framesWritten, this.sampleRate, endEpoch - this.startEpochMs),
          codec: this.codec,
          hasLocalCopy: this.hasLocalCopy,
        })
        return
      }
      default:
    }
  }
}
