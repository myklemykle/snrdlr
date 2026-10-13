import {createServer} from 'node:http'
import {schnorr} from '@noble/curves/secp256k1.js'
import {hexToBytes} from '@noble/hashes/utils.js'
import {afterEach, describe, expect, it} from 'vitest'
import {WebSocketServer} from 'ws'
import {makeEvent, MIN_GAP_MS, nextProbeAt, probeRelay, summarize} from './probe-relays.mjs'

const servers = []
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections?.(), server.close()
})

/** A relay on a free local port. `behaviour` decides what it does with a posted event. */
const startRelay = async ({info, onEvent = 'forward'} = {}) => {
  const counts = {connections: 0, events: 0, requests: 0, infoRequests: 0}
  const http = createServer((_request, response) => {
    counts.infoRequests++
    if (!info) return response.writeHead(404).end()
    response.writeHead(200, {'Content-Type': 'application/nostr+json'}).end(JSON.stringify(info))
  })
  const relay = new WebSocketServer({server: http})
  const subscriptions = new Map()
  relay.on('connection', socket => {
    counts.connections++
    socket.on('close', () => subscriptions.delete(socket))
    socket.on('message', raw => {
      const [type, ...rest] = JSON.parse(raw.toString())
      if (type === 'REQ') {
        counts.requests++
        subscriptions.set(socket, rest)
        socket.send(JSON.stringify(['EOSE', rest[0]]))
      } else if (type === 'EVENT') {
        counts.events++
        const [event] = rest
        if (onEvent === 'limit') return socket.send(JSON.stringify(['OK', event.id, false, 'rate-limited: slow down']))
        if (onEvent === 'auth') return socket.send(JSON.stringify(['OK', event.id, false, 'auth-required: log in first']))
        socket.send(JSON.stringify(['OK', event.id, true, '']))
        if (onEvent === 'swallow') return
        for (const [peer, [subId, filter]] of subscriptions) {
          if (filter.kinds.includes(event.kind) && filter['#x'].includes(event.tags[0][1])) peer.send(JSON.stringify(['EVENT', subId, event]))
        }
      }
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  servers.push(http)
  return {url: `ws://127.0.0.1:${http.address().port}`, counts}
}

describe('makeEvent', () => {
  it('signs an event any relay would accept', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const event = makeEvent(secretKey, {kind: 21234, topic: 'abc', content: 'hello', createdAt: 1_700_000_000})
    expect(event.tags).toEqual([['x', 'abc']])
    expect(event.id).toMatch(/^[0-9a-f]{64}$/)
    expect(schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))).toBe(true)
  })
})

describe('probeRelay', () => {
  it('times one event through a working relay and sends nothing more', async () => {
    const relay = await startRelay()
    const result = await probeRelay(relay.url)
    expect(result.outcome).toBe('ok')
    expect(result.deliveryMs).toBeGreaterThanOrEqual(0)
    expect(relay.counts).toEqual({connections: 2, events: 1, requests: 1, infoRequests: 1})
  })

  it('does not connect to a relay that says it needs a login or payment', async () => {
    const relay = await startRelay({info: {limitation: {auth_required: true, payment_required: true}}})
    const result = await probeRelay(relay.url)
    expect(result).toMatchObject({outcome: 'ineligible', note: 'needs a login, needs payment'})
    expect(relay.counts.connections).toBe(0)
  })

  it('recognises being asked to slow down', async () => {
    const relay = await startRelay({onEvent: 'limit'})
    expect((await probeRelay(relay.url)).outcome).toBe('limited')
  })

  it('reports a refusal', async () => {
    const relay = await startRelay({onEvent: 'auth'})
    const result = await probeRelay(relay.url)
    expect(result.outcome).toBe('rejected')
    expect(result.note).toContain('auth-required')
  })

  it('reports an event that was accepted but never delivered', async () => {
    const relay = await startRelay({onEvent: 'swallow'})
    expect((await probeRelay(relay.url)).outcome).toBe('not-delivered')
  }, 10_000)

  it('reports a relay that is not there', async () => {
    expect((await probeRelay('ws://127.0.0.1:9')).outcome).toBe('unreachable')
  })
})

describe('nextProbeAt', () => {
  const HOUR = 3600_000
  const at = '2026-10-13T00:00:00.000Z'
  const start = Date.parse(at)
  const runs = (...outcomes) => outcomes.map(outcome => ({at, outcome}))

  it('probes a new relay straight away', () => expect(nextProbeAt([])).toEqual({at: 0}))
  it('leaves a working relay alone for the minimum gap', () => expect(nextProbeAt(runs('ok'))).toEqual({at: start + MIN_GAP_MS}))
  it('waits a day after being asked to slow down', () => expect(nextProbeAt(runs('ok', 'limited'))).toEqual({at: start + 24 * HOUR}))
  it('gives up after being asked twice', () => expect(nextProbeAt(runs('limited', 'limited')).never).toBeTruthy())
  it('rechecks a closed relay weekly', () => expect(nextProbeAt(runs('ineligible'))).toEqual({at: start + 7 * 24 * HOUR}))
  it('slows to daily after three failures to connect', () =>
    expect(nextProbeAt(runs('unreachable', 'unreachable', 'unreachable'))).toEqual({at: start + 24 * HOUR}))
  it('gives up after seven', () => expect(nextProbeAt(runs(...Array(7).fill('unreachable'))).never).toBeTruthy())
  it('counts only the latest run of failures', () =>
    expect(nextProbeAt(runs('unreachable', 'unreachable', 'ok', 'unreachable'))).toEqual({at: start + MIN_GAP_MS}))
})

describe('summarize', () => {
  it('ranks by delivery rate, then speed, per vantage point', () => {
    const entry = (url, outcome, deliveryMs) => ({at: '2026-10-13T00:00:00.000Z', from: 'home', url, outcome, deliveryMs})
    const rows = summarize([entry('a', 'ok', 300), entry('a', 'unreachable'), entry('b', 'ok', 200), entry('b', 'ok', 100), entry('c', 'ok', 50)])
    expect(rows.map(row => row.url)).toEqual(['c', 'b', 'a'])
    expect(rows[1]).toMatchObject({runs: 2, delivered: 2, medianMs: 100, worstMs: 200})
  })
})
