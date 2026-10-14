// The relay's rules, kept apart from Cloudflare's plumbing so they can be tested on their own.
//
// It is a Nostr relay cut down to the two jobs the app needs.
//
// The first is passing short-lived events (kinds 20000 to 29999) between devices that are connected
// at the same moment, so they can find each other. None of those is stored.
//
// The second is holding sealed chat messages (one kind, STORED_KIND) for members who are not online
// when they are sent. The relay cannot read them: each is encrypted with a key only the chat's
// members hold, and filed under a topic derived from the chat's secret. They are kept for a
// limited time and in limited quantity per topic, then deleted.
//
// - Every other kind is refused: posts, profiles and private messages. It is of no use as a general
//   Nostr relay.
// - A subscription must name the topics it wants (an "#x" filter). Nobody can listen to everything,
//   so watching a room means already knowing its topic, which is derived from the chat's secret.
// - Signatures are not checked. Nothing depends on them: devices prove who they are to each other
//   after connecting, and connection setup is encrypted with the chat's own key.
// - "since" and "until" are ignored, so a device whose clock is wrong can still be found.
//
// Beyond Nostr, a device can ask to be woken by a push notification when a message is stored for one
// of its chats' topics (PUSH). The device that stores a message marks it with a tag ("n") when it
// is worth a notification, a sealed chat message rather than housekeeping, and that tag is the same
// value its author's devices registered for that topic, so none of them is woken by their own message.
// The tag means nothing outside its topic, so it does not link one person's chats to each other.

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
  perSecond: 5,
  /** Stored messages: how long each is kept, and how much one topic (one chat) may hold. */
  keepSeconds: 30 * 24 * 60 * 60,
  storedPerTopic: 2000,
  storedBytesPerTopic: 8 * 1024 * 1024,
  /** Topics one request may ask stored messages for, and the most it gets back. */
  storedTopicsPerFilter: 20,
  storedPerRequest: 2000,
  /** Beyond this the store takes nothing new until old messages expire. */
  storeBytes: 1024 * 1024 * 1024
}

/** A device's push address and keys, as its browser gives them. */
export type PushTarget = {endpoint: string; p256dh: string; auth: string}
/** A topic a device wants to be woken for, and the tag its own person's messages there carry. */
export type PushTopic = {topic: string; me: string}

/** Where push registrations are kept and pushes sent from. Absent, the relay does not offer pushes. */
export type PushBook = {
  /** Replaces whatever this device asked for before. */
  register: (target: PushTarget, topics: PushTopic[]) => void
  forget: (endpoint: string) => void
  /** A message worth a notification was stored under `topic` by someone whose tag there is `me`. */
  stored: (topic: string, me: string) => Promise<void>
}

/** Push services that browsers use. The relay posts to nowhere else, so it cannot be aimed at other sites. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/]
export const PUSH_LIMITS = {topics: 500}
const BASE64URL = /^[A-Za-z0-9_-]+$/
const HEX_32 = /^[0-9a-f]{32}$/

/** The device and topics in a PUSH message, or why they are refused. */
function pushRequest(target: unknown, topics: unknown): {target: PushTarget; topics: PushTopic[]} | string {
  if (!isRecord(target)) return 'invalid: push target'
  const {endpoint, p256dh, auth} = target
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return 'invalid: endpoint'
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'invalid: endpoint'
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some(host => host.test(url.hostname))) return 'blocked: not a push service'
  if (typeof p256dh !== 'string' || p256dh.length !== 87 || !BASE64URL.test(p256dh)) return 'invalid: p256dh'
  if (typeof auth !== 'string' || auth.length !== 22 || !BASE64URL.test(auth)) return 'invalid: auth'
  if (!Array.isArray(topics) || topics.length > PUSH_LIMITS.topics) return 'invalid: topics'
  const wanted: PushTopic[] = []
  for (const entry of topics) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !HEX_64.test(entry[0]) || typeof entry[1] !== 'string' || !HEX_32.test(entry[1])) {
      return 'invalid: topic'
    }
    wanted.push({topic: entry[0], me: entry[1]})
  }
  return {target: {endpoint, p256dh, auth}, topics: wanted}
}

/** The one kind of event that is kept: a sealed chat message. */
export const STORED_KIND = 7467

/** Where stored messages live. Cloudflare's storage in the real relay; memory in tests. */
export type MessageStore = {
  /** Keeps an event under its topic. False if it was already held. */
  put: (event: {id: string; topic: string; createdAt: number; expiresAt: number; json: string}) => boolean
  /** A topic's events from `since` on (by their own timestamps), newest first, that have not expired. */
  query: (topic: string, since: number, now: number, limit: number) => string[]
  /** Drops a topic's oldest events until it is within the limits. */
  trim: (topic: string, maxCount: number, maxBytes: number) => void
  /** Bytes in use, roughly. */
  size: () => number
}

