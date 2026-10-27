'use client'

import { supabase } from '@/lib/supabase/client'
import type {
  CaptureReport, Jingle, Mix, Room, Session, SessionJingle, Track,
} from '@/lib/supabase/types'

/** Every database call the app makes, in one place. */

export async function createRoom(name: string): Promise<Room> {
  const { data, error } = await supabase().rpc('create_room', { room_name: name })
  if (error) throw new Error(error.message)
  return data as Room
}

export async function joinRoom(code: string): Promise<Room> {
  const { data, error } = await supabase().rpc('join_room', { room_code: code.toUpperCase() })
  if (error) {
    throw new Error(
      error.message.includes('no room with that code')
        ? `No room with the code ${code.toUpperCase()}. Check it with whoever started the session.`
        : error.message,
    )
  }
  return data as Room
}

export async function roomByCode(code: string): Promise<Room | null> {
  const { data } = await supabase().from('rooms').select('*').eq('code', code.toUpperCase()).maybeSingle()
  return (data as Room) ?? null
}

export async function myRooms(): Promise<Room[]> {
  const { data, error } = await supabase()
    .from('rooms')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as Room[]
}

export async function setDisplayName(name: string): Promise<void> {
  const sb = supabase()
  const { data } = await sb.auth.getUser()
  if (!data.user) return
  await sb.from('profiles').update({ display_name: name }).eq('id', data.user.id)
}

// -------------------------------------------------------------------- takes

export async function createSession(roomId: string, title: string): Promise<Session> {
  const sb = supabase()
  const { data: auth } = await sb.auth.getUser()
  if (!auth.user) throw new Error('Not signed in')

  const { data, error } = await sb
    .from('sessions')
    .insert({ room_id: roomId, title, created_by: auth.user.id, state: 'idle' })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as Session
}

export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  const { error } = await supabase().from('sessions').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function sessionsForRoom(roomId: string): Promise<Session[]> {
  const { data, error } = await supabase()
    .from('sessions')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as Session[]
}

export async function getSession(id: string): Promise<Session | null> {
  const { data } = await supabase().from('sessions').select('*').eq('id', id).maybeSingle()
  return (data as Session) ?? null
}

