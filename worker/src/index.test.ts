import {afterEach, describe, expect, it, vi} from 'vitest'
import worker, {type Env} from './index'

const WORKER = 'https://turn.example'

const makeEnv = (withinLimit = true): Env => ({
  TURN_KEY_ID: 'key-id',
  TURN_KEY_API_TOKEN: 'key-token',
  TURNSTILE_SITE_KEY: 'site-key',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  ALLOWED_ORIGINS: 'https://app.example, http://localhost:5173',
  CREDENTIAL_LIMITER: {limit: vi.fn(async () => ({success: withinLimit}))}
})

const upstreamBody = {
  iceServers: [
    {urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53']},
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp'
      ],
      username: 'user',
      credential: 'pass'
    }
  ]
}

/** Stubs both Cloudflare APIs the worker calls and records the requests. */
function stubCloudflare({challengePasses = true, turnStatus = 201} = {}) {
  const calls: {url: string; init: RequestInit}[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({url, init})
    if (url.includes('siteverify')) return Response.json({success: challengePasses})
    return turnStatus === 201
      ? Response.json(upstreamBody, {status: 201})
      : new Response('bad token key-token', {status: turnStatus})
  })
  return calls
}

const credentialRequest = (body: unknown, origin: string | null = WORKER) =>
  new Request(`${WORKER}/credentials`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...(origin ? {Origin: origin} : {})},
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })

const challengeRequest = (origin?: string) =>
  new Request(`${WORKER}/challenge${origin ? `?origin=${encodeURIComponent(origin)}` : ''}`)

afterEach(() => vi.unstubAllGlobals())

describe('POST /credentials', () => {
  it('returns credentials for a valid Turnstile token, without port 53 URLs', async () => {
    const calls = stubCloudflare()

    const response = await worker.fetch(credentialRequest({token: 'good-token'}), makeEnv())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ttl: 14400,
      iceServers: [
        {urls: ['stun:stun.cloudflare.com:3478']},
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'user',
          credential: 'pass'
        }
      ]
    })
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      secret: 'turnstile-secret',
      response: 'good-token',
      remoteip: '203.0.113.7'
    })
    expect(calls[1].url).toContain('/turn/keys/key-id/credentials/generate-ice-servers')
    expect(new Headers(calls[1].init.headers).get('Authorization')).toBe('Bearer key-token')
  })

  it('refuses a failed challenge without asking for TURN credentials', async () => {
    const calls = stubCloudflare({challengePasses: false})

    const response = await worker.fetch(credentialRequest({token: 'bad-token'}), makeEnv())

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: 'challenge'})
    expect(calls).toHaveLength(1)
  })

  it('rate-limits by client IP before doing any other work', async () => {
    const calls = stubCloudflare()
    const env = makeEnv(false)

    const response = await worker.fetch(credentialRequest({token: 'good-token'}), env)

    expect(response.status).toBe(429)
    expect(env.CREDENTIAL_LIMITER.limit).toHaveBeenCalledWith({key: '203.0.113.7'})
    expect(calls).toHaveLength(0)
  })

  it('refuses requests that do not come from its own challenge page', async () => {
    const calls = stubCloudflare()

    expect((await worker.fetch(credentialRequest({token: 't'}, 'https://app.example'), makeEnv())).status).toBe(403)
    expect((await worker.fetch(credentialRequest({token: 't'}, null), makeEnv())).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('rejects missing, oversized or malformed tokens', async () => {
    const calls = stubCloudflare()

    for (const body of [{}, {token: ''}, {token: 5}, {token: 'x'.repeat(3000)}, 'not json']) {
      expect((await worker.fetch(credentialRequest(body), makeEnv())).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('reports an upstream TURN failure by status, without leaking its body', async () => {
    stubCloudflare({turnStatus: 401})

    const response = await worker.fetch(credentialRequest({token: 'good-token'}), makeEnv())

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain('upstream-401')
    expect(body).not.toContain('key-token')
  })
})

describe('GET /challenge', () => {
  it('serves the Turnstile page to an allowed parent, framable only by allowed origins', async () => {
    const response = await worker.fetch(challengeRequest('https://app.example'), makeEnv())

    expect(response.status).toBe(200)
    const csp = response.headers.get('Content-Security-Policy')!
    expect(csp).toContain('frame-ancestors https://app.example http://localhost:5173')
    expect(csp).toContain("default-src 'none'")
    const html = await response.text()
    expect(html).toContain('"parentOrigin":"https://app.example"')
    expect(html).toContain('"siteKey":"site-key"')
    expect(html).not.toContain('turnstile-secret')
    expect(html).not.toContain('key-token')
  })

  it('refuses unknown or missing parent origins', async () => {
    expect((await worker.fetch(challengeRequest('https://evil.example'), makeEnv())).status).toBe(403)
    expect((await worker.fetch(challengeRequest('</script><script>alert(1)'), makeEnv())).status).toBe(403)
    expect((await worker.fetch(challengeRequest(), makeEnv())).status).toBe(403)
  })
})

describe('other routes', () => {
  it('no longer hands out credentials on a plain GET', async () => {
    const calls = stubCloudflare()

    const response = await worker.fetch(new Request(WORKER, {headers: {Origin: 'https://app.example'}}), makeEnv())

    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
