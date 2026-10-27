/**
 * Messages exchanged between the two browsers.
 *
 * Everything time-critical travels over the WebRTC data channel, which is a
 * direct peer-to-peer path and typically an order of magnitude lower latency
 * than relaying through Supabase. Realtime is used only to introduce the two
 * peers and as a fallback when a direct connection cannot be established.
 */

export type PeerMessage =
  /** Clock synchronisation, NTP style. See lib/room/sync.ts. */
  | { t: 'ping'; id: number; sent: number }
  | { t: 'pong'; id: number; sent: number; received: number; replied: number }

  /** Live level for the remote half of the waveform, ~20 Hz. */
  | { t: 'env'; peak: number; rms: number; at: number }

  /** Transport. `downbeat` is an instant on the host's clock. */
  | { t: 'arm'; sessionId: string }
  | { t: 'downbeat'; sessionId: string; at: number; countdownMs: number }
  | { t: 'stop'; sessionId: string; at: number }
  | { t: 'cue'; jingleId: string; at: number }

  /** Status, so each side can show the other's state honestly. */
  | {
      t: 'status'
      name: string
      armed: boolean
      recording: boolean
      muted: boolean
      /** Raw capture achieved, for the quality badge. */
      quality: 'raw' | 'processed' | 'unknown'
      sampleRate: number
      /** Segments confirmed uploaded, so the host can show real progress. */
      uploaded: number
      pending: number
    }

  | { t: 'chat'; text: string; at: number }

export interface SignalEnvelope {
  from: string
  to?: string
  kind: 'offer' | 'answer' | 'ice' | 'hello' | 'bye'
  payload: unknown
}

export const DATA_CHANNEL_LABEL = 'podstart'
