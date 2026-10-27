/**
 * podstart recorder worker (classic worker, hand-written, served statically)
 *
 * Everything that must not stutter the UI happens here:
 *
 *   - the lossless safety copy is appended to an OPFS file through a
 *     synchronous access handle, which is the only write path fast enough to
 *     keep up with 48 kHz without ever touching the main thread;
 *   - audio is cut into ~30 s segments and FLAC-encoded for upload.
 *
 * Why segments: Supabase's free tier rejects any single object over 50 MB and
 * caps the project at 1 GB, while an hour of lossless mono is several hundred.
 * Segments also mean a dropped connection or a phone locking mid-episode costs
 * you thirty seconds of upload, not the take.
 *
 * FLAC is loaded from /vendor at runtime. If it fails for any reason we fall
 * back to 24-bit WAV segments rather than failing the recording: a larger file
 * is always better than a lost one.
 */

let flacReady = false
let flacFailed = false
let base = '' // app base path, e.g. "/podstart"

function loadFlac(basePath) {
  if (flacReady || flacFailed) return
  try {
    self.FLAC_SCRIPT_LOCATION = `${basePath}/vendor/flac/`
    importScripts(`${basePath}/vendor/flac/libflac.js`)
    flacReady = typeof self.Flac !== 'undefined'
    if (!flacReady) flacFailed = true
  } catch (error) {
    flacFailed = true
    post({ type: 'warning', message: `FLAC unavailable (${error.message}); using WAV segments.` })
  }
}

function whenFlacReady() {
  return new Promise((resolve) => {
    if (!flacReady) return resolve(false)
    if (self.Flac.isReady()) return resolve(true)
    self.Flac.onready = () => resolve(true)
    // Never hang a recording on a wasm load.
    setTimeout(() => resolve(self.Flac.isReady()), 5000)
  })
}

// ------------------------------------------------------------------ encoding

function floatToInt32(samples, bitsPerSample) {
  const scale = bitsPerSample === 24 ? 0x7fffff : 0x7fff
  const out = new Int32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = Math.round(s < 0 ? s * (scale + 1) : s * scale)
  }
  return out
}

function encodeFlac(samples, sampleRate, channels, bitsPerSample) {
  const Flac = self.Flac
  const chunks = []
  let total = 0

  // compression level 5 is FLAC's default: around 55 % of PCM, and fast enough
  // to stay far ahead of real time on a phone.
  const encoder = Flac.init_libflac_encoder(sampleRate, channels, bitsPerSample, 5, 0, false, 0)
  if (!encoder) throw new Error('could not create FLAC encoder')

  const status = Flac.init_encoder_stream(encoder, (data, bytes) => {
    const copy = new Uint8Array(data.length)
    copy.set(data)
    chunks.push(copy)
    total += copy.length
  })
  if (status !== 0) {
    Flac.FLAC__stream_encoder_delete(encoder)
    throw new Error(`FLAC encoder init failed (${status})`)
  }

  const pcm = floatToInt32(samples, bitsPerSample)
  const ok = Flac.FLAC__stream_encoder_process_interleaved(
    encoder,
    pcm,
    pcm.length / channels,
  )
  Flac.FLAC__stream_encoder_finish(encoder)
  Flac.FLAC__stream_encoder_delete(encoder)
  if (!ok) throw new Error('FLAC encoding failed')

  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function wavBytes(samples, sampleRate, channels, bitsPerSample) {
  // 32 means IEEE float, written through untouched: no scaling, no rounding,
  // no clamping. This is the format a raw take uploads in, so that what lands
  // in storage is bit-identical to what the microphone produced.
  const isFloat = bitsPerSample === 32
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = channels * bytesPerSample
  const frames = samples.length / channels
  const dataBytes = frames * blockAlign
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (o, t) => {
    for (let i = 0; i < t.length; i += 1) view.setUint8(o + i, t.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, isFloat ? 3 : 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  if (isFloat) {
    out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44)
    return out
  }

  let p = 44
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
    const u = v < 0 ? v + 0x1000000 : v
    out[p] = u & 0xff
    out[p + 1] = (u >> 8) & 0xff
    out[p + 2] = (u >> 16) & 0xff
    p += 3
  }
  return out
}

// ------------------------------------------------------------------- session

const state = {
  trackId: null,
  sampleRate: 48000,
  channels: 1,
  bitsPerSample: 24,
  segmentFrames: 0,
  segment: null,
  segmentFill: 0,
  segmentIndex: 0,
  segmentStartSample: 0,
  framesWritten: 0,
  rawHandle: null,
  rawOffset: 0,
  codec: 'flac',
  closing: false,
}

function post(message, transfer) {
  self.postMessage(message, transfer || [])
}

async function openRawFile(trackId) {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('podstart-takes', { create: true })
    const file = await dir.getFileHandle(`${trackId}.f32`, { create: true })
    if (!file.createSyncAccessHandle) return null
    const handle = await file.createSyncAccessHandle()
    handle.truncate(0)
    return handle
  } catch (error) {
    post({
      type: 'warning',
      message: `Local safety copy unavailable (${error.message}). Recording continues; upload is the only copy.`,
    })
    return null
  }
}

