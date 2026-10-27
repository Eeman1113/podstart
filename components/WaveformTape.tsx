'use client'

import { useCallback, useEffect, useRef } from 'react'

import { ENVELOPE_HZ, type EnvelopeTrack } from '@/lib/audio/envelope'

/**
 * The tape.
 *
 * One waveform split about a single centre line: your friend above, you below,
 * sharing one x-axis and one cue line. Two stacked separate waveforms would
 * show the same data; this shows the RELATIONSHIP, which is the thing that
 * used to cost you an evening. When one of you interrupts the other you can
 * see the overlap in a single shape.
 *
 * Drawn on a canvas at device resolution and repainted from a single rAF loop,
 * so an hour-long take costs nothing in DOM.
 */

export interface WaveformTapeProps {
  friend: EnvelopeTrack
  mine: EnvelopeTrack
  /** Playhead position, in seconds from the start of the take. */
  positionSec: number
  /** While true the view scrolls with the playhead pinned near the right. */
  live: boolean
  pxPerSecond?: number
  friendName?: string
  myName?: string
  friendConnected?: boolean
  onScrub?(seconds: number): void
  height?: number
}

const BAR_WIDTH = 2
const BAR_GAP = 1

export function WaveformTape({
  friend,
  mine,
  positionSec,
  live,
  pxPerSecond = 60,
  friendName = 'Friend',
  myName = 'You',
  friendConnected = true,
  onScrub,
  height = 320,
}: WaveformTapeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef(0)
  const stateRef = useRef({ positionSec, live, pxPerSecond, friendConnected })

  stateRef.current = { positionSec, live, pxPerSecond, friendConnected }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const width = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(h * dpr)
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, h)

    const styles = getComputedStyle(canvas)
    const friendColour = styles.getPropertyValue('--friend').trim() || '#64d2ff'
    const mineColour = styles.getPropertyValue('--mine').trim() || '#f5f5f7'
    const accent = styles.getPropertyValue('--accent').trim() || '#0a84ff'
    const separator = styles.getPropertyValue('--separator').trim() || 'rgba(84,84,88,0.65)'
    const tertiary = styles.getPropertyValue('--label-tertiary').trim() || 'rgba(235,235,245,0.42)'

    const { positionSec: pos, live: isLive, pxPerSecond: scale } = stateRef.current

    const centre = Math.round(h / 2) + 0.5
    // 50/50: each voice owns exactly half, minus a little room for the ruler.
    const halfHeight = h / 2 - 26

    // While recording the cue line sits at 72 % and the tape runs under it, the
    // way tape actually passes a playhead. Paused, the line is wherever you
    // scrubbed to and the whole take is in view.
    const cueX = isLive ? width * 0.72 : width * 0.5
    const startSec = pos - cueX / scale

    const step = BAR_WIDTH + BAR_GAP
    const columns = Math.ceil(width / step)

    const drawHalf = (track: EnvelopeTrack, colour: string, up: boolean) => {
      ctx.fillStyle = colour
      for (let c = 0; c < columns; c += 1) {
        const x = c * step
        const t0 = startSec + x / scale
        const t1 = startSec + (x + step) / scale
        if (t1 < 0) continue

        const i0 = t0 * ENVELOPE_HZ
        const i1 = Math.max(i0 + 1, t1 * ENVELOPE_HZ)
        const peak = track.peakOver(i0, i1)
        if (peak <= 0) continue

        // A gentle curve rather than raw amplitude: speech spends its life in
        // the bottom fifth of a linear scale and would draw as a flat line.
        const magnitude = Math.min(1, peak ** 0.62)
        const barHeight = Math.max(1.5, magnitude * halfHeight)

        ctx.fillRect(
          x,
          up ? centre - barHeight : centre,
          BAR_WIDTH,
          barHeight,
        )
      }
    }

    drawHalf(friend, friendColour, true)
    drawHalf(mine, mineColour, false)

    // The centre line both halves hang from.
    ctx.strokeStyle = separator
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centre)
    ctx.lineTo(width, centre)
    ctx.stroke()

    // Time ruler along the bottom.
    ctx.fillStyle = tertiary
    ctx.font = `500 11px ${styles.getPropertyValue('--mono').trim() || 'monospace'}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'

    const tickSeconds = chooseTickInterval(scale)
    const firstTick = Math.ceil(startSec / tickSeconds) * tickSeconds
    for (let t = firstTick; t < startSec + width / scale; t += tickSeconds) {
      if (t < 0) continue
      const x = (t - startSec) * scale
      ctx.globalAlpha = 0.5
      ctx.fillRect(x, h - 20, 1, 5)
      ctx.globalAlpha = 1
      ctx.fillText(formatTick(t), x, h - 6)
    }

    // The cue line, with the dot caps from Voice Memos.
    ctx.strokeStyle = accent
    ctx.fillStyle = accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(Math.round(cueX) + 0.5, 6)
    ctx.lineTo(Math.round(cueX) + 0.5, h - 24)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cueX, 6, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cueX, h - 24, 4, 0, Math.PI * 2)
    ctx.fill()

    frameRef.current = requestAnimationFrame(draw)
  }, [friend, mine])

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frameRef.current)
  }, [draw])

  const scrub = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onScrub || live) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const cueX = rect.width * 0.5
    onScrub(Math.max(0, positionSec + (x - cueX) / pxPerSecond))
  }

  return (
    <figure
      style={{
        position: 'relative',
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        margin: 0,
      }}
    >
      <TapeLabel text={friendName} tone="friend" position="top" dimmed={!friendConnected} />
      <TapeLabel text={myName} tone="mine" position="bottom" />

      <canvas
        ref={canvasRef}
        onPointerDown={scrub}
        onPointerMove={(event) => {
          if (event.buttons === 1) scrub(event)
        }}
        style={{
          display: 'block',
          width: '100%',
          height,
          touchAction: live ? 'auto' : 'none',
          cursor: onScrub && !live ? 'ew-resize' : 'default',
        }}
      />

      <figcaption className="sr-only">
        {`A split waveform. ${friendName}'s level is drawn above the centre line and ` +
          `${myName}'s below it, on one shared timeline. The playhead is at ` +
          `${positionSec.toFixed(1)} seconds.`}
      </figcaption>
    </figure>
  )
}

function TapeLabel({
  text,
  tone,
  position,
  dimmed = false,
}: {
  text: string
  tone: 'friend' | 'mine'
  position: 'top' | 'bottom'
  dimmed?: boolean
}) {
  return (
    <span
      className="slate"
      aria-hidden
      style={{
        position: 'absolute',
        left: 16,
        [position]: position === 'top' ? 14 : 34,
        color: `var(--${tone})`,
        opacity: dimmed ? 0.35 : 0.9,
        pointerEvents: 'none',
      }}
    >
      {text}
    </span>
  )
}

/** Keeps ruler ticks at a readable spacing whatever the zoom. */
function chooseTickInterval(pxPerSecond: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const seconds of candidates) {
    if (seconds * pxPerSecond >= 64) return seconds
  }
  return 900
}

function formatTick(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
