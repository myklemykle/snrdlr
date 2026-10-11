// Issues short-lived Cloudflare TURN credentials, so the long-term TURN key never reaches a browser.

export type Env = {
  TURN_KEY_ID: string
  TURN_KEY_API_TOKEN: string
  ALLOWED_ORIGINS: string
}

type IceServer = {urls: string | string[]; username?: string; credential?: string}

const CREDENTIAL_TTL_SECONDS = 4 * 60 * 60

// Browsers block port 53, so those URLs only add a timeout.
const usableInBrowsers = (url: string) => !/:53(\?|$)/.test(url)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const allowed = env.ALLOWED_ORIGINS.split(',').map(entry => entry.trim())
    // This keeps other websites from using the key; it does not stop non-browser clients.
    if (!origin || !allowed.includes(origin)) return new Response('Forbidden', {status: 403})

    const cors = {'Access-Control-Allow-Origin': origin, Vary: 'Origin'}
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: {...cors, 'Access-Control-Allow-Methods': 'GET'}})
    }
    if (request.method !== 'GET') return new Response('Method not allowed', {status: 405, headers: cors})

    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({ttl: CREDENTIAL_TTL_SECONDS})
      }
    )
    if (!upstream.ok) return new Response('TURN credentials unavailable', {status: 502, headers: cors})

    const {iceServers} = (await upstream.json()) as {iceServers: IceServer[]}
    const filtered = iceServers
      .map(server => ({...server, urls: [server.urls].flat().filter(usableInBrowsers)}))
      .filter(server => server.urls.length > 0)

    return Response.json({iceServers: filtered}, {headers: {...cors, 'Cache-Control': 'no-store'}})
  }
}
