import {afterEach, describe, expect, it, vi} from 'vitest'
import worker, {type Env} from './index'

const env: Env = {
  TURN_KEY_ID: 'key-id',
  TURN_KEY_API_TOKEN: 'key-token',
  ALLOWED_ORIGINS: 'https://app.example, http://localhost:5173'
}

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

const request = (origin?: string, method = 'GET') =>
  new Request('https://turn.example/', {method, headers: origin ? {Origin: origin} : {}})

afterEach(() => vi.unstubAllGlobals())

describe('TURN credential worker', () => {
  it('returns credentials to an allowed origin, without port 53 URLs', async () => {
    const upstream = vi.fn(async () => Response.json(upstreamBody, {status: 201}))
    vi.stubGlobal('fetch', upstream)

    const response = await worker.fetch(request('https://app.example'), env)

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example')
    expect(await response.json()).toEqual({
      iceServers: [
        {urls: ['stun:stun.cloudflare.com:3478']},
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'user',
          credential: 'pass'
        }
      ]
    })
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/turn/keys/key-id/credentials/generate-ice-servers')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer key-token')
  })

  it('refuses unknown or missing origins without calling Cloudflare', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    expect((await worker.fetch(request('https://evil.example'), env)).status).toBe(403)
    expect((await worker.fetch(request(), env)).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('reports an upstream failure without leaking its body', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad token key-token', {status: 401}))

    const response = await worker.fetch(request('http://localhost:5173'), env)

    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('key-token')
  })

  it('rejects methods other than GET', async () => {
    expect((await worker.fetch(request('https://app.example', 'POST'), env)).status).toBe(405)
  })
})
