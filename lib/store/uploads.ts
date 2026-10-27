'use client'

import { segmentName } from '@/lib/util/id'
import { supabase } from '@/lib/supabase/client'

/**
 * Segment upload queue.
 *
 * Segments arrive from the recorder worker every ~30 s while you are still
 * talking. They go into a queue that uploads one at a time with backoff, so a
 * phone that loses signal in a lift catches up on its own rather than failing
 * the take. Nothing here can block recording: the queue holds references to
 * already-encoded bytes and the recorder never waits on it.
 */

export interface QueuedSegment {
  trackId: string
  sessionId: string
  idx: number
  codec: 'flac' | 'wav'
  bytes: ArrayBuffer
  startSample: number
  frames: number
}

export interface UploadProgress {
  uploaded: number
  pending: number
  failed: number
  bytesUploaded: number
}

const MAX_ATTEMPTS = 6

export class SegmentUploader {
  private queue: QueuedSegment[] = []
  private running = false
  private uploaded = 0
  private failed = 0
  private bytesUploaded = 0

  constructor(
    private readonly onProgress: (progress: UploadProgress) => void,
    private readonly onError: (message: string) => void,
  ) {}

  enqueue(segment: QueuedSegment): void {
    this.queue.push(segment)
    this.report()
    void this.drain()
  }

  get progress(): UploadProgress {
    return {
      uploaded: this.uploaded,
      pending: this.queue.length,
      failed: this.failed,
      bytesUploaded: this.bytesUploaded,
    }
  }

  /** Resolves once the queue is empty, so "stop" can wait for the last bytes. */
  async flush(timeoutMs = 120000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while ((this.queue.length > 0 || this.running) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return this.queue.length === 0 && this.failed === 0
  }

  private report(): void {
    this.onProgress(this.progress)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      while (this.queue.length > 0) {
        const segment = this.queue[0] as QueuedSegment
        const ok = await this.upload(segment)
        if (ok) {
          this.queue.shift()
          this.uploaded += 1
          this.bytesUploaded += segment.bytes.byteLength
        } else {
          this.queue.shift()
          this.failed += 1
        }
        this.report()
      }
    } finally {
      this.running = false
    }
  }

  private async upload(segment: QueuedSegment): Promise<boolean> {
    const sb = supabase()
    const path = `${segment.sessionId}/${segment.trackId}/${segmentName(segment.idx, segment.codec)}`
    const contentType = segment.codec === 'flac' ? 'audio/flac' : 'audio/wav'

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const { error } = await sb.storage
        .from('stems')
        .upload(path, new Blob([segment.bytes], { type: contentType }), {
          contentType,
          upsert: true,
        })

      if (!error) {
        const { error: rowError } = await sb.from('track_segments').upsert(
          {
            track_id: segment.trackId,
            idx: segment.idx,
            path,
            bytes: segment.bytes.byteLength,
            start_sample: segment.startSample,
            frames: segment.frames,
          },
          { onConflict: 'track_id,idx' },
        )
        if (rowError) {
          this.onError(`Segment ${segment.idx} uploaded but was not recorded: ${rowError.message}`)
          return false
        }
        return true
      }

      if (attempt === MAX_ATTEMPTS) {
        this.onError(
          `Segment ${segment.idx} failed after ${MAX_ATTEMPTS} attempts: ${error.message}. ` +
            'The lossless copy on this device is still intact.',
        )
        return false
      }

      // Exponential backoff with a cap, so a long outage is retried patiently
      // rather than hammered.
      await new Promise((resolve) => setTimeout(resolve, Math.min(16000, 500 * 2 ** attempt)))
    }

    return false
  }
}

/**
 * Pulls a track's segments back down and reassembles them into one signal.
 *
 * FLAC segments are decoded by the browser's own decoder through
 * decodeAudioData; WAV segments are parsed directly.
 */
export async function downloadTrack(
  sessionId: string,
  trackId: string,
  onProgress?: (fraction: number) => void,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const sb = supabase()

  const { data: segments, error } = await sb
    .from('track_segments')
    .select('*')
    .eq('track_id', trackId)
    .order('idx', { ascending: true })

  if (error) throw new Error(`Could not list segments: ${error.message}`)
  if (!segments || segments.length === 0) return null

  const ctx = new OfflineAudioContext(1, 1, 48000)
  const parts: Float32Array[] = []
  let sampleRate = 48000
  let total = 0

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as { path: string }
    const { data, error: downloadError } = await sb.storage.from('stems').download(segment.path)
    if (downloadError || !data) {
      throw new Error(`Could not download ${segment.path}: ${downloadError?.message ?? 'missing'}`)
    }

    const buffer = await data.arrayBuffer()
    const decoded = await ctx.decodeAudioData(buffer.slice(0))
    sampleRate = decoded.sampleRate
    const channel = decoded.getChannelData(0)
    const copy = new Float32Array(channel.length)
    copy.set(channel)
    parts.push(copy)
    total += copy.length

    onProgress?.((i + 1) / segments.length)
  }

  const samples = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    samples.set(part, offset)
    offset += part.length
  }

  return { samples, sampleRate }
}
