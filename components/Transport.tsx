'use client'

import { timecode } from '@/lib/util/format'

/**
 * The transport, laid out the way Voice Memos lays it out: the running
 * timecode large and centred, skip controls either side of the play button,
 * and the record button alone beneath, because it is the only control with
 * consequences.
 */

export function Timecode({ seconds, live }: { seconds: number; live: boolean }) {
  const text = timecode(seconds, true)
  const [main, millis] = text.split('.')

  return (
    <div
      className="mono"
      role="timer"
      aria-live="off"
      style={{
        textAlign: 'center',
        fontSize: 'clamp(34px, 11vw, 52px)',
        fontWeight: 300,
        letterSpacing: '-0.02em',
        color: 'var(--label)',
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'center',
        gap: 2,
      }}
    >
      <span>{main}</span>
      <span style={{ fontSize: '0.56em', color: live ? 'var(--record)' : 'var(--label-tertiary)' }}>
        .{millis}
      </span>
      <span className="sr-only">
        {live ? 'Recording. ' : ''}
        {Math.floor(seconds / 60)} minutes {Math.floor(seconds % 60)} seconds
      </span>
    </div>
  )
}

export function Transport({
  recording,
  armed,
  playing,
  canRecord,
  onRecord,
  onStop,
  onPlayPause,
  onSkip,
  disabledReason,
}: {
  recording: boolean
  armed: boolean
  playing: boolean
  canRecord: boolean
  onRecord(): void
  onStop(): void
  onPlayPause(): void
  onSkip(seconds: number): void
  disabledReason?: string
}) {
  return (
    <div style={{ display: 'grid', gap: 22, justifyItems: 'center' }}>
      {!recording && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          <SkipButton seconds={-15} onClick={() => onSkip(-15)} />
          <button
            onClick={onPlayPause}
            aria-label={playing ? 'Pause' : 'Play'}
            style={{ width: 56, height: 56, display: 'grid', placeItems: 'center' }}
          >
            {playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>
          <SkipButton seconds={15} onClick={() => onSkip(15)} />
        </div>
      )}

      <button
        onClick={recording ? onStop : onRecord}
        disabled={!canRecord && !recording}
        aria-label={recording ? 'Stop recording, both ends' : 'Start recording, both ends'}
        title={!canRecord && !recording ? disabledReason : undefined}
        style={{
          width: 76,
          height: 76,
          borderRadius: '50%',
          border: '3px solid var(--separator)',
          display: 'grid',
          placeItems: 'center',
          background: 'transparent',
          opacity: !canRecord && !recording ? 0.4 : 1,
          cursor: !canRecord && !recording ? 'not-allowed' : 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'block',
            background: 'var(--record)',
            transition: 'all 220ms var(--ease)',
            width: recording ? 28 : 58,
            height: recording ? 28 : 58,
            borderRadius: recording ? 7 : '50%',
            // Armed but not yet rolling: the one place motion is used, because
            // the countdown genuinely needs to be felt rather than read.
            animation: armed && !recording ? 'podstart-arm 900ms ease-in-out infinite' : undefined,
          }}
        />
        <style>
          {'@keyframes podstart-arm { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }'}
        </style>
      </button>

      {!canRecord && !recording && disabledReason && (
        <p style={{ fontSize: 14, color: 'var(--label-secondary)', textAlign: 'center', maxWidth: 320 }}>
          {disabledReason}
        </p>
      )}
    </div>
  )
}

function SkipButton({ seconds, onClick }: { seconds: number; onClick(): void }) {
  const back = seconds < 0
  return (
    <button
      onClick={onClick}
      aria-label={back ? 'Back 15 seconds' : 'Forward 15 seconds'}
      style={{ width: 'var(--tap)', height: 'var(--tap)', display: 'grid', placeItems: 'center' }}
    >
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
        <path
          d={
            back
              ? 'M15 7V3l-5 4.5L15 12V8a7 7 0 1 1-7 7'
              : 'M15 7V3l5 4.5L15 12V8a7 7 0 1 0 7 7'
          }
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text
          x="15"
          y="19"
          textAnchor="middle"
          fontSize="9"
          fontWeight="600"
          fill="currentColor"
        >
          15
        </text>
      </svg>
    </button>
  )
}

function PlayGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <path d="M10 6.5 27 17 10 27.5Z" fill="currentColor" />
    </svg>
  )
}

function PauseGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <rect x="9" y="7" width="5.5" height="20" rx="1.6" fill="currentColor" />
      <rect x="19.5" y="7" width="5.5" height="20" rx="1.6" fill="currentColor" />
    </svg>
  )
}
