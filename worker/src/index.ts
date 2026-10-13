// Issues short-lived Cloudflare TURN credentials, so the long-term TURN key never reaches a browser.
//
// The app embeds GET /challenge in a hidden iframe. That page runs Turnstile on this worker's
// origin (so Cloudflare's script never runs inside the app's origin, where the chat keys live),
// trades the token for credentials at POST /credentials, and posts them to the parent window.
//
// Spending cap: relayed traffic is billed per gigabyte past a free monthly allowance. Every few minutes a
// scheduled run reads this month's usage from Cloudflare's analytics and records it; once it passes the
// limit, no more credentials are issued until the next month. Once there has been a reading, none are
// issued without a recent one either, so a check that breaks cannot leave the relay open. Chat still works
// over direct connections.

export type Env = {
  TURN_KEY_ID: string
  TURN_KEY_API_TOKEN: string
  TURNSTILE_SITE_KEY: string
  TURNSTILE_SECRET_KEY: string
  ALLOWED_ORIGINS: string
  CREDENTIAL_LIMITER: {limit: (options: {key: string}) => Promise<{success: boolean}>}
  /** Holds the latest usage reading. */
  USAGE: {get: (key: string) => Promise<string | null>; put: (key: string, value: string) => Promise<void>}
  ACCOUNT_ID: string
  /** Gigabytes of relayed traffic allowed per calendar month (UTC). */
  TURN_MONTHLY_LIMIT_GB: string
  /** Reads usage analytics. The spending cap is off until this is set. */
  ANALYTICS_API_TOKEN?: string
}

export type UsageReading = {month: string; egressBytes: number; limitBytes: number; checkedAt: number; paused: boolean}

const USAGE_KEY = 'turn-usage'
// The scheduled run is every ten minutes; a reading older than this means the check has stopped working.
const MAX_READING_AGE_MS = 6 * 60 * 60 * 1000
const GIGABYTE = 1e9

type IceServer = {urls: string | string[]; username?: string; credential?: string}

const CREDENTIAL_TTL_SECONDS = 4 * 60 * 60
const MAX_TOKEN_LENGTH = 2048
// Not exported: the Workers runtime rejects module exports that are not handlers.
const MESSAGE_TYPE = 'snrdlr-turn'

// Browsers block port 53, so those URLs only add a timeout.
const usableInBrowsers = (url: string) => !/:53(\?|$)/.test(url)

const allowedOrigins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map(entry => entry.trim())

const fail = (status: number, error: string) => Response.json({error}, {status, headers: {'Cache-Control': 'no-store'}})

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/challenge' && request.method === 'GET') return challengePage(url, env)
    if (url.pathname === '/credentials' && request.method === 'POST') return credentials(request, url, env)
    return new Response('Not found', {status: 404})
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await recordUsage(env, Date.now())
  }
}

/** This month's relayed bytes sent to clients, which is the direction Cloudflare bills. */
async function fetchEgressBytes(env: Env, now: number): Promise<number> {
  const isId = (value: string) => /^[0-9a-f]{32}$/.test(value)
  if (!isId(env.ACCOUNT_ID) || !isId(env.TURN_KEY_ID)) throw new Error('account or key ID is not configured')
  const today = new Date(now).toISOString().slice(0, 10)
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.ACCOUNT_ID}"}) {
        callsTurnUsageAdaptiveGroups(limit: 1, filter: {date_geq: "${today.slice(0, 8)}01", date_leq: "${today}", keyId: "${env.TURN_KEY_ID}"}) {
          sum { egressBytes }
        }
      }
    }
  }`
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query})
  })
  // The body of a refusal says why (a rejected token, a bad query); it does not repeat the token.
  if (!response.ok) throw new Error(`analytics answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const result = (await response.json()) as {
    errors?: {message?: string}[] | null
    data?: {viewer?: {accounts?: {callsTurnUsageAdaptiveGroups?: {sum?: {egressBytes?: unknown}}[]}[]}} | null
  }
  if (result.errors?.length) throw new Error(`analytics error: ${result.errors[0].message ?? 'unknown'}`)
  const accounts = result.data?.viewer?.accounts
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error('analytics returned no account')
  // No rows at all means nothing was relayed this month.
  const bytes = accounts[0].callsTurnUsageAdaptiveGroups?.[0]?.sum?.egressBytes ?? 0
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('analytics returned a bad total')
  return bytes
}

