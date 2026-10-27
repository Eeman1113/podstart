'use client'

import { dbfs, meterScale } from '@/lib/util/format'

/**
 * A level meter that tells you the one thing that matters while recording:
 * whether you are going to regret this in an hour.
 *
 * Peak and RMS are shown together. RMS is where the voice actually sits;
 * peak is what clips. The target band is marked, because "aim for the middle"
 * is advice a meter can give and a number cannot.
 */
export function LevelMeter({
  peak,
  rms,
  label,
  tone = 'mine',
  clipped,
}: {
  peak: number
  rms: number
  label: string
  tone?: 'friend' | 'mine'
  clipped?: boolean
}) {
  const peakDb = dbfs(peak)
  const rmsDb = dbfs(rms)
  const colour = clipped ? 'var(--record)' : `var(--${tone})`

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="slate" style={{ color: `var(--${tone})` }}>
          {label}
        </span>
        <span
          className="mono"
          style={{ fontSize: 12, color: clipped ? 'var(--record)' : 'var(--label-secondary)' }}
        >
          {clipped ? 'CLIPPING' : `${peakDb > -60 ? peakDb.toFixed(1) : '−∞'} dB`}
        </span>
      </div>

      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuenow={Math.round(peakDb)}
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuetext={`${peakDb.toFixed(0)} decibels, ${describe(peakDb)}`}
        style={{
          position: 'relative',
          height: 8,
          borderRadius: 4,
          background: 'var(--bg-control)',
          overflow: 'hidden',
        }}
      >
        {/* The healthy band: -18 to -6 dBFS. */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: `${meterScale(-18) * 100}%`,
            width: `${(meterScale(-6) - meterScale(-18)) * 100}%`,
            top: 0,
            bottom: 0,
            background: 'color-mix(in srgb, var(--good) 22%, transparent)',
          }}
        />
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${meterScale(rmsDb) * 100}%`,
            background: colour,
            opacity: 0.55,
            transition: 'width 60ms linear',
          }}
        />
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: `${meterScale(peakDb) * 100}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: colour,
            transition: 'left 60ms linear',
          }}
        />
      </div>
    </div>
  )
}

function describe(db: number): string {
  if (db > -3) return 'too loud, clipping'
  if (db > -6) return 'hot'
  if (db > -18) return 'good'
  if (db > -30) return 'quiet'
  return 'very quiet'
}
