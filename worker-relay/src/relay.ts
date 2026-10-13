// The relay's rules, kept apart from Cloudflare's plumbing so they can be tested on their own.
//
// It is a Nostr relay cut down to the one job the app needs: passing short-lived events between
// devices that are connected at the same moment, so they can find each other. Nothing is stored.
//
// - Only short-lived events (kinds 20000 to 29999) are accepted. Posts, profiles and private
//   messages are refused, so it is of no use as a general Nostr relay.
// - A subscription must name the topics it wants (an "#x" filter). Nobody can listen to everything,
//   so watching a room means already knowing its topic, which is derived from the chat's secret.
// - Signatures are not checked. Nothing depends on them: devices prove who they are to each other
//   after connecting, and connection setup is encrypted with the chat's own key.
// - "since" and "until" are ignored, so a device whose clock is wrong can still be found.

export const LIMITS = {
  /** Bytes in one incoming message. A connection offer is a few kilobytes. */
  messageBytes: 64 * 1024,
  subscriptionsPerConnection: 16,
  filtersPerSubscription: 4,
  topicsPerFilter: 1000,
  /** Bytes of subscription state kept per connection; Cloudflare allows 16,384. */
  stateBytes: 15_000,
  connections: 3000,
  connectionsPerAddress: 30,
  /** Messages a connection may send in a burst, and how fast the allowance refills. */
  burst: 300,
  perSecond: 5
}

const FIRST_KIND = 20000
const LAST_KIND = 29999
// Topics are compared by their first characters, to fit more of them in the per-connection state.
const TOPIC_KEY_LENGTH = 16
const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** What is remembered about one connection. Small, because it must survive the relay going idle. */
export type ConnectionState = {
  id: string
  /** A short hash of the client's address, for the per-address limit only. */
  from: string
  /** Subscription ID to the topic keys it wants. */
  subs: Record<string, string[]>
}

export type Connection = {
  send: (text: string) => void
  save: (state: ConnectionState) => void
}

type NostrEvent = {id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string}

const topicKey = (topic: string) => topic.slice(0, TOPIC_KEY_LENGTH)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseEvent(value: unknown): NostrEvent | null {
  if (!isRecord(value)) return null
  const {id, pubkey, created_at, kind, tags, content, sig} = value
  if (typeof id !== 'string' || !HEX_64.test(id)) return null
  if (typeof pubkey !== 'string' || !HEX_64.test(pubkey)) return null
  if (typeof sig !== 'string' || !HEX_128.test(sig)) return null
  if (!Number.isSafeInteger(created_at) || !Number.isSafeInteger(kind) || typeof content !== 'string') return null
  if (!Array.isArray(tags) || tags.length > 16) return null
  if (!tags.every(tag => Array.isArray(tag) && tag.length <= 8 && tag.every(item => typeof item === 'string'))) return null
  return value as NostrEvent
}