async function flushSegment(isFinal) {
  if (state.segmentFill === 0) {
    if (isFinal) post({ type: 'finished', framesWritten: state.framesWritten })
    return
  }

  const samples = state.segment.subarray(0, state.segmentFill)
  const frames = state.segmentFill / state.channels
  const idx = state.segmentIndex
  const startSample = state.segmentStartSample

  let bytes
  let codec = state.codec
  try {
    if (state.codec === 'flac' && flacReady && self.Flac.isReady()) {
      bytes = encodeFlac(samples, state.sampleRate, state.channels, state.bitsPerSample)
    } else {
      codec = 'wav'
      bytes = wavBytes(samples, state.sampleRate, state.channels, state.bitsPerSample)
    }
  } catch (error) {
    codec = 'wav'
    bytes = wavBytes(samples, state.sampleRate, state.channels, state.bitsPerSample)
    post({ type: 'warning', message: `Segment ${idx} fell back to WAV: ${error.message}` })
  }

  state.segmentIndex += 1
  state.segmentFill = 0
  state.segmentStartSample = state.framesWritten

  post(
    {
      type: 'segment',
      idx,
      codec,
      bytes: bytes.buffer,
      byteLength: bytes.byteLength,
      startSample,
      frames,
      final: Boolean(isFinal),
    },
    [bytes.buffer],
  )

  if (isFinal) post({ type: 'finished', framesWritten: state.framesWritten })
}

self.onmessage = async (event) => {
  const msg = event.data

  if (msg.type === 'init') {
    base = msg.basePath || ''
    state.trackId = msg.trackId
    state.sampleRate = msg.sampleRate
    state.channels = msg.channels
    state.bitsPerSample = msg.bitsPerSample || 24
    state.codec = msg.codec || 'flac'
    // FLAC cannot carry 32-bit float. A bit-exact take therefore uploads WAV,
    // which is larger but is the only lossless container for these samples.
    if (state.bitsPerSample === 32) state.codec = 'wav'
    state.segmentFrames = Math.round((msg.segmentSeconds || 30) * msg.sampleRate)
    state.segment = new Float32Array(state.segmentFrames * msg.channels)
    state.segmentFill = 0
    state.segmentIndex = 0
    state.segmentStartSample = 0
    state.framesWritten = 0
    state.rawOffset = 0

    if (state.codec === 'flac') {
      loadFlac(base)
      await whenFlacReady()
      if (!flacReady) state.codec = 'wav'
    }

    state.rawHandle = await openRawFile(msg.trackId)
    post({ type: 'ready', codec: state.codec, hasLocalCopy: Boolean(state.rawHandle) })
    return
  }

  if (msg.type === 'block') {
    const incoming = new Float32Array(msg.buffer)

    // 1. Lossless safety copy, straight to disk, no conversion at all.
    if (state.rawHandle) {
      try {
        state.rawHandle.write(incoming, { at: state.rawOffset })
        state.rawOffset += incoming.byteLength
      } catch (error) {
        post({ type: 'warning', message: `Local write failed: ${error.message}` })
        try { state.rawHandle.close() } catch { /* already gone */ }
        state.rawHandle = null
      }
    }

    // 2. Stage into the upload segment, flushing whenever it fills.
    let read = 0
    while (read < incoming.length) {
      const room = state.segment.length - state.segmentFill
      const take = Math.min(room, incoming.length - read)
      state.segment.set(incoming.subarray(read, read + take), state.segmentFill)
      state.segmentFill += take
      read += take
      state.framesWritten += take / state.channels
      if (state.segmentFill >= state.segment.length) await flushSegment(false)
    }
    return
  }

  if (msg.type === 'stop') {
    state.closing = true
    await flushSegment(true)
    if (state.rawHandle) {
      try {
        state.rawHandle.flush()
        state.rawHandle.close()
      } catch { /* nothing useful to do */ }
      state.rawHandle = null
    }
    return
  }

  if (msg.type === 'discard-local') {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('podstart-takes', { create: true })
      await dir.removeEntry(`${msg.trackId}.f32`)
      post({ type: 'discarded', trackId: msg.trackId })
    } catch (error) {
      post({ type: 'warning', message: `Could not remove local copy: ${error.message}` })
    }
  }
}
