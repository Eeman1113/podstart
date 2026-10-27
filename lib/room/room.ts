'use client'

import type { RealtimeChannel } from '@supabase/supabase-js'

import { Peer } from '@/lib/room/peer'
import { ClockSync, hostTimeToLocal, type SyncResult } from '@/lib/room/sync'
import type { PeerMessage, SignalEnvelope } from '@/lib/room/protocol'
import { supabase } from '@/lib/supabase/client'

/**
 * A room: presence, signalling, the peer connection and the shared clock,
 * behind one object the UI can hold.
 *
 * Supabase Realtime introduces the two of you and relays WebRTC signalling.
 * Once the peer connection is up, everything that matters moves to the direct
 * channel. If the direct channel never forms, transport commands fall back to
 * Realtime broadcast -- slower, but a recording that starts 80 ms apart and is
 * corrected by timestamps is still perfectly aligned in the final mix.
 */

export interface RemotePresence {
  userId: string
  name: string
  isHost: boolean
  online: boolean
}

export interface RemoteStatus {
  name: string
  armed: boolean
  recording: boolean
  muted: boolean
  quality: 'raw' | 'processed' | 'unknown'
  sampleRate: number
  uploaded: number
  pending: number
}

export interface RoomEvents {
  onPresence?(remote: RemotePresence | null): void
  onConnection?(state: RTCPeerConnectionState, dataChannelOpen: boolean): void
  onRemoteStream?(stream: MediaStream): void
  onRemoteStatus?(status: RemoteStatus): void
  onRemoteEnvelope?(peak: number, rms: number, at: number): void
  onClock?(result: SyncResult): void
  /** Fires on both devices with an instant already in LOCAL clock terms. */
  onDownbeat?(sessionId: string, localEpochMs: number, countdownMs: number): void
  onStopCommand?(sessionId: string): void
  onCue?(jingleId: string, localEpochMs: number): void
  onChat?(text: string, at: number): void
  onError?(error: Error): void
}

export interface RoomOptions {
  roomId: string
  userId: string
  displayName: string
  isHost: boolean
  events?: RoomEvents
  turn?: { url: string; username: string; credential: string } | null
}

export class Room {
  private channel: RealtimeChannel | null = null
  private peer: Peer | null = null
  private sync: ClockSync | null = null
  private remoteId: string | null = null
  private readonly events: RoomEvents

  /** Add to our clock to get the host's. Zero when we are the host. */
  offsetMs = 0
  clock: SyncResult | null = null

  constructor(private readonly options: RoomOptions) {
    this.events = options.events ?? {}
  }

