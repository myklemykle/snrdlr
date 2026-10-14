import {schnorr} from '@noble/curves/secp256k1.js'
import {describe, expect, it} from 'vitest'
// The probe signs events the way the app's connection library does.
// @ts-expect-error The probe is plain JavaScript, with no type declarations.
import {makeEvent} from '../../scripts/probe-relays.mjs'
import {LIMITS, memoryStore, Relay, STORED_KIND, type ConnectionState} from './relay'

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
})
