/** Timecode as hh:mm:ss.mmm, or mm:ss.mmm under an hour. Tabular-safe. */
export function timecode(seconds: number, withMillis = true): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  const core = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return withMillis ? `${core}.${String(ms).padStart(3, '0')}` : core
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Linear amplitude (0..1) to dBFS, floored so log never returns -Infinity. */
export function dbfs(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-6))
}

/** Maps dBFS onto 0..1 for meters, with the useful range expanded. */
export function meterScale(db: number, floor = -60): number {
  if (db <= floor) return 0
  const t = (db - floor) / -floor
  return Math.min(1, Math.max(0, t ** 0.65))
}

export function signedDb(db: number): string {
  const r = Math.round(db * 10) / 10
  return `${r > 0 ? '+' : ''}${r.toFixed(1)}`
}
