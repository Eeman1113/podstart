/**
 * WAV writing and reading.
 *
 * 24-bit PCM is the archival format here: it is lossless, every editor on
 * earth opens it, and it costs a third less than the 32-bit float the browser
 * hands us while staying far below the noise floor of any microphone a phone
 * has. 32-bit float is available for anyone who wants the bits untouched.
 */

export type BitDepth = 16 | 24 | 32

export function wavHeader(
  frames: number,
  sampleRate: number,
  channels: number,
  bitDepth: BitDepth,
): ArrayBuffer {
  const isFloat = bitDepth === 32
  const bytesPerSample = bitDepth / 8
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign
  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, isFloat ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return header
}

/** Converts interleaved float samples to raw PCM bytes at the given depth. */
export function encodePcm(samples: Float32Array, bitDepth: BitDepth): Uint8Array<ArrayBuffer> {
  if (bitDepth === 32) {
    // Copy rather than view: the result must own a plain ArrayBuffer to be a
    // valid BlobPart, and the source may be a view into a larger buffer.
    const raw = new Uint8Array(samples.byteLength)
    raw.set(new Uint8Array(samples.buffer as ArrayBuffer, samples.byteOffset, samples.byteLength))
    return raw
  }

  if (bitDepth === 16) {
    const out = new Uint8Array(samples.length * 2)
    const view = new DataView(out.buffer)
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i] as number))
      // Asymmetric scaling: +1.0 maps to 32767, -1.0 to -32768, no wrap.
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return out
  }

  const out = new Uint8Array(samples.length * 3)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] as number))
    const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
    const u = v < 0 ? v + 0x1000000 : v
    out[i * 3] = u & 0xff
    out[i * 3 + 1] = (u >> 8) & 0xff
    out[i * 3 + 2] = (u >> 16) & 0xff
  }
  return out
}

export function wavBlob(
  samples: Float32Array,
  sampleRate: number,
  channels: number,
  bitDepth: BitDepth = 24,
): Blob {
  const frames = samples.length / channels
  return new Blob([wavHeader(frames, sampleRate, channels, bitDepth), encodePcm(samples, bitDepth)], {
    type: 'audio/wav',
  })
}

export interface DecodedWav {
  samples: Float32Array
  sampleRate: number
  channels: number
}

/** Minimal RIFF reader: enough to read back what we wrote, plus 16-bit files. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer)
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    )

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')

  let offset = 12
  let format = 1
  let channels = 1
  let sampleRate = 48000
  let bitDepth: number = 16
  let dataStart = -1
  let dataBytes = 0

  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitDepth = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataStart = body
      dataBytes = Math.min(size, buffer.byteLength - body)
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }

  if (dataStart < 0) throw new Error('WAV file has no data chunk')

  const bytesPerSample = bitDepth / 8
  const count = Math.floor(dataBytes / bytesPerSample)
  const samples = new Float32Array(count)

  if (format === 3 && bitDepth === 32) {
    const src = new DataView(buffer, dataStart, count * 4)
    for (let i = 0; i < count; i += 1) samples[i] = src.getFloat32(i * 4, true)
  } else if (bitDepth === 16) {
    const src = new DataView(buffer, dataStart, count * 2)
    for (let i = 0; i < count; i += 1) samples[i] = src.getInt16(i * 2, true) / 0x8000
  } else if (bitDepth === 24) {
    const src = new Uint8Array(buffer, dataStart, count * 3)
    for (let i = 0; i < count; i += 1) {
      const u = (src[i * 3] as number) | ((src[i * 3 + 1] as number) << 8) | ((src[i * 3 + 2] as number) << 16)
      samples[i] = (u & 0x800000 ? u - 0x1000000 : u) / 0x800000
    }
  } else {
    throw new Error(`Unsupported WAV format (${bitDepth}-bit, format ${format})`)
  }

  return { samples, sampleRate, channels }
}
