/// <reference lib="webworker" />

import { runCleanup, type CleanupSettings } from '@/lib/dsp/pipeline'
import { measureLoudness } from '@/lib/dsp/loudness'

/**
 * Runs the cleanup chain off the main thread.
 *
 * An hour of audio is a few hundred million multiply-adds through the STFT
 * stages. On the main thread that would freeze the page for the whole
 * processing run; here the UI stays live and reports progress.
 */

export interface CleanupRequest {
  type: 'cleanup'
  jobId: string
  samples: ArrayBuffer
  sampleRate: number
  settings: CleanupSettings
  basePath: string
}

export interface MeasureRequest {
  type: 'measure'
  jobId: string
  samples: ArrayBuffer
  sampleRate: number
}

type Request = CleanupRequest | MeasureRequest

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data

  try {
    if (request.type === 'measure') {
      const samples = new Float32Array(request.samples)
      ctx.postMessage({
        type: 'measured',
        jobId: request.jobId,
        report: measureLoudness(samples, request.sampleRate),
      })
      return
    }

    if (request.type === 'cleanup') {
      const samples = new Float32Array(request.samples)
      const result = await runCleanup(
        samples,
        request.sampleRate,
        request.settings,
        request.basePath,
        (stage, fraction) => {
          ctx.postMessage({ type: 'progress', jobId: request.jobId, stage, fraction })
        },
      )
      ctx.postMessage(
        {
          type: 'cleaned',
          jobId: request.jobId,
          samples: result.output.buffer,
          report: result.report,
        },
        [result.output.buffer],
      )
    }
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      jobId: request.jobId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
