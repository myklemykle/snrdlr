import {afterEach, describe, expect, it, vi} from 'vitest'
import worker, {recordUsage, type Env, type UsageReading} from './index'

const WORKER = 'https://turn.example'

const makeEnv = (withinLimit = true): Env => ({
  TURN_KEY_ID: 'key-id',
  TURN_KEY_API_TOKEN: 'key-token',
  TURNSTILE_SITE_KEY: 'site-key',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  ALLOWED_ORIGINS: 'https://app.example, http://localhost:5173',
  CREDENTIAL_LIMITER: {limit: vi.fn(async () => ({success: withinLimit}))},
  USAGE: makeKv(),
  ACCOUNT_ID: 'a'.repeat(32),
  TURN_MONTHLY_LIMIT_GB: '800'
})

function makeKv() {
  const values = new Map<string, string>()
  return {get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => void values.set(key, value)}
}

/** An environment with the spending cap switched on. */
const cappedEnv = (): Env => ({...makeEnv(), TURN_KEY_ID: 'b'.repeat(32), ANALYTICS_API_TOKEN: 'analytics-token'})

const analyticsAnswer = (egressBytes: number | null) =>
  Response.json({
    data: {viewer: {accounts: [{callsTurnUsageAdaptiveGroups: egressBytes === null ? [] : [{sum: {egressBytes}}]}]}},
    errors: null
  })

const reading = async (env: Env) => JSON.parse((await env.USAGE.get('turn-usage'))!) as UsageReading
const NOON = Date.UTC(2026, 9, 12, 12)
const MINUTE = 60_000

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

describe('spending cap', () => {
  afterEach(() => vi.useRealTimers())

  /** Stubs analytics plus the two APIs behind /credentials, and records the analytics requests. */
  function stubAll(analytics: () => Response) {
    const queries: {url: string; init: RequestInit}[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.includes('/graphql')) {
        queries.push({url, init})
        return analytics()
      }
      if (url.includes('siteverify')) return Response.json({success: true})
      return Response.json(upstreamBody, {status: 201})
    })
    return queries
  }

  const ask = (env: Env, at: number) => {
    vi.useFakeTimers({now: at, toFake: ['Date']})
    return worker.fetch(credentialRequest({token: 'good-token'}), env)
  }

  it('is off, and asks analytics nothing, until its token is set', async () => {
    const queries = stubAll(() => analyticsAnswer(0))
    const env = makeEnv()

    await recordUsage(env, NOON)

    expect(queries).toHaveLength(0)
    expect((await ask(env, NOON)).status).toBe(200)
  })

  it('records this month\'s usage for this key, and keeps issuing credentials under the limit', async () => {
    const queries = stubAll(() => analyticsAnswer(5e9))
    const env = cappedEnv()

    await worker.scheduled(null, env)
    await recordUsage(env, NOON)

    expect(await reading(env)).toEqual({month: '2026-10', egressBytes: 5e9, limitBytes: 800e9, checkedAt: NOON, paused: false})
    const query = JSON.parse(queries.at(-1)!.init.body as string).query as string
    expect(query).toContain('date_geq: "2026-10-01", date_leq: "2026-10-12"')
    expect(query).toContain(`keyId: "${'b'.repeat(32)}"`)
    expect(query).toContain(`accountTag: "${'a'.repeat(32)}"`)
    expect(new Headers(queries.at(-1)!.init.headers).get('Authorization')).toBe('Bearer analytics-token')
    expect((await ask(env, NOON + MINUTE)).status).toBe(200)
  })

  it('counts a month with nothing relayed as zero', async () => {
    stubAll(() => analyticsAnswer(null))
    const env = cappedEnv()

    await recordUsage(env, NOON)

    expect((await reading(env)).egressBytes).toBe(0)
    expect((await ask(env, NOON)).status).toBe(200)
  })

  it('stops issuing credentials once usage reaches the limit, without spending a challenge check', async () => {
    const queries = stubAll(() => analyticsAnswer(800e9))
    const env = cappedEnv()
    await recordUsage(env, NOON)

    const calls = stubCloudflare()
    const response = await ask(env, NOON + MINUTE)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: 'turn-paused'})
    expect(calls).toHaveLength(0)
    expect(queries).toHaveLength(1)
  })

  it('starts again in a new month', async () => {
    let used = 900e9
    stubAll(() => analyticsAnswer(used))
    const env = cappedEnv()
    await recordUsage(env, Date.UTC(2026, 9, 31, 23))
    expect((await ask(env, Date.UTC(2026, 9, 31, 23, 5))).status).toBe(503)

    used = 0
    const november = Date.UTC(2026, 10, 1, 0, 10)
    await recordUsage(env, november)

    expect((await reading(env)).month).toBe('2026-11')
    expect((await ask(env, november + MINUTE)).status).toBe(200)
  })

  it('is not armed until its first reading, so a rejected token does not switch the relay off', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubAll(() => new Response('{"errors":[{"code":9106}]}', {status: 400}))
    const env = cappedEnv()

    await recordUsage(env, NOON)

    expect(await env.USAGE.get('turn-usage')).toBeNull()
    expect((await ask(env, NOON + MINUTE)).status).toBe(200)
    error.mockRestore()
  })

  it('refuses credentials once its reading is old', async () => {
    stubAll(() => analyticsAnswer(1e9))
    const env = cappedEnv()
    await recordUsage(env, NOON)

    expect((await ask(env, NOON + 5 * 60 * MINUTE)).status).toBe(200)
    const late = await ask(env, NOON + 7 * 60 * MINUTE)
    expect(late.status).toBe(503)
    expect(await late.json()).toEqual({error: 'turn-usage-unknown'})
  })

  it('keeps the last reading when analytics fails, answers with an error, or returns nonsense', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let answer = () => analyticsAnswer(2e9)
    stubAll(() => answer())
    const env = cappedEnv()
    await recordUsage(env, NOON)

    const failures = [
      () => new Response('no', {status: 500}),
      () => Response.json({data: null, errors: [{message: 'unknown field'}]}),
      () => Response.json({data: {viewer: {accounts: []}}}),
      () => analyticsAnswer(-5),
      () => Response.json({data: {viewer: {accounts: [{callsTurnUsageAdaptiveGroups: [{sum: {egressBytes: 'lots'}}]}]}}})
    ]
    for (const failure of failures) {
      answer = failure
      await recordUsage(env, NOON + 10 * MINUTE)
    }

    expect(await reading(env)).toMatchObject({egressBytes: 2e9, checkedAt: NOON})
    expect(error).toHaveBeenCalledTimes(failures.length)
    expect(error.mock.calls.flat().join(' ')).not.toContain('analytics-token')
    error.mockRestore()
  })
})