export async function deleteSession(id: string): Promise<void> {
  const { error } = await supabase().from('sessions').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ------------------------------------------------------------------- tracks

export interface TrackSeed {
  sessionId: string
  displayName: string
  sampleRate: number
  channels: number
  codec: 'flac' | 'wav'
  startEpochMs: number
  clockOffsetMs: number
  clockRttMs: number | null
  capture: CaptureReport
}

export async function createTrack(seed: TrackSeed): Promise<Track> {
  const sb = supabase()
  const { data: auth } = await sb.auth.getUser()
  if (!auth.user) throw new Error('Not signed in')

  const { data, error } = await sb
    .from('tracks')
    .upsert(
      {
        session_id: seed.sessionId,
        user_id: auth.user.id,
        display_name: seed.displayName,
        sample_rate: seed.sampleRate,
        channels: seed.channels,
        codec: seed.codec,
        start_epoch_ms: seed.startEpochMs,
        clock_offset_ms: seed.clockOffsetMs,
        clock_rtt_ms: seed.clockRttMs,
        capture: seed.capture,
        state: 'recording',
      },
      { onConflict: 'session_id,user_id' },
    )
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as Track
}

export async function updateTrack(id: string, patch: Partial<Track>): Promise<void> {
  const { error } = await supabase().from('tracks').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function tracksForSession(sessionId: string): Promise<Track[]> {
  const { data, error } = await supabase()
    .from('tracks')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as Track[]
}

// ------------------------------------------------------------------ jingles

export async function myJingles(roomId?: string): Promise<Jingle[]> {
  let query = supabase().from('jingles').select('*').order('created_at', { ascending: false })
  if (roomId) query = query.or(`room_id.eq.${roomId},room_id.is.null`)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as Jingle[]
}

export async function uploadJingle(
  file: File,
  kind: Jingle['kind'],
  durationSec: number,
  roomId: string | null,
): Promise<Jingle> {
  const sb = supabase()
  const { data: auth } = await sb.auth.getUser()
  if (!auth.user) throw new Error('Not signed in')

  const id = crypto.randomUUID()
  const extension = file.name.split('.').pop()?.toLowerCase() || 'mp3'
  const path = `${auth.user.id}/${id}.${extension}`

  const { error: uploadError } = await sb.storage
    .from('jingles')
    .upload(path, file, { contentType: file.type || 'audio/mpeg', upsert: false })
  if (uploadError) throw new Error(`Could not upload: ${uploadError.message}`)

  const { data, error } = await sb
    .from('jingles')
    .insert({
      id,
      owner_id: auth.user.id,
      room_id: roomId,
      name: file.name.replace(/\.[^.]+$/, ''),
      kind,
      path,
      duration_sec: durationSec,
      bytes: file.size,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as Jingle
}

export async function deleteJingle(jingle: Jingle): Promise<void> {
  const sb = supabase()
  await sb.storage.from('jingles').remove([jingle.path])
  const { error } = await sb.from('jingles').delete().eq('id', jingle.id)
  if (error) throw new Error(error.message)
}

export async function loadJingleAudio(
  jingle: Jingle,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const { data, error } = await supabase().storage.from('jingles').download(jingle.path)
  if (error || !data) throw new Error(`Could not load ${jingle.name}`)

  const ctx = new OfflineAudioContext(1, 1, 48000)
  const decoded = await ctx.decodeAudioData(await data.arrayBuffer())
  const channel = decoded.getChannelData(0)
  const samples = new Float32Array(channel.length)
  samples.set(channel)
  return { samples, sampleRate: decoded.sampleRate }
}

// ---------------------------------------------------------- session jingles

export async function placementsForSession(sessionId: string): Promise<SessionJingle[]> {
  const { data, error } = await supabase()
    .from('session_jingles')
    .select('*')
    .eq('session_id', sessionId)
    .order('at_sec', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as SessionJingle[]
}

export async function placeJingle(
  placement: Omit<SessionJingle, 'id' | 'created_at'>,
): Promise<SessionJingle> {
  const { data, error } = await supabase()
    .from('session_jingles')
    .insert(placement)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as SessionJingle
}

export async function updatePlacement(id: string, patch: Partial<SessionJingle>): Promise<void> {
  const { error } = await supabase().from('session_jingles').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function removePlacement(id: string): Promise<void> {
  const { error } = await supabase().from('session_jingles').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// -------------------------------------------------------------------- mixes

export async function saveMix(
  sessionId: string,
  blob: Blob,
  meta: { format: Mix['format']; lufs: number; truePeakDb: number; durationSec: number; settings: Record<string, unknown> },
): Promise<Mix> {
  const sb = supabase()
  const id = crypto.randomUUID()
  const path = `${sessionId}/${id}.${meta.format}`

  const { error: uploadError } = await sb.storage
    .from('mixes')
    .upload(path, blob, { contentType: blob.type || 'audio/wav', upsert: true })
  if (uploadError) throw new Error(`Could not store the mix: ${uploadError.message}`)

  const { data, error } = await sb
    .from('mixes')
    .insert({
      id,
      session_id: sessionId,
      path,
      format: meta.format,
      lufs: meta.lufs,
      true_peak_db: meta.truePeakDb,
      duration_sec: meta.durationSec,
      bytes: blob.size,
      settings: meta.settings,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as Mix
}

export async function mixesForSession(sessionId: string): Promise<Mix[]> {
  const { data, error } = await supabase()
    .from('mixes')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as Mix[]
}

/** Frees the free tier after you have the files. */
export async function forgetSessionAudio(sessionId: string): Promise<void> {
  const sb = supabase()
  const { data: files } = await sb.storage.from('stems').list(sessionId, { limit: 1000 })
  if (files) {
    for (const folder of files) {
      const { data: inner } = await sb.storage.from('stems').list(`${sessionId}/${folder.name}`, { limit: 1000 })
      if (inner?.length) {
        await sb.storage
          .from('stems')
          .remove(inner.map((f) => `${sessionId}/${folder.name}/${f.name}`))
      }
    }
  }
  const { error } = await sb.rpc('forget_session_audio', { target_session: sessionId })
  if (error) throw new Error(error.message)
}
