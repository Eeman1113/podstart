'use client'

import { DATA_CHANNEL_LABEL, type PeerMessage, type SignalEnvelope } from '@/lib/room/protocol'

/**
 * The direct connection between the two of you.
 *
 * Carries two things: a talkback audio stream so you can hear each other, and
 * a data channel for transport commands, clock pings and the level envelopes
 * that draw the remote half of the waveform.
 *
 * It deliberately carries NO recorded audio. Each side records itself locally
 * at full quality; if this connection stutters, drops or never forms at all,
 * the recording is untouched. That is the whole reason the app works over bad
 * connections, and it is the opposite of how a video call behaves.
 *
 * Negotiation uses the "perfect negotiation" pattern: the polite peer yields
 * when both sides offer at once, so neither needs to be designated first.
 */

export interface PeerEvents {
  onMessage?(message: PeerMessage): void
  onRemoteStream?(stream: MediaStream): void
  onStateChange?(state: RTCPeerConnectionState): void
  onDataChannel?(open: boolean): void
  onError?(error: Error): void
}

export interface PeerOptions {
  /** True for exactly one of the two peers; decided by comparing user ids. */
  polite: boolean
  send(signal: Omit<SignalEnvelope, 'from'>): void
  events?: PeerEvents
  turn?: { url: string; username: string; credential: string } | null
}

function iceServers(turn: PeerOptions['turn']): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ]
  if (turn?.url) {
    servers.push({ urls: turn.url, username: turn.username, credential: turn.credential })
  }
  return servers
}

export class Peer {
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private makingOffer = false
  private ignoreOffer = false
  private readonly events: PeerEvents
  private queuedCandidates: RTCIceCandidateInit[] = []

  constructor(private readonly options: PeerOptions) {
    this.events = options.events ?? {}
    this.pc = new RTCPeerConnection({
      iceServers: iceServers(options.turn ?? null),
      bundlePolicy: 'max-bundle',
    })

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await this.pc.setLocalDescription()
        this.options.send({ kind: 'offer', payload: this.pc.localDescription?.toJSON() })
      } catch (error) {
        this.events.onError?.(error as Error)
      } finally {
        this.makingOffer = false
      }
    }

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.options.send({ kind: 'ice', payload: candidate.toJSON() })
    }

    this.pc.onconnectionstatechange = () => {
      this.events.onStateChange?.(this.pc.connectionState)
    }

    this.pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream) this.events.onRemoteStream?.(stream)
    }

    this.pc.ondatachannel = (event) => {
      if (event.channel.label === DATA_CHANNEL_LABEL) this.bindChannel(event.channel)
    }
  }

  /** The offerer creates the channel; the answerer receives it via ondatachannel. */
  openDataChannel(): void {
    if (this.channel) return
    this.bindChannel(
      this.pc.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
        // Envelopes and pings are worthless if late; never block on retransmits.
        maxRetransmits: 2,
      }),
    )
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel
    channel.onopen = () => this.events.onDataChannel?.(true)
    channel.onclose = () => this.events.onDataChannel?.(false)
    channel.onmessage = (event) => {
      try {
        this.events.onMessage?.(JSON.parse(event.data) as PeerMessage)
      } catch {
        /* a malformed frame is not worth tearing the call down for */
      }
    }
  }

  get dataChannelOpen(): boolean {
    return this.channel?.readyState === 'open'
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState
  }

  send(message: PeerMessage): boolean {
    if (this.channel?.readyState !== 'open') return false
    try {
      this.channel.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  /** Adds the local microphone as talkback. Separate from recording. */
  addTalkback(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) this.pc.addTrack(track, stream)
  }

  async handleSignal(signal: SignalEnvelope): Promise<void> {
    try {
      if (signal.kind === 'offer' || signal.kind === 'answer') {
        const description = signal.payload as RTCSessionDescriptionInit
        const offerCollision =
          description.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable')

        this.ignoreOffer = !this.options.polite && offerCollision
        if (this.ignoreOffer) return

        await this.pc.setRemoteDescription(description)
        for (const candidate of this.queuedCandidates.splice(0)) {
          await this.pc.addIceCandidate(candidate).catch(() => undefined)
        }
        if (description.type === 'offer') {
          await this.pc.setLocalDescription()
          this.options.send({ kind: 'answer', payload: this.pc.localDescription?.toJSON() })
        }
        return
      }

      if (signal.kind === 'ice') {
        const candidate = signal.payload as RTCIceCandidateInit
        if (!this.pc.remoteDescription) {
          // Candidates can outrun the description; hold them rather than drop.
          this.queuedCandidates.push(candidate)
          return
        }
        await this.pc.addIceCandidate(candidate).catch((error) => {
          if (!this.ignoreOffer) throw error
        })
      }
    } catch (error) {
      this.events.onError?.(error as Error)
    }
  }

  close(): void {
    try {
      this.channel?.close()
      this.pc.close()
    } catch {
      /* already closed */
    }
  }
}
