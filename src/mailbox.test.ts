import {schnorr} from '@noble/curves/secp256k1.js'
import {describe, expect, it, vi} from 'vitest'
import {memoryStore, Relay, STORED_KIND as RELAY_KIND} from '../worker-relay/src/relay'
import {fromHex} from './bytes'
import {relayMailboxes, STORED_KIND, unwrapEnvelope, wrapEnvelope} from './mailbox'

const TOPIC = 'ab'.repeat(32)

/** Our real relay's rules, reached through stand-in sockets, so both ends are the genuine article. */
function makeRelay() {
  const relay = new Relay(Date.now, memoryStore())
  const sockets: {close: () => void}[] = []
  let serial = 0
  let up = true
  const makeSocket = () => {
    const id = `socket-${serial++}`
    const socket = {
      readyState: 0,
      onopen: null as null | (() => void),
      onmessage: null as null | ((event: {data: string}) => void),
      onclose: null as null | (() => void),
      onerror: null as null | (() => void),
      send: (text: string) => void relay.receive(id, text),
      close() {
        if (socket.readyState === 3) return
        socket.readyState = 3
        relay.remove(id)
        queueMicrotask(() => socket.onclose?.())
      }
    }
    sockets.push(socket)
    queueMicrotask(() => {
      if (!up) return socket.close()
      relay.add({send: text => queueMicrotask(() => socket.readyState === 1 && socket.onmessage?.({data: text})), save: () => {}}, {id, from: 'test', subs: {}})
      socket.readyState = 1
      socket.onopen?.()
    })
    return socket as unknown as WebSocket
  }
  // A connection that still looks open but no longer reaches the relay.
  const silence = (socket: {send: (text: string) => void}) => (socket.send = () => {})
  return {makeSocket, sockets, relay, setUp: (next: boolean) => (up = next), silence}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('mailbox', () => {
  it('uses the kind of event our relay keeps', () => {
    expect(STORED_KIND).toBe(RELAY_KIND)
  })

  it('wraps an envelope as a validly signed event under the chat topic, each with a key of its own', () => {
    const envelope = new Uint8Array([1, 2, 3, 250])
    const [first, second] = [wrapEnvelope(TOPIC, envelope, 1_790_000_000_500), wrapEnvelope(TOPIC, envelope, 1_790_000_000_500)]
    expect(first).toMatchObject({kind: STORED_KIND, created_at: 1_790_000_000, tags: [['x', TOPIC], ['expiration', String(1_790_000_000 + 30 * 86400)]]})
    expect(schnorr.verify(fromHex(first.sig), fromHex(first.id), fromHex(first.pubkey))).toBe(true)
    expect(first.pubkey).not.toBe(second.pubkey)
    expect(unwrapEnvelope(first)).toEqual(envelope)
    expect(unwrapEnvelope({...first, kind: 1})).toBeNull()
  })

  it('leaves messages with the relay and hands them to whoever opens the chat later, or has it open now', async () => {
    const {makeSocket} = makeRelay()
    const [anne, bob, cindy] = [relayMailboxes('wss://relay', makeSocket), relayMailboxes('wss://relay', makeSocket), relayMailboxes('wss://relay', makeSocket)]
    const got = {bob: [] as number[], cindy: [] as number[], caughtUp: 0}
    const bobBox = bob(TOPIC, undefined, {onEnvelope: envelope => got.bob.push(envelope[0])})
    const anneBox = anne(TOPIC, undefined, {onEnvelope: () => {}})
    expect(await anneBox.post(new Uint8Array([1]), Date.now())).toBe(true)
    expect(await anneBox.post(new Uint8Array([2]), Date.now())).toBe(true)
    await settle()
    expect(got.bob).toEqual([1, 2])

    // Cindy opens the chat afterwards, and another chat's mailbox on the same connection gets nothing of this.
    cindy('cd'.repeat(32), undefined, {onEnvelope: envelope => got.cindy.push(-envelope[0])})
    cindy(TOPIC, undefined, {onEnvelope: envelope => got.cindy.push(envelope[0]), onCaughtUp: () => got.caughtUp++})
    await settle()
    expect(got.cindy).toEqual([1, 2])
    expect(got.caughtUp).toBe(1)
    bobBox.close()
    anneBox.close()
  })

  it('says so when a message could not be left, and carries on when the relay comes back', async () => {
    vi.useFakeTimers()
    try {
      const {makeSocket, setUp, sockets} = makeRelay()
      const open = relayMailboxes('wss://relay', makeSocket)
      const got: number[] = []
      setUp(false)
      const box = open(TOPIC, undefined, {onEnvelope: envelope => got.push(envelope[0])})
      const posted = box.post(new Uint8Array([7]), Date.now())
      await vi.advanceTimersByTimeAsync(11_000)
      expect(await posted).toBe(false)

      // The relay returns; the connection is retried by itself, and the next post is kept.
      setUp(true)
      await vi.advanceTimersByTimeAsync(61_000)
      const again = box.post(new Uint8Array([7]), Date.now())
      await vi.advanceTimersByTimeAsync(100)
      expect(await again).toBe(true)
      expect(sockets.length).toBeGreaterThan(1)
      box.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts over when a connection that looks open stops answering, and leaves the next message', async () => {
    vi.useFakeTimers()
    try {
      const {makeSocket, sockets, silence} = makeRelay()
      const open = relayMailboxes('wss://relay', makeSocket)
      const box = open(TOPIC, undefined, {onEnvelope: () => {}})
      expect(await box.post(new Uint8Array([1]), Date.now())).toBe(true)
      silence(sockets[0] as unknown as {send: (text: string) => void})
      const lost = box.post(new Uint8Array([2]), Date.now())
      await vi.advanceTimersByTimeAsync(11_000)
      expect(await lost).toBe(false)
      // The dead connection was closed and a new one made, which works.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sockets.length).toBe(2)
      const kept = box.post(new Uint8Array([2]), Date.now())
      await vi.advanceTimersByTimeAsync(100)
      expect(await kept).toBe(true)
      box.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('back after a long absence, starts over at once rather than waiting on a connection that may be dead', async () => {
    vi.useFakeTimers()
    try {
      const {makeSocket, sockets, silence} = makeRelay()
      const open = relayMailboxes('wss://relay', makeSocket)
      const got: number[] = []
      const box = open(TOPIC, undefined, {onEnvelope: envelope => got.push(envelope[0])})
      await vi.advanceTimersByTimeAsync(10)
      silence(sockets[0] as unknown as {send: (text: string) => void})
      // A short look away only checks the connection, which takes no new one.
      open.wake(5_000)
      await vi.advanceTimersByTimeAsync(10)
      expect(sockets.length).toBe(1)
      // A long one starts over straight away, and what someone left meanwhile arrives within moments.
      const other = relayMailboxes('wss://relay', makeSocket)(TOPIC, undefined, {onEnvelope: () => {}})
      expect(await other.post(new Uint8Array([7]), Date.now())).toBe(true)
      open.wake(60_000)
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets.length).toBe(3)
      expect(got).toContain(7)
      box.close()
      other.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
