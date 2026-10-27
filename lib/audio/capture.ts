'use client'

import type { CaptureReport } from '@/lib/supabase/types'

/**
 * Microphone acquisition, tuned for archival quality rather than phone calls.
 *
 * The important decision here is that we ask the browser to switch OFF its
 * echo canceller, noise suppressor and auto gain. Those three are WebRTC's
 * voice-call processor: they hard-limit the signal to a narrow band, collapse
 * it toward mono telephony and pump the level. They make a bad mic sound
 * acceptable and a good mic sound bad, and their damage is baked in and
 * unrecoverable.
 *
 * So we capture the raw signal and clean it up afterwards, offline, with a
 * proper denoiser and dereverb (see lib/dsp). That path keeps every bit of an
 * iPhone's microphone while still rescuing a noisy room.
 */

/** Sample rates to try, best first. 48k is the professional norm. */
const PREFERRED_RATES = [48000, 96000, 44100] as const

export interface CaptureOptions {
  deviceId?: string
  /**
   * Leave the browser's voice processing on. Only sensible when someone is
   * recording on laptop speakers with no headphones, where feedback would
   * otherwise ruin the take.
   */
  useBrowserProcessing?: boolean
  channels?: 1 | 2
}

export interface Capture {
  stream: MediaStream
  track: MediaStreamTrack
  report: CaptureReport
  /** Nominal rate of the track; the AudioContext is built to match. */
  sampleRate: number
  channels: number
  stop(): void
}

function rawConstraints(
  deviceId: string | undefined,
  sampleRate: number,
  channels: number,
): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    // Defeating the voice pipeline. `exact` matters: without it browsers
    // silently keep processing on and report it as satisfied.
    echoCancellation: { exact: false },
    noiseSuppression: { exact: false },
    autoGainControl: { exact: false },
    // Safari 17+ ships an on-device voice isolator that is on by default.
    ...({ voiceIsolation: { exact: false } } as Record<string, unknown>),
    channelCount: { ideal: channels },
    sampleRate: { ideal: sampleRate },
    sampleSize: { ideal: 24 },
  }
}

function processedConstraints(
  deviceId: string | undefined,
  channels: number,
): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: channels },
  }
}

export async function openMicrophone(options: CaptureOptions = {}): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot record audio. Use Safari, Chrome or Edge.')
  }

  const channels = options.channels ?? 1
  let stream: MediaStream | null = null
  let path: 'raw' | 'processed' = 'raw'

  if (options.useBrowserProcessing) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: processedConstraints(options.deviceId, channels),
      video: false,
    })
    path = 'processed'
  } else {
    // Walk the preferred rates. A browser that cannot honour `exact: false` on
    // the processing flags throws OverconstrainedError, which is the signal to
    // fall back rather than silently record a processed track.
    let lastError: unknown = null
    for (const rate of PREFERRED_RATES) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: rawConstraints(options.deviceId, rate, channels),
          video: false,
        })
        break
      } catch (error) {
        lastError = error
      }
    }

    if (!stream) {
      // Last resort: take whatever the device will give us, and be honest in
      // the report that this is not the raw path.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: options.deviceId ? { exact: options.deviceId } : undefined },
          video: false,
        })
        path = 'processed'
      } catch {
        throw asFriendlyError(lastError)
      }
    }
  }

  const track = stream.getAudioTracks()[0]
  if (!track) throw new Error('The microphone opened but produced no audio track.')

  const settings = track.getSettings() as MediaTrackSettings & {
    voiceIsolation?: boolean
    sampleSize?: number
  }

  // Trust the settings the browser reports over the ones we asked for.
  const echoCancellation = settings.echoCancellation ?? false
  const noiseSuppression = settings.noiseSuppression ?? false
  const autoGainControl = settings.autoGainControl ?? false
  if (echoCancellation || noiseSuppression || autoGainControl || settings.voiceIsolation) {
    path = 'processed'
  }

  const report: CaptureReport = {
    sampleRate: settings.sampleRate ?? 48000,
    channels: settings.channelCount ?? channels,
    bitDepth: settings.sampleSize ?? 32,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    deviceLabel: track.label || 'Microphone',
    path,
    userAgent: navigator.userAgent,
  }

  return {
    stream,
    track,
    report,
    sampleRate: report.sampleRate,
    channels: report.channels,
    stop() {
      for (const t of stream!.getTracks()) t.stop()
    },
  }
}

function asFriendlyError(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error(
        'Microphone access was blocked. Allow it in your browser settings, then reload.',
      )
    case 'NotFoundError':
      return new Error('No microphone found. Plug one in or check your system input.')
    case 'NotReadableError':
      return new Error(
        'The microphone is busy. Close other apps or tabs using it, then try again.',
      )
    default:
      return new Error(
        `Could not open the microphone${name ? ` (${name})` : ''}. Try reloading the page.`,
      )
  }
}

export interface InputDevice {
  deviceId: string
  label: string
  isDefault: boolean
}

/**
 * Lists inputs. Labels are hidden until permission has been granted once, so
 * call this after a successful openMicrophone to get real names.
 */
export async function listInputs(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Input ${i + 1}`,
      isDefault: d.deviceId === 'default' || i === 0,
    }))
}

/** True on iOS/iPadOS, including iPad pretending to be a Mac. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
  )
}

/**
 * iOS routes the whole audio session into voice-chat mode whenever a WebRTC
 * audio track is playing, which forces the microphone down the echo-cancelled
 * path no matter what constraints we asked for. There is no way around it from
 * a web page, so the studio offers to mute talkback while recording and the
 * caller needs to know whether to show that choice.
 */
export function talkbackHurtsQuality(): boolean {
  return isIOS()
}