async function eventId(event: NostrEvent): Promise<string> {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The topic keys a subscription asks for, or why it is refused. */
function wantedTopics(filters: unknown[]): string[] | string {
  if (filters.length === 0 || filters.length > LIMITS.filtersPerSubscription) return 'unsupported: one to four filters'
  const keys = new Set<string>()
  for (const filter of filters) {
    if (!isRecord(filter)) return 'invalid: filter must be an object'
    if ('ids' in filter || 'authors' in filter) return 'unsupported: filter by topic only'
    const topics = filter['#x']
    if (!Array.isArray(topics) || topics.length === 0) return 'unsupported: filters must name topics with #x'
    if (topics.length > LIMITS.topicsPerFilter) return 'unsupported: too many topics'
    for (const topic of topics) {
      if (typeof topic !== 'string' || topic.length === 0 || topic.length > 128) return 'invalid: topic'
      keys.add(topicKey(topic))
    }
  }
  return [...keys]
}

export class Relay {
  private connections = new Map<string, {connection: Connection; state: ConnectionState}>()
  /** Topic key to the connections subscribed to it, and under which subscription IDs. */
  private index = new Map<string, Map<string, Set<string>>>()
  private allowances = new Map<string, {left: number; at: number}>()

  constructor(private now: () => number = Date.now) {}

  get size(): number {
    return this.connections.size
  }

  /** Why a new connection from this address cannot be taken, if it cannot. */
  refusal(from: string): string | null {
    if (this.connections.size >= LIMITS.connections) return 'The relay is full. Try again shortly.'
    let fromHere = 0
    for (const {state} of this.connections.values()) if (state.from === from) fromHere++
    return fromHere >= LIMITS.connectionsPerAddress ? 'Too many connections from this address.' : null
  }

  /** Takes on a connection: a new one, or one that was open before the relay last went idle. */
  add(connection: Connection, state: ConnectionState): void {
    this.connections.set(state.id, {connection, state})
    for (const [subId, keys] of Object.entries(state.subs)) this.indexSub(state.id, subId, keys)
  }

  remove(id: string): void {
    const entry = this.connections.get(id)
    if (!entry) return
    for (const [subId, keys] of Object.entries(entry.state.subs)) this.unindexSub(id, subId, keys)
    this.connections.delete(id)
    this.allowances.delete(id)
  }

  async receive(id: string, raw: string | ArrayBuffer): Promise<void> {
    const entry = this.connections.get(id)
    if (!entry) return
    const {connection, state} = entry
    const reply = (...parts: unknown[]) => connection.send(JSON.stringify(parts))

    if (typeof raw !== 'string') return reply('NOTICE', 'invalid: text messages only')
    if (raw.length > LIMITS.messageBytes) return reply('NOTICE', 'invalid: message too large')
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return reply('NOTICE', 'invalid: not JSON')
    }
    if (!Array.isArray(message)) return reply('NOTICE', 'invalid: expected an array')
    const [type, ...rest] = message
    const allowed = this.spend(id)

    if (type === 'EVENT') {
      const event = parseEvent(rest[0])
      if (!event) return reply('NOTICE', 'invalid: malformed event')
      if (!allowed) return reply('OK', event.id, false, 'rate-limited: slow down')
      if (event.kind < FIRST_KIND || event.kind > LAST_KIND) {
        return reply('OK', event.id, false, 'blocked: this relay only passes short-lived events (kinds 20000 to 29999) and stores nothing')
      }
      const topics = event.tags.filter(tag => tag[0] === 'x' && typeof tag[1] === 'string').map(tag => tag[1])
      if (topics.length === 0) return reply('OK', event.id, false, 'invalid: needs an x tag')
      if ((await eventId(event)) !== event.id) return reply('OK', event.id, false, 'invalid: event id does not match its contents')
      reply('OK', event.id, true, '')
      this.deliver(event, topics)
    } else if (type === 'REQ') {
      const [subId, ...filters] = rest
      if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) return reply('NOTICE', 'invalid: subscription id')
      if (!allowed) return reply('CLOSED', subId, 'rate-limited: slow down')
      const wanted = wantedTopics(filters)
      if (typeof wanted === 'string') return reply('CLOSED', subId, wanted)
      const subs = {...state.subs, [subId]: wanted}
      if (Object.keys(subs).length > LIMITS.subscriptionsPerConnection) return reply('CLOSED', subId, 'unsupported: too many subscriptions')
      const next = {...state, subs}
      if (JSON.stringify(next).length > LIMITS.stateBytes) return reply('CLOSED', subId, 'unsupported: too many topics on one connection')
      if (state.subs[subId]) this.unindexSub(id, subId, state.subs[subId])
      this.indexSub(id, subId, wanted)
      entry.state = next
      connection.save(next)
      // Nothing is stored, so there is never anything older to send first.
      reply('EOSE', subId)
    } else if (type === 'CLOSE') {
      const [subId] = rest
      if (typeof subId !== 'string' || !state.subs[subId]) return
      this.unindexSub(id, subId, state.subs[subId])
      const {[subId]: _closed, ...subs} = state.subs
      entry.state = {...state, subs}
      connection.save(entry.state)
    } else {
      reply('NOTICE', 'unsupported: this relay understands EVENT, REQ and CLOSE')
    }
  }

  private deliver(event: NostrEvent, topics: string[]): void {
    const eventJson = JSON.stringify(event)
    const sent = new Set<string>()
    for (const key of new Set(topics.map(topicKey))) {
      for (const [id, subIds] of this.index.get(key) ?? []) {
        const target = this.connections.get(id)
        if (!target) continue
        for (const subId of subIds) {
          if (sent.has(`${id}\n${subId}`)) continue
          sent.add(`${id}\n${subId}`)
          try {
            target.connection.send(`["EVENT",${JSON.stringify(subId)},${eventJson}]`)
          } catch {
            // That connection has gone; its close will tidy up.
          }
        }
      }
    }
  }

  /** Takes one message from the connection's allowance; false if it has none left. */
  private spend(id: string): boolean {
    const now = this.now()
    const allowance = this.allowances.get(id) ?? {left: LIMITS.burst, at: now}
    allowance.left = Math.min(LIMITS.burst, allowance.left + ((now - allowance.at) / 1000) * LIMITS.perSecond)
    allowance.at = now
    this.allowances.set(id, allowance)
    if (allowance.left < 1) return false
    allowance.left -= 1
    return true
  }

  private indexSub(id: string, subId: string, keys: string[]): void {
    for (const key of keys) {
      if (!this.index.has(key)) this.index.set(key, new Map())
      const byConnection = this.index.get(key)!
      if (!byConnection.has(id)) byConnection.set(id, new Set())
      byConnection.get(id)!.add(subId)
    }
  }

  private unindexSub(id: string, subId: string, keys: string[]): void {
    for (const key of keys) {
      const byConnection = this.index.get(key)
      const subIds = byConnection?.get(id)
      if (!byConnection || !subIds) continue
      subIds.delete(subId)
      if (subIds.size === 0) byConnection.delete(id)
      if (byConnection.size === 0) this.index.delete(key)
    }
  }
}
