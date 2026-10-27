/** Short, collision-resistant ids for client-side objects (segments, peers). */
export function uid(prefix = ''): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const body = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('')
  return prefix ? `${prefix}_${body}` : body
}

/** Zero-padded segment index, so object listings sort correctly as strings. */
export function segmentName(idx: number, ext: string): string {
  return `${String(idx).padStart(5, '0')}.${ext}`
}
