'use client'

import type { CSSProperties, ReactNode } from 'react'

/** Small shared primitives, styled from the tokens in app/globals.css. */

export function Button({
  children,
  onClick,
  variant = 'plain',
  disabled,
  type = 'button',
  full,
  style,
  'aria-label': ariaLabel,
}: {
  children: ReactNode
  onClick?(): void
  variant?: 'primary' | 'plain' | 'quiet' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
  full?: boolean
  style?: CSSProperties
  'aria-label'?: string
}) {
  const palette: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent)', color: '#fff' },
    danger: { background: 'var(--record)', color: '#fff' },
    plain: { background: 'var(--bg-control)', color: 'var(--label)' },
    quiet: { background: 'transparent', color: 'var(--accent)' },
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        minHeight: 'var(--tap)',
        padding: '0 20px',
        borderRadius: 'var(--radius)',
        fontWeight: 600,
        fontSize: 17,
        width: full ? '100%' : undefined,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'transform 120ms var(--ease), opacity 120ms var(--ease)',
        ...palette[variant],
        ...style,
      }}
      onPointerDown={(event) => {
        if (!disabled) event.currentTarget.style.transform = 'scale(0.97)'
      }}
      onPointerUp={(event) => {
        event.currentTarget.style.transform = 'scale(1)'
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.transform = 'scale(1)'
      }}
    >
      {children}
    </button>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      style={{
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-lg)',
        padding: 20,
        ...style,
      }}
    >
      {children}
    </section>
  )
}

export function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  tone?: 'default' | 'good' | 'warn'
}) {
  const colours = {
    default: 'var(--label)',
    good: 'var(--good)',
    warn: 'var(--warn)',
  }
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 16,
        padding: '11px 0',
        borderBottom: '1px solid var(--separator)',
      }}
    >
      <span style={{ color: 'var(--label-secondary)', fontSize: 15 }}>{label}</span>
      <span className="mono" style={{ color: colours[tone], fontSize: 15, textAlign: 'right' }}>
        {value}
      </span>
    </div>
  )
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'live' | 'good' | 'warn'
}) {
  const tones = {
    neutral: { background: 'var(--bg-control)', color: 'var(--label-secondary)' },
    live: { background: 'var(--record)', color: '#fff' },
    good: { background: 'color-mix(in srgb, var(--good) 18%, transparent)', color: 'var(--good)' },
    warn: { background: 'color-mix(in srgb, var(--warn) 18%, transparent)', color: 'var(--warn)' },
  }
  return (
    <span
      className="slate"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        color: tones[tone].color,
        background: tones[tone].background,
      }}
    >
      {children}
    </span>
  )
}

/** A labelled slider. Always shows its value: a slider with no number is a toy. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?(value: number): string
  onChange(value: number): void
}) {
  const id = `slider-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <div style={{ padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <label htmlFor={id} style={{ fontSize: 15, color: 'var(--label-secondary)' }}>
          {label}
        </label>
        <span className="mono" style={{ fontSize: 14, color: 'var(--label)' }}>
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: '100%', minHeight: 32, padding: 0, background: 'transparent', border: 0, accentColor: 'var(--accent)' }}
      />
    </div>
  )
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange(value: boolean): void
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '12px 0',
        cursor: 'pointer',
      }}
    >
      <span>
        <span style={{ display: 'block', fontSize: 16 }}>{label}</span>
        {description && (
          <span style={{ display: 'block', fontSize: 13, color: 'var(--label-secondary)', marginTop: 2 }}>
            {description}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={{ width: 52, height: 32, flex: '0 0 auto', accentColor: 'var(--good)', margin: 0, padding: 0, minHeight: 0 }}
      />
    </label>
  )
}

export function Notice({
  tone = 'warn',
  children,
  onDismiss,
}: {
  tone?: 'warn' | 'good' | 'info'
  children: ReactNode
  onDismiss?(): void
}) {
  const colour = tone === 'good' ? 'var(--good)' : tone === 'info' ? 'var(--accent)' : 'var(--warn)'
  return (
    <div
      role={tone === 'warn' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 'var(--radius)',
        background: `color-mix(in srgb, ${colour} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${colour} 40%, transparent)`,
        fontSize: 15,
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" style={{ color: colour, fontWeight: 600 }}>
          ✕
        </button>
      )}
    </div>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '2px solid var(--bg-control)',
          borderTopColor: 'var(--accent)',
          animation: 'podstart-spin 800ms linear infinite',
        }}
      />
      <span style={{ fontSize: 15, color: 'var(--label-secondary)' }}>{label}</span>
      <style>{'@keyframes podstart-spin { to { transform: rotate(360deg) } }'}</style>
    </span>
  )
}