/** A store in memory, for tests and for running the relay locally. */
export function memoryStore(): MessageStore {
  const held = new Map<string, {id: string; topic: string; createdAt: number; expiresAt: number; json: string; order: number}>()
  let order = 0
  const inTopic = (topic: string) => [...held.values()].filter(event => event.topic === topic)
  return {
    put(event) {
      if (held.has(event.id)) return false
      held.set(event.id, {...event, order: order++})
      return true
    },
    query: (topic, since, now, limit) =>
      inTopic(topic)
        .filter(event => event.createdAt >= since && event.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt || b.order - a.order)
        .slice(0, limit)
        .map(event => event.json),
    trim(topic, maxCount, maxBytes) {
      const events = inTopic(topic).sort((a, b) => a.order - b.order)
      let bytes = events.reduce((sum, event) => sum + event.json.length, 0)
      while (events.length > maxCount || bytes > maxBytes) {
        const oldest = events.shift()!
        bytes -= oldest.json.length
        held.delete(oldest.id)
      }
    },
    size: () => [...held.values()].reduce((sum, event) => sum + event.json.length, 0)
  }
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

/** For each filter that asks for stored messages: which topics, and from when. */
function storedWanted(filters: unknown[]): {topics: string[]; since: number; limit: number}[] {
  const wanted = []
  for (const filter of filters) {
    if (!isRecord(filter) || !Array.isArray(filter.kinds) || !filter.kinds.includes(STORED_KIND)) continue
    const topics = (filter['#x'] as string[]).slice(0, LIMITS.storedTopicsPerFilter)
    const since = Number.isSafeInteger(filter.since) ? (filter.since as number) : 0
    const limit = Number.isSafeInteger(filter.limit) && (filter.limit as number) >= 0 ? (filter.limit as number) : LIMITS.storedPerRequest
    wanted.push({topics, since, limit: Math.min(limit, LIMITS.storedPerRequest)})
  }
  return wanted
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

  constructor(
    private now: () => number = Date.now,
    /** Without one, the relay keeps nothing and refuses messages meant to be stored. */
    private store: MessageStore | null = null,
    private pushes: PushBook | null = null
  ) {}

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
      const kept = event.kind === STORED_KIND && this.store !== null
      if (!kept && (event.kind < FIRST_KIND || event.kind > LAST_KIND)) {
        return reply('OK', event.id, false, `blocked: this relay only passes short-lived events (kinds 20000 to 29999) and keeps sealed messages of kind ${STORED_KIND}`)
      }
      const topics = event.tags.filter(tag => tag[0] === 'x' && typeof tag[1] === 'string').map(tag => tag[1])
      if (topics.length === 0) return reply('OK', event.id, false, 'invalid: needs an x tag')
      if ((await eventId(event)) !== event.id) return reply('OK', event.id, false, 'invalid: event id does not match its contents')
      if (kept) {
        const refusal = this.keep(event, topics)
        if (refusal !== null) return reply('OK', event.id, refusal.startsWith('duplicate'), refusal)
      }
      reply('OK', event.id, true, '')
      this.deliver(event, topics)
      const notify = event.tags.find(tag => tag[0] === 'n')?.[1]
      if (kept && this.pushes && typeof notify === 'string' && HEX_32.test(notify)) await this.pushes.stored(topics[0], notify).catch(() => {})
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
      // What is held for these topics comes first, oldest to newest; then whatever arrives from now on.
      if (this.store) {
        const now = Math.floor(this.now() / 1000)
        for (const {topics, since, limit} of storedWanted(filters)) {
          let left = limit
          for (const topic of topics) {
            const found = this.store.query(topic, since, now, left)
            left -= found.length
            for (const json of found.reverse()) connection.send(`["EVENT",${JSON.stringify(subId)},${json}]`)
          }
        }
      }
      reply('EOSE', subId)
    } else if (type === 'CLOSE') {
      const [subId] = rest
      if (typeof subId !== 'string' || !state.subs[subId]) return
      this.unindexSub(id, subId, state.subs[subId])
      const {[subId]: _closed, ...subs} = state.subs
      entry.state = {...state, subs}
      connection.save(entry.state)
    } else if (type === 'PUSH' && this.pushes) {
      if (!allowed) return reply('PUSH', false, 'rate-limited: slow down')
      const request = pushRequest(rest[0], rest[1])
      if (typeof request === 'string') return reply('PUSH', false, request)
      this.pushes.register(request.target, request.topics)
      reply('PUSH', true, '')
    } else if (type === 'UNPUSH' && this.pushes) {
      if (typeof rest[0] === 'string' && rest[0].length <= 1024) this.pushes.forget(rest[0])
      reply('PUSH', true, '')
    } else {
      reply('NOTICE', 'unsupported: this relay understands EVENT, REQ and CLOSE')
    }
  }

  /** Stores a sealed message. Returns why not, if it was not newly stored. */
  private keep(event: NostrEvent, topics: string[]): string | null {
    const store = this.store!
    if (topics.length !== 1 || topics[0].length > 128) return 'invalid: a stored message has exactly one x tag'
    const now = Math.floor(this.now() / 1000)
    // Kept for as long as it asks (NIP-40), up to the relay's own limit.
    const asked = Number(event.tags.find(tag => tag[0] === 'expiration')?.[1])
    const expiresAt = Math.min(Number.isSafeInteger(asked) ? asked : Infinity, now + LIMITS.keepSeconds)
    if (expiresAt <= now) return 'invalid: already expired'
    if (store.size() > LIMITS.storeBytes) return 'error: the store is full'
    const [topic] = topics
    if (!store.put({id: event.id, topic, createdAt: event.created_at, expiresAt, json: JSON.stringify(event)})) return 'duplicate: already have this event'
    store.trim(topic, LIMITS.storedPerTopic, LIMITS.storedBytesPerTopic)
    return null
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
