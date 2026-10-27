#!/usr/bin/env node
/**
 * Generates the secrets a self-hosted Supabase needs.
 *
 * The anon and service keys are not random strings: they are JWTs signed with
 * the project's JWT secret, carrying a role claim. PostgREST and the other
 * services verify them with that same secret, which is how a key presented by
 * a browser becomes a Postgres role and therefore a set of row-level security
 * policies.
 *
 * Run with no arguments to print a fresh set.
 */
import { createHmac, randomBytes } from 'node:crypto'

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function sign(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${header}.${body}.${signature}`
}

const jwtSecret = randomBytes(32).toString('hex')
const issuedAt = Math.floor(Date.now() / 1000)
// Ten years: these are infrastructure credentials, not sessions. Rotate them
// by regenerating the whole set, not by waiting for an expiry.
const expiresAt = issuedAt + 60 * 60 * 24 * 365 * 10

const anonKey = sign({ role: 'anon', iss: 'supabase', iat: issuedAt, exp: expiresAt }, jwtSecret)
const serviceKey = sign(
  { role: 'service_role', iss: 'supabase', iat: issuedAt, exp: expiresAt },
  jwtSecret,
)

// Postgres password: alphanumeric only. Punctuation here ends up inside
// connection URLs in half a dozen config files and breaks parsing in at least
// one of them every single time.
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const pick = (n) =>
  Array.from(randomBytes(n), (byte) => alphabet[byte % alphabet.length]).join('')

console.log(`POSTGRES_PASSWORD=${pick(32)}`)
console.log(`JWT_SECRET=${jwtSecret}`)
console.log(`ANON_KEY=${anonKey}`)
console.log(`SERVICE_ROLE_KEY=${serviceKey}`)
console.log(`DASHBOARD_USERNAME=podstart`)
console.log(`DASHBOARD_PASSWORD=${pick(24)}`)
console.log(`SECRET_KEY_BASE=${randomBytes(32).toString('hex')}`)
console.log(`VAULT_ENC_KEY=${pick(32)}`)
