/**
 * Hand-written row types mirroring supabase/migrations.
 * Regenerate with `supabase gen types typescript` if you change the schema.
 */

export type SessionState =
  | 'idle' | 'armed' | 'recording' | 'stopped' | 'processing' | 'ready' | 'failed'

export type TrackState = 'recording' | 'uploading' | 'complete' | 'failed'
export type JingleKind = 'intro' | 'outro' | 'sting' | 'bed'
export type MemberRole = 'host' | 'guest'

export interface Profile {
  id: string
  display_name: string
  created_at: string
}

export interface Room {
  id: string
  code: string
  name: string
  owner_id: string
  created_at: string
}

export interface RoomMember {
  room_id: string
  user_id: string
  role: MemberRole
  joined_at: string
}

/**
 * 'clean' allows the cleanup chain and the mastering stage.
 * 'raw' forbids both: the samples are never altered by anything.
 */
export type ProcessingMode = 'clean' | 'raw'

export interface Session {
  id: string
  room_id: string
  title: string
  state: SessionState
  processing: ProcessingMode
  created_by: string
  downbeat_epoch_ms: number | null
  stopped_epoch_ms: number | null
  created_at: string
}

/** What the browser actually managed to negotiate, shown as a quality badge. */
export interface CaptureReport {
  sampleRate: number
  channels: number
  bitDepth: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  deviceLabel: string
  /** 'raw' when we defeated the browser's voice processing, which is the goal. */
  path: 'raw' | 'processed'
  userAgent: string
}

export interface Track {
  id: string
  session_id: string
  user_id: string
  display_name: string
  sample_rate: number
  channels: number
  codec: 'flac' | 'wav'
  start_epoch_ms: number
  clock_offset_ms: number
  clock_rtt_ms: number | null
  drift_ppm: number | null
  duration_sec: number
  segment_count: number
  bytes: number
  capture: Partial<CaptureReport>
  state: TrackState
  created_at: string
}

export interface TrackSegment {
  id: string
  track_id: string
  idx: number
  path: string
  bytes: number
  start_sample: number
  frames: number
  created_at: string
}

export interface Jingle {
  id: string
  owner_id: string
  room_id: string | null
  name: string
  kind: JingleKind
  path: string
  duration_sec: number
  bytes: number
  lufs: number | null
  created_at: string
}

export interface SessionJingle {
  id: string
  session_id: string
  jingle_id: string
  at_sec: number
  gain_db: number
  fade_in_ms: number
  fade_out_ms: number
  duck_db: number
  created_at: string
}

export interface Mix {
  id: string
  session_id: string
  path: string
  format: 'wav' | 'mp3' | 'opus' | 'flac'
  lufs: number | null
  true_peak_db: number | null
  duration_sec: number
  bytes: number
  settings: Record<string, unknown>
  created_at: string
}