/** Reads usage and stores it. On failure the previous reading stays, and ages until it no longer counts. */
export async function recordUsage(env: Env, now: number): Promise<void> {
  if (!env.ANALYTICS_API_TOKEN) return
  try {
    const limitBytes = Number(env.TURN_MONTHLY_LIMIT_GB) * GIGABYTE
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) throw new Error('monthly limit is not configured')
    const egressBytes = await fetchEgressBytes(env, now)
    const paused = egressBytes >= limitBytes
    const reading: UsageReading = {month: new Date(now).toISOString().slice(0, 7), egressBytes, limitBytes, checkedAt: now, paused}
    await env.USAGE.put(USAGE_KEY, JSON.stringify(reading))
    if (paused) console.error(`TURN paused: ${egressBytes} bytes relayed this month, limit ${limitBytes}`)
  } catch (error) {
    console.error('TURN usage check failed:', error instanceof Error ? error.message : error)
  }
}

/** Why credentials must not be issued right now, or null if they may be. */
async function capReason(env: Env, now: number): Promise<string | null> {
  if (!env.ANALYTICS_API_TOKEN) return null
  let reading: Partial<UsageReading> | null = null
  try {
    reading = JSON.parse((await env.USAGE.get(USAGE_KEY)) ?? 'null') as Partial<UsageReading> | null
  } catch {
    // Unreadable is treated like missing.
  }
  // Before the first successful reading the cap is not armed, so a mistyped token cannot switch the relay off.
  if (typeof reading?.checkedAt !== 'number') return null
  if (now - reading.checkedAt > MAX_READING_AGE_MS) return 'turn-usage-unknown'
  return reading.paused === false ? null : 'turn-paused'
}

function challengePage(url: URL, env: Env): Response {
  const parentOrigin = url.searchParams.get('origin')
  if (!parentOrigin || !allowedOrigins(env).includes(parentOrigin)) return new Response('Forbidden', {status: 403})

  const nonce = crypto.randomUUID()
  // `<` is escaped so the embedded values cannot close the script element.
  const config = JSON.stringify({parentOrigin, siteKey: env.TURNSTILE_SITE_KEY, type: MESSAGE_TYPE}).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<meta charset="utf-8">
<title>snrdlr connection check</title>
<div id="widget"></div>
<script nonce="${nonce}">
  const config = ${config}
  const reply = message => parent.postMessage({type: config.type, ...message}, config.parentOrigin)
  window.onTurnstileLoad = () => {
    turnstile.render('#widget', {
      sitekey: config.siteKey,
      callback: async token => {
        try {
          const response = await fetch('/credentials', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({token})
          })
          reply(await response.json())
        } catch {
          reply({error: 'network'})
        }
      },
      'error-callback': () => reply({error: 'challenge'})
    })
  }
</script>
<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad" async defer></script>
`
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
        'frame-src https://challenges.cloudflare.com',
        "connect-src 'self'",
        `frame-ancestors ${allowedOrigins(env).join(' ')}`
      ].join('; ')
    }
  })
}

async function credentials(request: Request, url: URL, env: Env): Promise<Response> {
  // Only the challenge page calls this, and it is same-origin.
  if (request.headers.get('Origin') !== url.origin) return fail(403, 'forbidden')

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const {success: withinLimit} = await env.CREDENTIAL_LIMITER.limit({key: ip})
  if (!withinLimit) return fail(429, 'rate-limited')

  const capped = await capReason(env, Date.now())
  if (capped) return fail(503, capped)

  const body = (await request.json().catch(() => null)) as {token?: unknown} | null
  const token = body?.token
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return fail(400, 'bad-request')

  const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip})
  })
  const verdict = (await verification.json().catch(() => null)) as {success?: boolean} | null
  if (verdict?.success !== true) return fail(403, 'challenge')

  const upstream = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({ttl: CREDENTIAL_TTL_SECONDS})
    }
  )
  // Status only: the upstream body could echo details of the key.
  if (!upstream.ok) return fail(502, `upstream-${upstream.status}`)

  const {iceServers} = (await upstream.json()) as {iceServers: IceServer[]}
  const filtered = iceServers
    .map(server => ({...server, urls: [server.urls].flat().filter(usableInBrowsers)}))
    .filter(server => server.urls.length > 0)

  return Response.json({iceServers: filtered, ttl: CREDENTIAL_TTL_SECONDS}, {headers: {'Cache-Control': 'no-store'}})
}
