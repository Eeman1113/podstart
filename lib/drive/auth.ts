'use client'

/**
 * Google Drive sign-in.
 *
 * podstart is a static site with no server, so there is nowhere to keep a
 * client secret and no need for one: Google Identity Services issues an access
 * token straight to the page.
 *
 * Two deliberate choices:
 *
 *   - The only scope requested is `drive.file`, which grants access to files
 *     THIS app creates and nothing else. podstart cannot see, list or touch
 *     anything already in your Drive. It is also a non-sensitive scope, so the
 *     consent screen can be published without Google's verification review.
 *
 *   - The token is held in memory only. It is never written to localStorage,
 *     because anything stored there is readable by any script that ever runs
 *     on the origin. Re-authorising is a silent round trip once you have
 *     granted consent, so there is nothing to gain by persisting it.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            prompt?: string
            callback(response: TokenResponse): void
            error_callback?(error: { type: string; message?: string }): void
          }): TokenClient
          revoke(token: string, done?: () => void): void
        }
      }
    }
  }
}

let scriptPromise: Promise<void> | null = null

function loadGis(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in a browser'))
  if (window.google?.accounts?.oauth2) return Promise.resolve()

  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google sign-in failed to load')))
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Error('Could not reach Google sign-in. Check your connection or a blocker.'))
    document.head.appendChild(script)
  })

  return scriptPromise
}

let token: { value: string; expiresAt: number } | null = null

export function clientId(): string | null {
  return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || null
}

export function isDriveConfigured(): boolean {
  return Boolean(clientId())
}

export function hasToken(): boolean {
  // A minute of slack, so a long upload never starts on a token about to die.
  return Boolean(token && token.expiresAt > Date.now() + 60_000)
}

/**
 * Returns a usable access token, prompting for consent only when needed.
 *
 * `interactive: false` attempts the silent path, which works once the user has
 * granted consent in this browser. Call it that way on a background refresh so
 * an automatic archive never throws a popup at someone mid-episode.
 */
export async function getAccessToken(interactive = true): Promise<string> {
  if (hasToken()) return token!.value

  const id = clientId()
  if (!id) {
    throw new Error(
      'Google Drive is not configured. Add NEXT_PUBLIC_GOOGLE_CLIENT_ID — see the README.',
    )
  }

  await loadGis()
  const oauth2 = window.google?.accounts.oauth2
  if (!oauth2) throw new Error('Google sign-in did not initialise.')

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ||
                (response.error === 'access_denied'
                  ? 'Drive access was declined.'
                  : `Google sign-in failed (${response.error ?? 'no token'}).`),
            ),
          )
          return
        }
        token = {
          value: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        }
        resolve(response.access_token)
      },
      error_callback: (error) =>
        reject(
          new Error(
            error.type === 'popup_closed'
              ? 'The Google sign-in window was closed before finishing.'
              : error.message || 'Google sign-in failed.',
          ),
        ),
    })

    // '' lets Google skip the consent screen when it already has an answer.
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

export function signOutOfDrive(): void {
  const current = token?.value
  token = null
  if (current) window.google?.accounts.oauth2.revoke(current)
}
