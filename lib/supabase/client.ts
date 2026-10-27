'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * A single browser client for the whole app.
 *
 * podstart is a static bundle, so there is no server half to pair with: the
 * anon key below is public by design and every table is guarded by row-level
 * security (see supabase/migrations/0002_policies.sql).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let cached: SupabaseClient | null = null

export function isConfigured(): boolean {
  return Boolean(url && anonKey)
}

export function supabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Copy .env.example to .env.local and fill in ' +
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    )
  }
  cached ??= createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    realtime: {
      params: {
        // Level envelopes for the live waveform arrive at ~20 Hz per peer. The
        // default of 10/s would throttle them; the data channel carries the bulk
        // but this keeps the Realtime fallback usable.
        eventsPerSecond: 40,
      },
    },
  })
  return cached
}

/** Signs in as an anonymous guest so a friend can record without an account. */
export async function ensureSignedIn(displayName?: string): Promise<string> {
  const sb = supabase()
  const { data: existing } = await sb.auth.getSession()
  if (existing.session) return existing.session.user.id

  const { data, error } = await sb.auth.signInAnonymously({
    options: displayName ? { data: { display_name: displayName } } : undefined,
  })
  if (error) throw error
  if (!data.user) throw new Error('anonymous sign-in returned no user')
  return data.user.id
}
