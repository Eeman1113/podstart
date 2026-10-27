'use client'

import type { PeerMessage } from '@/lib/room/protocol'

/**
 * Clock synchronisation between the two devices.
 *
 * Two phones' system clocks routinely disagree by hundreds of milliseconds --
 * more than enough to make one voice answer before the other finished asking.
 * Before any recording starts we measure that disagreement directly, using the
 * same round-trip method NTP uses:
 *
 *     t0  we send      (our clock)
 *     t1  they receive (their clock)
 *     t2  they reply   (their clock)
 *     t3  we receive   (our clock)
 *
 *     offset = ((t1 - t0) + (t2 - t3)) / 2
 *     rtt    = (t3 - t0) - (t2 - t1)
 *
 * The arithmetic assumes the path is symmetrical, which it mostly is not. So
 * we fire a burst and keep the sample with the smallest round trip: the least
 * delayed exchange is the least distorted one. That is the standard trick, and
 * it reliably lands inside a few milliseconds on a normal connection.
 */

export interface SyncResult {
  /** Add to our clock to get theirs. */
  offsetMs: number
  rttMs: number
  samples: number
  /** Spread of the accepted samples: our honest confidence figure. */
  jitterMs: number
}

const BURST = 12
const SPACING_MS = 120

function now(): number {
  return performance.timeOrigin + performance.now()
}

export class ClockSync {
  private pending = new Map<number, number>()
  private results: { offset: number; rtt: number }[] = []
  private nextId = 1
  private resolve: ((result: SyncResult) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly send: (message: PeerMessage) => void) {}

  /** Answers someone else's ping. Pure reflection, no state. */
  static reply(message: Extract<PeerMessage, { t: 'ping' }>): PeerMessage {
    const received = now()
    return { t: 'pong', id: message.id, sent: message.sent, received, replied: now() }
  }

  handle(message: PeerMessage): boolean {
    if (message.t === 'ping') {
      this.send(ClockSync.reply(message))
      return true
    }
    if (message.t !== 'pong') return false

    const t0 = this.pending.get(message.id)
    if (t0 === undefined) return true
    this.pending.delete(message.id)

    const t3 = now()
    const t1 = message.received
    const t2 = message.replied

    const rtt = t3 - t0 - (t2 - t1)
    const offset = (t1 - t0 + (t2 - t3)) / 2
    // A negative round trip means a clock stepped mid-measurement; discard it.
    if (rtt >= 0 && rtt < 5000) this.results.push({ offset, rtt })

    if (this.results.length + this.pending.size === 0) this.finish()
    return true
  }

  /** Fires a burst and resolves with the best estimate. */
  measure(): Promise<SyncResult> {
    this.results = []
    this.pending.clear()

    return new Promise<SyncResult>((resolve) => {
      this.resolve = resolve
      let sent = 0
      const fire = () => {
        if (sent >= BURST) {
          // Give the last few replies a moment, then settle.
          this.timer = setTimeout(() => this.finish(), 600)
          return
        }
        const id = this.nextId
        this.nextId += 1
        this.pending.set(id, now())
        this.send({ t: 'ping', id, sent: now() })
        sent += 1
        this.timer = setTimeout(fire, SPACING_MS)
      }
      fire()
    })
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const resolve = this.resolve
    this.resolve = null
    if (!resolve) return

    if (this.results.length === 0) {
      resolve({ offsetMs: 0, rttMs: Number.POSITIVE_INFINITY, samples: 0, jitterMs: Infinity })
      return
    }

    const byRtt = [...this.results].sort((a, b) => a.rtt - b.rtt)
    // Keep the best third: enough to average out noise, few enough that a
    // congested burst cannot drag the estimate.
    const keep = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 3)))
    const offsets = keep.map((r) => r.offset)
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length
    const jitter =
      offsets.length > 1
        ? Math.sqrt(offsets.reduce((a, o) => a + (o - mean) ** 2, 0) / (offsets.length - 1))
        : 0

    resolve({
      offsetMs: mean,
      rttMs: keep[0]!.rtt,
      samples: this.results.length,
      jitterMs: jitter,
    })
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.resolve = null
    this.pending.clear()
  }
}

/** Converts an instant on the host's clock into this device's clock. */
export function hostTimeToLocal(hostEpochMs: number, offsetMs: number): number {
  return hostEpochMs - offsetMs
}

/** Converts one of our instants into the host's clock. */
export function localTimeToHost(localEpochMs: number, offsetMs: number): number {
  return localEpochMs + offsetMs
}
