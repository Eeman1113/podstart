'use client'

/**
 * Turning audio-clock positions into wall-clock instants.
 *
 * An AudioContext runs on the sound card's clock, which is not the system
 * clock and drifts away from it by tens of parts per million. To place two
 * independently recorded files on one timeline we need to know, in shared
 * wall-clock terms, exactly when each recording's first sample happened.
 *
 * getOutputTimestamp() is the bridge: it hands back a contextTime and the
 * performanceTime that coincided with it. Everything else is arithmetic.
 */

export interface ClockAnchor {
  contextTime: number
  epochMs: number
}

export function anchorOf(ctx: AudioContext): ClockAnchor {
  const ts = ctx.getOutputTimestamp?.()
  if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined) {
    return {
      contextTime: ts.contextTime,
      epochMs: performance.timeOrigin + ts.performanceTime,
    }
  }
  // Safari used to omit getOutputTimestamp; sampling both clocks back to back
  // is good to a millisecond or so, which the drift measurement later absorbs.
  return { contextTime: ctx.currentTime, epochMs: performance.timeOrigin + performance.now() }
}

/** Wall-clock epoch (ms) corresponding to a position on the audio clock. */
export function epochAtContextTime(anchor: ClockAnchor, contextTime: number): number {
  return anchor.epochMs + (contextTime - anchor.contextTime) * 1000
}

/**
 * Hardware latency between the microphone diaphragm and the sample arriving in
 * the graph. Chrome reports it per track; elsewhere we assume a typical value
 * and let the per-device calibration in Settings take over.
 *
 * This is the one number a web page genuinely cannot measure, and it is why
 * podstart offers a calibration slider instead of pretending to be exact.
 */
export function inputLatencyMs(track: MediaStreamTrack, ctx: AudioContext): number {
  const settings = track.getSettings() as MediaTrackSettings & { latency?: number }
  if (typeof settings.latency === 'number' && settings.latency > 0) {
    return settings.latency * 1000
  }
  // baseLatency covers the graph's own buffering and is usually symmetrical
  // with the input side on the same device.
  return (ctx.baseLatency || 0.01) * 1000
}

/**
 * How far the capture clock ran from real time over the take, in parts per
 * million. At 48 kHz, 50 ppm is 180 ms of slip across an hour -- audible as
 * two voices sliding apart, and the single biggest reason long remote
 * recordings end up out of sync. The mixer uses this to stretch each stem
 * back onto real time.
 */
export function driftPpm(frames: number, sampleRate: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || frames <= 0) return null
  const audioSeconds = frames / sampleRate
  const wallSeconds = elapsedMs / 1000
  if (wallSeconds < 10) return null // too short to measure meaningfully
  return (audioSeconds / wallSeconds - 1) * 1e6
}
