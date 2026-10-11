// Issues short-lived Cloudflare TURN credentials, so the long-term TURN key never reaches a browser.
//
// The app embeds GET /challenge in a hidden iframe. That page runs Turnstile on this worker's
// origin (so Cloudflare's script never runs inside the app's origin, where the chat keys live),
// trades the token for credentials at POST /credentials, and posts them to the parent window.

export type Env = {
  TURN_KEY_ID: string
  TURN_KEY_API_TOKEN: string
  TURNSTILE_SITE_KEY: string
  TURNSTILE_SECRET_KEY: string
  ALLOWED_ORIGINS: string
  CREDENTIAL_LIMITER: {limit: (options: {key: string}) => Promise<{success: boolean}>}
}

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
  }
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
