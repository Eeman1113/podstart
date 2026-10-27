/**
 * RNNoise: a small recurrent network trained to separate speech from noise.
 *
 * It is the best general-purpose voice denoiser that fits in 110 kB of
 * WebAssembly, and it is what the "Clean up" default uses. It works strictly
 * at 48 kHz in 480-sample frames, on samples scaled to 16-bit range, and it
 * returns a speech-probability per frame which the UI reports as confidence.
 *
 * It is loaded from /vendor at runtime rather than bundled -- see
 * scripts/vendor.mjs for why.
 */

export const RNNOISE_FRAME = 480
export const RNNOISE_RATE = 48000

interface RnnoiseModule {
  _rnnoise_create(model: number): number
  _rnnoise_destroy(state: number): void
  _rnnoise_process_frame(state: number, out: number, input: number): number
  _malloc(bytes: number): number
  _free(ptr: number): void
  HEAPF32: Float32Array
}

type ModuleFactory = (options?: Record<string, unknown>) => Promise<RnnoiseModule>

let factory: ModuleFactory | null = null

export async function loadRnnoise(basePath: string): Promise<ModuleFactory> {
  if (factory) return factory
  const url = `${basePath}/vendor/rnnoise/rnnoise.js`
  const module = (await import(/* webpackIgnore: true */ url)) as { default: ModuleFactory }
  factory = module.default
  return factory
}

export interface RnnoiseRun {
  output: Float32Array
  /** Mean probability that the frames contained speech, 0..1. */
  speechConfidence: number
}

/**
 * Runs the denoiser over a whole signal.
 *
 * `strength` blends the result back against the original. Full strength can be
 * too eager with breaths and room tone that actually belong in a podcast, so
 * the UI defaults to 0.85 rather than 1.
 */
export async function rnnoiseDenoise(
  input: Float32Array,
  sampleRate: number,
  basePath: string,
  strength = 1,
  onProgress?: (fraction: number) => void,
): Promise<RnnoiseRun> {
  if (sampleRate !== RNNOISE_RATE) {
    throw new Error(`RNNoise needs 48 kHz audio, got ${sampleRate}`)
  }

  const create = await loadRnnoise(basePath)
  const module = await create({
    locateFile: (file: string) => `${basePath}/vendor/rnnoise/${file}`,
  })

  const state = module._rnnoise_create(0)
  const inPtr = module._malloc(RNNOISE_FRAME * 4)
  const outPtr = module._malloc(RNNOISE_FRAME * 4)

  const output = new Float32Array(input.length)
  const frame = new Float32Array(RNNOISE_FRAME)
  let vadSum = 0
  let frames = 0

  try {
    for (let offset = 0; offset < input.length; offset += RNNOISE_FRAME) {
      const available = Math.min(RNNOISE_FRAME, input.length - offset)

      // RNNoise expects 16-bit scaling, not -1..1 floats.
      for (let i = 0; i < RNNOISE_FRAME; i += 1) {
        frame[i] = i < available ? (input[offset + i] as number) * 32768 : 0
      }

      module.HEAPF32.set(frame, inPtr >> 2)
      const vad = module._rnnoise_process_frame(state, outPtr, inPtr)
      vadSum += vad
      frames += 1

      const processed = module.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + RNNOISE_FRAME)
      for (let i = 0; i < available; i += 1) {
        const wet = (processed[i] as number) / 32768
        const dry = input[offset + i] as number
        output[offset + i] = dry + (wet - dry) * strength
      }

      if (onProgress && frames % 200 === 0) onProgress(offset / input.length)
    }
  } finally {
    module._free(inPtr)
    module._free(outPtr)
    module._rnnoise_destroy(state)
  }

  return { output, speechConfidence: frames > 0 ? vadSum / frames : 0 }
}
