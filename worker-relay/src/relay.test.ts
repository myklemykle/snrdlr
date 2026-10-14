import {schnorr} from '@noble/curves/secp256k1.js'
import {describe, expect, it} from 'vitest'
// The probe signs events the way the app's connection library does.
// @ts-expect-error The probe is plain JavaScript, with no type declarations.
import {makeEvent} from '../../scripts/probe-relays.mjs'
import {sha256} from '@noble/hashes/sha2.js'
import {LIMITS, memoryStore, Relay, STORED_KIND, type ConnectionState, type PushBook, type PushTarget, type PushTopic} from './relay'

const secretKey = schnorr.utils.randomSecretKey()
const TOPIC = '1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o'
const OTHER_TOPIC = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
let serial = 0

const event = (overrides: {kind?: number; topic?: string; content?: string; createdAt?: number} = {}) =>
  makeEvent(secretKey, {kind: 21000, topic: TOPIC, content: `hello ${serial++}`, createdAt: 1_790_000_000, ...overrides})

/** A connected client, recording what the relay sends it and what it asks to be remembered. */
function join(relay: Relay, from = 'address-a', id = `connection-${serial++}`) {
  const client = {
    id,
    got: [] as unknown[][],
    saved: {id, from, subs: {}} as ConnectionState,
    say: (...parts: unknown[]) => relay.receive(id, JSON.stringify(parts)),
    /** Events delivered on a subscription. */
    events: (subId: string) => client.got.filter(message => message[0] === 'EVENT' && message[1] === subId).map(message => message[2])
  }
  relay.add({send: text => client.got.push(JSON.parse(text)), save: state => (client.saved = state)}, client.saved)
  return client
}