  async connect(): Promise<void> {
    const sb = supabase()
    const channel = sb.channel(`room:${this.options.roomId}`, {
      config: {
        presence: { key: this.options.userId },
        broadcast: { self: false, ack: false },
      },
    })
    this.channel = channel

    channel.on('presence', { event: 'sync' }, () => this.readPresence())

    channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const signal = payload as SignalEnvelope
      if (signal.from === this.options.userId) return
      if (signal.to && signal.to !== this.options.userId) return
      void this.onSignal(signal)
    })

    // Transport fallback for when the data channel is not up.
    channel.on('broadcast', { event: 'peer' }, ({ payload }) => {
      const wrapped = payload as { from: string; message: PeerMessage }
      if (wrapped.from === this.options.userId) return
      this.onPeerMessage(wrapped.message, true)
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Could not reach the room server.')), 15000)
      channel.subscribe((status, error) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer)
          void channel.track({
            userId: this.options.userId,
            name: this.options.displayName,
            isHost: this.options.isHost,
            at: Date.now(),
          })
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer)
          reject(error ?? new Error(`Room connection failed (${status}).`))
        }
      })
    })
  }

  private readPresence(): void {
    const state = this.channel?.presenceState<{
      userId: string
      name: string
      isHost: boolean
    }>()
    if (!state) return

    const others = Object.values(state)
      .flat()
      .filter((p) => p.userId && p.userId !== this.options.userId)

    const first = others[0]
    if (!first) {
      this.remoteId = null
      this.events.onPresence?.(null)
      return
    }

    const wasConnected = this.remoteId === first.userId
    this.remoteId = first.userId
    this.events.onPresence?.({
      userId: first.userId,
      name: first.name,
      isHost: first.isHost,
      online: true,
    })

    if (!wasConnected) this.startNegotiation()
  }

  private startNegotiation(): void {
    if (this.peer || !this.remoteId) return

    // Politeness has to be decided identically on both sides without a round
    // trip: the lexicographically larger id yields.
    const polite = this.options.userId > this.remoteId

    this.peer = new Peer({
      polite,
      turn: this.options.turn ?? null,
      send: (signal) => this.sendSignal({ ...signal, from: this.options.userId }),
      events: {
        onMessage: (message) => this.onPeerMessage(message, false),
        onRemoteStream: (stream) => this.events.onRemoteStream?.(stream),
        onDataChannel: (open) => {
          this.events.onConnection?.(this.peer?.connectionState ?? 'new', open)
          // Both sides measure: the guest to get the offset it must apply,
          // the host so it can show the connection's real round trip.
          if (open) void this.measureClock()
        },
        onStateChange: (state) =>
          this.events.onConnection?.(state, this.peer?.dataChannelOpen ?? false),
        onError: (error) => this.events.onError?.(error),
      },
    })

    this.sync = new ClockSync((message) => this.send(message))

    // The impolite peer creates the channel, so exactly one is created.
    if (!polite) this.peer.openDataChannel()
  }

  /** Publishes our microphone as talkback. Call before negotiation settles. */
  addTalkback(stream: MediaStream): void {
    this.peer?.addTalkback(stream)
  }

  private sendSignal(signal: SignalEnvelope): void {
    void this.channel?.send({ type: 'broadcast', event: 'signal', payload: signal })
  }

  private async onSignal(signal: SignalEnvelope): Promise<void> {
    if (!this.peer) this.startNegotiation()
    await this.peer?.handleSignal(signal)
  }

  private onPeerMessage(message: PeerMessage, viaFallback: boolean): void {
    if (!viaFallback && this.sync?.handle(message)) return

    switch (message.t) {
      case 'status':
        this.events.onRemoteStatus?.(message)
        return
      case 'env':
        this.events.onRemoteEnvelope?.(message.peak, message.rms, message.at)
        return
      case 'downbeat': {
        // The host sends its own clock; convert before anyone acts on it.
        const local = this.options.isHost
          ? message.at
          : hostTimeToLocal(message.at, this.offsetMs)
        this.events.onDownbeat?.(message.sessionId, local, message.countdownMs)
        return
      }
      case 'stop':
        this.events.onStopCommand?.(message.sessionId)
        return
      case 'cue': {
        const local = this.options.isHost ? message.at : hostTimeToLocal(message.at, this.offsetMs)
        this.events.onCue?.(message.jingleId, local)
        return
      }
      case 'chat':
        this.events.onChat?.(message.text, message.at)
        return
      default:
    }
  }

  /** Direct channel if we have it, Realtime broadcast if we do not. */
  send(message: PeerMessage): void {
    if (this.peer?.send(message)) return
    void this.channel?.send({
      type: 'broadcast',
      event: 'peer',
      payload: { from: this.options.userId, message },
    })
  }

  /**
   * Measures the offset between the two clocks. Run by the guest against the
   * host, before arming, and again right before the downbeat.
   */
  async measureClock(): Promise<SyncResult | null> {
    if (!this.sync) return null
    const result = await this.sync.measure()
    this.clock = result
    // Only the guest adjusts; the host IS the reference.
    if (!this.options.isHost) this.offsetMs = result.offsetMs
    this.events.onClock?.(result)
    return result
  }

  /**
   * Schedules the downbeat. The lead-in has to exceed the one-way latency or
   * the far end would receive an instant that has already passed; a three
   * second count-in is both comfortable to perform to and far more than any
   * realistic network needs.
   */
  scheduleDownbeat(sessionId: string, countdownMs = 3000): number {
    const at = performance.timeOrigin + performance.now() + countdownMs
    this.send({ t: 'downbeat', sessionId, at, countdownMs })
    this.events.onDownbeat?.(sessionId, at, countdownMs)
    return at
  }

  stopAll(sessionId: string): void {
    const at = performance.timeOrigin + performance.now()
    this.send({ t: 'stop', sessionId, at })
    this.events.onStopCommand?.(sessionId)
  }

  get remoteUserId(): string | null {
    return this.remoteId
  }

  get connected(): boolean {
    return this.peer?.dataChannelOpen ?? false
  }

  async leave(): Promise<void> {
    this.sync?.cancel()
    this.peer?.close()
    this.peer = null
    try {
      await this.channel?.unsubscribe()
    } catch {
      /* going away anyway */
    }
    this.channel = null
  }
}