describe('Relay', () => {
  it('passes an event to everyone subscribed to its topic, and to nobody else', async () => {
    const relay = new Relay()
    const [anne, bob, carol] = [join(relay), join(relay), join(relay)]
    await anne.say('REQ', 'a', {kinds: [21000], since: 1, '#x': [TOPIC]})
    await bob.say('REQ', 'b', {kinds: [21000], '#x': [TOPIC]})
    await carol.say('REQ', 'c', {'#x': [OTHER_TOPIC]})
    expect(anne.got).toEqual([['EOSE', 'a']])

    const sent = event()
    await bob.say('EVENT', sent)
    expect(bob.got).toContainEqual(['OK', sent.id, true, ''])
    expect(anne.events('a')).toEqual([sent])
    expect(bob.events('b')).toEqual([sent])
    expect(carol.events('c')).toEqual([])
  })

  it('ignores "since", so a device whose clock is wrong can still be found', async () => {
    const relay = new Relay()
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {since: 1_999_999_999, '#x': [TOPIC]})
    await bob.say('EVENT', event())
    expect(anne.events('a')).toHaveLength(1)
  })

  it('refuses anything that would have to be stored', async () => {
    const relay = new Relay()
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {'#x': [TOPIC]})
    for (const kind of [1, 0, 4, 1059, 19999, 30000]) {
      const note = event({kind})
      await bob.say('EVENT', note)
      expect(bob.got.at(-1)).toEqual(['OK', note.id, false, expect.stringMatching(/^blocked: /)])
    }
    expect(anne.events('a')).toEqual([])
  })

  it('keeps a sealed message for someone who connects later, and passes it at once to someone connected now', async () => {
    let clock = 1_790_000_000_000
    const relay = new Relay(() => clock, memoryStore())
    const [anne, bob] = [join(relay), join(relay)]
    await bob.say('REQ', 'live', {'#x': [TOPIC], kinds: [STORED_KIND]})
    expect(bob.got).toEqual([['EOSE', 'live']])
    const [first, second] = [event({kind: STORED_KIND, createdAt: 1_790_000_000}), event({kind: STORED_KIND, createdAt: 1_790_000_005})]
    await anne.say('EVENT', first)
    await anne.say('EVENT', second)
    expect(anne.got).toEqual([['OK', first.id, true, ''], ['OK', second.id, true, '']])
    expect(bob.events('live')).toEqual([first, second])

    // Cindy was not there. She gets both, oldest first, then the end-of-stored marker; and only for her own topics.
    const cindy = join(relay)
    await cindy.say('REQ', 'mine', {'#x': [TOPIC], kinds: [STORED_KIND]})
    expect(cindy.got).toEqual([['EVENT', 'mine', first], ['EVENT', 'mine', second], ['EOSE', 'mine']])
    await cindy.say('REQ', 'other', {'#x': [OTHER_TOPIC], kinds: [STORED_KIND]})
    expect(cindy.events('other')).toEqual([])
    // "since" narrows it; a request that does not ask for this kind gets nothing stored.
    await cindy.say('REQ', 'recent', {'#x': [TOPIC], kinds: [STORED_KIND], since: 1_790_000_003})
    expect(cindy.events('recent')).toEqual([second])
    await cindy.say('REQ', 'finding', {'#x': [TOPIC], kinds: [21000]})
    expect(cindy.events('finding')).toEqual([])

    // Sent twice, it is kept once and not passed on again.
    await anne.say('EVENT', first)
    expect(anne.got.at(-1)).toEqual(['OK', first.id, true, expect.stringMatching(/^duplicate: /)])
    expect(bob.events('live')).toEqual([first, second])

    // After thirty days it is gone.
    clock += (LIMITS.keepSeconds + 1) * 1000
    const dave = join(relay)
    await dave.say('REQ', 'late', {'#x': [TOPIC], kinds: [STORED_KIND]})
    expect(dave.got).toEqual([['EOSE', 'late']])
  })

  it('keeps a limited amount per chat, dropping the oldest, and honours a shorter life if one is asked for', async () => {
    let clock = 1_790_000_000_000
    const store = memoryStore()
    const relay = new Relay(() => clock, store)
    const anne = join(relay)
    const sent = []
    for (let count = 0; count < 12; count++) {
      const note = event({kind: STORED_KIND, createdAt: 1_790_000_000 + count})
      sent.push(note)
      relay['allowances'].clear()
      await anne.say('EVENT', note)
      store.trim(TOPIC, 10, Infinity)
    }
    const bob = join(relay)
    await bob.say('REQ', 'all', {'#x': [TOPIC], kinds: [STORED_KIND]})
    expect(bob.events('all')).toEqual(sent.slice(2))
    await bob.say('REQ', 'few', {'#x': [TOPIC], kinds: [STORED_KIND], limit: 3})
    expect(bob.events('few')).toEqual(sent.slice(-3))

    const withExpiry = makeEvent(secretKey, {kind: STORED_KIND, topic: OTHER_TOPIC, content: 'brief', createdAt: 1_790_000_000, expiration: 1_790_000_060})
    await anne.say('EVENT', withExpiry)
    expect(anne.got.at(-1)).toEqual(['OK', withExpiry.id, true, ''])
    clock += 61_000
    await bob.say('REQ', 'gone', {'#x': [OTHER_TOPIC], kinds: [STORED_KIND]})
    expect(bob.events('gone')).toEqual([])
  })

  it('without a store, refuses sealed messages like anything else that would have to be kept', async () => {
    const relay = new Relay()
    const anne = join(relay)
    const note = event({kind: STORED_KIND})
    await anne.say('EVENT', note)
    expect(anne.got.at(-1)).toEqual(['OK', note.id, false, expect.stringMatching(/^blocked: /)])
  })

  it('refuses a subscription that does not name its topics, so nobody can listen to everything', async () => {
    const relay = new Relay()
    const [spy, bob] = [join(relay), join(relay)]
    await spy.say('REQ', 'all', {kinds: [21000]})
    await spy.say('REQ', 'empty', {})
    await spy.say('REQ', 'mine', {authors: ['a'.repeat(64)], '#x': [TOPIC]})
    expect(spy.got.map(message => message[0])).toEqual(['CLOSED', 'CLOSED', 'CLOSED'])
    await bob.say('EVENT', event())
    expect(spy.got).toHaveLength(3)
  })

  it('refuses an event whose id does not match its contents, or that is malformed', async () => {
    const relay = new Relay()
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {'#x': [TOPIC]})
    const forged = {...event(), content: 'changed afterwards'}
    await bob.say('EVENT', forged)
    expect(bob.got.at(-1)).toEqual(['OK', forged.id, false, expect.stringMatching(/^invalid: /)])
    await bob.say('EVENT', {...event(), tags: 'nope'})
    await bob.say('EVENT', {...event(), tags: []})
    await relay.receive(bob.id, 'not json')
    await relay.receive(bob.id, new ArrayBuffer(4))
    await bob.say('AUTH', 'x')
    expect(anne.events('a')).toEqual([])
  })

  it('stops delivering after CLOSE, and replaces a subscription that reuses an id', async () => {
    const relay = new Relay()
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {'#x': [TOPIC]})
    await anne.say('REQ', 'a', {'#x': [OTHER_TOPIC]})
    await bob.say('EVENT', event())
    expect(anne.events('a')).toEqual([])
    await bob.say('EVENT', event({topic: OTHER_TOPIC}))
    expect(anne.events('a')).toHaveLength(1)

    await anne.say('CLOSE', 'a')
    await bob.say('EVENT', event({topic: OTHER_TOPIC}))
    expect(anne.events('a')).toHaveLength(1)
    expect(anne.saved.subs).toEqual({})
  })

  it('delivers once per subscription even when several of its topics match', async () => {
    const relay = new Relay()
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {'#x': [TOPIC, OTHER_TOPIC]}, {'#x': [TOPIC]})
    await bob.say('EVENT', event())
    expect(anne.events('a')).toHaveLength(1)
  })

  it('carries on after going idle, from what each connection remembered', async () => {
    const before = new Relay()
    const anne = join(before)
    await anne.say('REQ', 'a', {'#x': [TOPIC]})

    // Cloudflare discards the relay's memory but keeps the sockets and what was saved on them.
    const after = new Relay()
    const got: unknown[][] = []
    after.add({send: text => got.push(JSON.parse(text)), save() {}}, anne.saved)
    const bob = join(after)
    const sent = event()
    await bob.say('EVENT', sent)
    expect(got).toEqual([['EVENT', 'a', sent]])
  })

  it('forgets a connection that closes', async () => {
    const relay = new Relay()
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {'#x': [TOPIC]})
    relay.remove(anne.id)
    expect(relay.size).toBe(1)
    await bob.say('EVENT', event())
    expect(anne.got).toEqual([['EOSE', 'a']])
  })

  it('slows down a connection that sends too fast, and lets it resume', async () => {
    let now = 0
    const relay = new Relay(() => now)
    const [anne, bob] = [join(relay), join(relay)]
    await anne.say('REQ', 'a', {'#x': [TOPIC]})
    for (let i = 0; i < LIMITS.burst; i++) await bob.say('EVENT', event())
    expect(anne.events('a')).toHaveLength(LIMITS.burst)

    const refused = event()
    await bob.say('EVENT', refused)
    expect(bob.got.at(-1)).toEqual(['OK', refused.id, false, 'rate-limited: slow down'])
    expect(anne.events('a')).toHaveLength(LIMITS.burst)

    now += 2000
    await bob.say('EVENT', event())
    expect(anne.events('a')).toHaveLength(LIMITS.burst + 1)
  })

  it('limits subscriptions, topics and connections', async () => {
    const relay = new Relay()
    const anne = join(relay)
    for (let i = 0; i < LIMITS.subscriptionsPerConnection; i++) await anne.say('REQ', `s${i}`, {'#x': [`topic-${i}`]})
    await anne.say('REQ', 'one-too-many', {'#x': [TOPIC]})
    expect(anne.got.at(-1)).toEqual(['CLOSED', 'one-too-many', expect.stringMatching(/too many subscriptions/)])

    const greedy = join(relay)
    const lots = (prefix: string) => Array.from({length: 600}, (_, i) => `${prefix}${String(i).padStart(4, "0")}-rest-of-a-long-topic`)
    await greedy.say('REQ', 'first', {'#x': lots('a')})
    await greedy.say('REQ', 'second', {'#x': lots('b')})
    expect(greedy.got.at(-1)).toEqual(['CLOSED', 'second', expect.stringMatching(/too many topics/)])
    expect(JSON.stringify(greedy.saved).length).toBeLessThanOrEqual(LIMITS.stateBytes)

    expect(relay.refusal('address-b')).toBeNull()
    for (let i = 0; i < LIMITS.connectionsPerAddress; i++) join(relay, 'address-b')
    expect(relay.refusal('address-b')).toMatch(/Too many connections/)
    expect(relay.refusal('address-c')).toBeNull()
  })

  describe('push notifications', () => {
    const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    const CHAT = 'ab'.repeat(32)
    const ANNE = 'a1'.repeat(16)
    const BOB = 'b2'.repeat(16)
    const device = (name: string): PushTarget => ({endpoint: `https://web.push.apple.com/${name}`, p256dh: 'B'.repeat(87), auth: 'A'.repeat(22)})
    /** A sealed message, marked as worth a notification when `notify` is given. */
    const sealed = (notify?: string) => {
      const pubkey = hex(schnorr.getPublicKey(secretKey))
      const tags = [['x', CHAT], ...(notify ? [['n', notify]] : [])]
      const content = `sealed ${serial++}`
      const id = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, 1_790_000_000, STORED_KIND, tags, content])))
      return {kind: STORED_KIND, tags, created_at: 1_790_000_000, content, pubkey, id: hex(id), sig: hex(schnorr.sign(id, secretKey))}
    }
    const book = () => {
      const registered = new Map<string, PushTopic[]>()
      const stored: [string, string][] = []
      const pushes: PushBook = {
        register: (target, topics) => void registered.set(target.endpoint, topics),
        forget: endpoint => void registered.delete(endpoint),
        stored: async (topic, me) => void stored.push([topic, me])
      }
      return {pushes, registered, stored}
    }

    it('registers a device for its chats, replacing what it asked for before', async () => {
      const {pushes, registered} = book()
      const anne = join(new Relay(() => 1_790_000_000_000, memoryStore(), pushes))
      await anne.say('PUSH', device('phone'), [[CHAT, ANNE]])
      await anne.say('PUSH', device('phone'), [[CHAT, ANNE], ['cd'.repeat(32), ANNE]])
      expect(anne.got).toEqual([['PUSH', true, ''], ['PUSH', true, '']])
      expect(registered.get(device('phone').endpoint)).toHaveLength(2)
      await anne.say('UNPUSH', device('phone').endpoint)
      expect(registered.size).toBe(0)
    })

    it('pushes only to real push services, and checks what it is given', async () => {
      const {pushes, registered} = book()
      const anne = join(new Relay(() => 1_790_000_000_000, memoryStore(), pushes))
      await anne.say('PUSH', {...device('x'), endpoint: 'https://example.com/hook'}, [[CHAT, ANNE]])
      await anne.say('PUSH', {...device('x'), endpoint: 'http://web.push.apple.com/x'}, [[CHAT, ANNE]])
      await anne.say('PUSH', {...device('x'), auth: 'short'}, [[CHAT, ANNE]])
      await anne.say('PUSH', device('x'), [['not a topic', ANNE]])
      await anne.say('PUSH', device('x'), Array.from({length: 501}, () => [CHAT, ANNE]))
      expect(anne.got.map(message => message[1])).toEqual([false, false, false, false, false])
      expect(anne.got[0][2]).toBe('blocked: not a push service')
      expect(registered.size).toBe(0)
      // Google's and Mozilla's are fine too.
      await anne.say('PUSH', {...device('x'), endpoint: 'https://fcm.googleapis.com/fcm/send/abc'}, [[CHAT, ANNE]])
      await anne.say('PUSH', {...device('x'), endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc'}, [[CHAT, ANNE]])
      expect(registered.size).toBe(2)
    })

    it('says a marked message was stored, with its author tag, and stays quiet about the rest', async () => {
      const {pushes, stored} = book()
      const bob = join(new Relay(() => 1_790_000_000_000, memoryStore(), pushes))
      await bob.say('EVENT', sealed(BOB))
      await bob.say('EVENT', sealed())
      await bob.say('EVENT', sealed('not hex'))
      // A short-lived event is never stored, so it wakes nobody whatever it carries.
      await bob.say('EVENT', {...event(), tags: [['x', CHAT], ['n', BOB]]})
      expect(stored).toEqual([[CHAT, BOB]])
      // The same message again is a duplicate, and does not push twice.
      const again = sealed(BOB)
      await bob.say('EVENT', again)
      await bob.say('EVENT', again)
      expect(stored).toHaveLength(2)
    })

    it('without a push book, PUSH is not understood', async () => {
      const anne = join(new Relay(() => 1_790_000_000_000, memoryStore()))
      await anne.say('PUSH', device('phone'), [[CHAT, ANNE]])
      expect(anne.got[0][0]).toBe('NOTICE')
    })
  })
})
