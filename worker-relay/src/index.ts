// snrdlr's own Nostr relay: a permanent place for devices to find each other, beside the public
// relays, and where sealed messages wait for members who are offline. The rules are in relay.ts;
// this file connects them to Cloudflare.
//
// Every connection is handed to one Durable Object, which holds the WebSockets. Cloudflare lets
// the object go idle between messages without dropping the sockets, so each socket carries its
// own subscriptions as an attachment and the object rebuilds its picture from them when it wakes.
import {LIMITS, Relay, STORED_KIND, type ConnectionState, type MessageStore, type PushBook} from './relay'
import {sqlStats, type RelayStats, type Sql} from './stats'
import {sendPush, type PushTarget} from './webpush'

type RateLimiter = {limit: (options: {key: string}) => Promise<{success: boolean}>}
type ObjectStub = {fetch: (request: Request) => Promise<Response>}
export type Env = {
  RELAY: {idFromName: (name: string) => unknown; get: (id: unknown) => ObjectStub}
  CONNECT_LIMITER: RateLimiter
  /** The relay's push signing key, a P-256 JWK as JSON. A secret; without it no pushes are offered. */
  VAPID_PRIVATE_KEY?: string
}

/** The parts of Cloudflare's hibernating WebSocket that are used here. */
type HeldSocket = {
  send: (text: string) => void
  close: (code?: number, reason?: string) => void
  serializeAttachment: (value: unknown) => void
  deserializeAttachment: () => unknown
}
type ObjectContext = {
  waitUntil: (work: Promise<unknown>) => void
  acceptWebSocket: (socket: HeldSocket) => void
  getWebSockets: () => HeldSocket[]
  storage: {sql: Sql; getAlarm: () => Promise<number | null>; setAlarm: (at: number) => Promise<void>}
}

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000
// A connection counts as active on the dashboard if it sent anything this recently.
const ACTIVE_MS = 5 * 60_000
/** Who the push services are told is sending, should they need to get in touch. */
const PUSH_SUBJECT = 'https://alpha.snrdlr.net'
/** A device that has not renewed its registration for this long is forgotten. Devices renew daily while used. */
const PUSH_FORGET_MS = 60 * 24 * 3600_000
/** At most one push per device per chat this often; a burst of messages wakes a phone once. */
const PUSH_GAP_MS = 5000

/** Push registrations in the object's own SQLite database, and the sending of pushes. */
export function sqlPushes(sql: Sql, vapidJson: string, waitUntil: (work: Promise<unknown>) => void, stats: RelayStats): PushBook {
  sql.exec('CREATE TABLE IF NOT EXISTS push_targets (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS push_topics (topic TEXT NOT NULL, endpoint TEXT NOT NULL, me TEXT NOT NULL, last_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (topic, endpoint))')
  sql.exec('CREATE INDEX IF NOT EXISTS push_topics_by_endpoint ON push_topics (endpoint)')
  // Who is using the app right now, by their tag in each chat: their devices are not woken meanwhile.
  sql.exec('CREATE TABLE IF NOT EXISTS push_awake (topic TEXT NOT NULL, me TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (topic, me))')
  const vapid = JSON.parse(vapidJson) as JsonWebKey
  const forget = (endpoint: string) => {
    sql.exec('DELETE FROM push_topics WHERE endpoint = ?', endpoint)
    sql.exec('DELETE FROM push_targets WHERE endpoint = ?', endpoint)
  }
  return {
    register(target, topics) {
      sql.exec(
        'INSERT INTO push_targets (endpoint, p256dh, auth, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at',
        target.endpoint,
        target.p256dh,
        target.auth,
        Date.now()
      )
      sql.exec('DELETE FROM push_topics WHERE endpoint = ?', target.endpoint)
      for (const {topic, me} of topics) sql.exec('INSERT OR REPLACE INTO push_topics (topic, endpoint, me) VALUES (?, ?, ?)', topic, target.endpoint, me)
    },
    forget,
    awake(topics, seconds) {
      const now = Date.now()
      for (const {topic, me} of topics) {
        if (seconds === 0) {
          sql.exec('DELETE FROM push_awake WHERE topic = ? AND me = ?', topic, me)
          continue
        }
        // Said again before it runs out, as it is while someone is using the app: only rewritten once
        // less than half is left, which saves most of the writes this would otherwise cost.
        const [held] = sql.exec('SELECT until FROM push_awake WHERE topic = ? AND me = ?', topic, me).toArray() as {until: number}[]
        if (held && held.until - now > (seconds * 1000) / 2) continue
        sql.exec('INSERT OR REPLACE INTO push_awake (topic, me, until) VALUES (?, ?, ?)', topic, me, now + seconds * 1000)
      }
    },
    async stored(topic, me) {
      const now = Date.now()
      const targets = sql
        .exec(
          `SELECT t.endpoint, t.p256dh, t.auth FROM push_topics p JOIN push_targets t ON t.endpoint = p.endpoint
           WHERE p.topic = ? AND p.me != ? AND p.last_at < ?
           AND NOT EXISTS (SELECT 1 FROM push_awake a WHERE a.topic = p.topic AND a.me = p.me AND a.until > ?)`,
          topic,
          me,
          now - PUSH_GAP_MS,
          now
        )
        .toArray() as PushTarget[]
      if (targets.length === 0) return
      const placeholders = targets.map(() => '?').join(', ')
      sql.exec(`UPDATE push_topics SET last_at = ? WHERE topic = ? AND endpoint IN (${placeholders})`, now, topic, ...targets.map(target => target.endpoint))
      // Sent while the relay carries on; the device reads which chat from `t` and asks for the message itself.
      waitUntil(
        Promise.all(
          targets.map(async target => {
            const outcome = await sendPush(target, {t: topic}, {vapid, subject: PUSH_SUBJECT, collapse: topic.slice(0, 32)})
            stats.count(outcome === 'sent' ? 'push_sent' : outcome === 'gone' ? 'push_gone' : 'push_failed')
            if (outcome === 'gone') forget(target.endpoint)
          })
        )
      )
    }
  }
}

/** Stored messages in the object's own SQLite database. */
function sqlStore(sql: Sql, stats: RelayStats): MessageStore {
  sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL, json TEXT NOT NULL)')
  sql.exec('CREATE INDEX IF NOT EXISTS events_by_topic ON events (topic, created_at)')
  sql.exec('CREATE INDEX IF NOT EXISTS events_by_expiry ON events (expires_at)')
  return {
    put({id, topic, createdAt, expiresAt, json}) {
      const added = sql.exec('INSERT OR IGNORE INTO events (id, topic, created_at, expires_at, bytes, json) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', id, topic, createdAt, expiresAt, json.length, json)
      const isNew = added.toArray().length > 0
      if (isNew) {
        stats.count('stored')
        stats.count('stored_bytes', json.length)
      }
      return isNew
    },
    query: (topic, since, now, limit) =>
      sql
        .exec('SELECT json FROM events WHERE topic = ? AND created_at >= ? AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?', topic, since, now, limit)
        .toArray()
        .map(row => row.json as string),
    trim(topic, maxCount, maxBytes) {
      const [{count, bytes}] = sql.exec('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM events WHERE topic = ?', topic).toArray() as {count: number; bytes: number}[]
      if (count <= maxCount && bytes <= maxBytes) return
      // Oldest first, a tenth at a time, so a full topic is not trimmed on every message.
      sql.exec('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE topic = ? ORDER BY rowid LIMIT ?)', topic, Math.max(1, Math.ceil(count / 10)))
    },
    remove(ids) {
      for (const id of ids) sql.exec('DELETE FROM events WHERE id = ?', id)
    },
    size: () => sql.databaseSize
  }
}
declare const WebSocketPair: new () => {0: unknown; 1: HeldSocket}

const INFO = {
  name: 'snrdlr relay',
  description:
    `Passes short-lived events (kinds 20000 to 29999) between devices connected at the same moment, so they can find each other, and keeps sealed messages of kind ${STORED_KIND} for up to ${LIMITS.keepSeconds / 86400} days; one stored with an f tag is deleted early by FORGET with the key it names. Nothing else is accepted. Subscriptions must name their topics with an #x filter.`,
  software: 'https://github.com/myklemykle/snrdlr',
  supported_nips: [1, 11, 40],
  limitation: {
    max_message_length: LIMITS.messageBytes,
    max_subscriptions: LIMITS.subscriptionsPerConnection,
    max_filters: LIMITS.filtersPerSubscription,
    auth_required: false,
    payment_required: false
  }
}

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(digest.slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const address = request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const {success} = await env.CONNECT_LIMITER.limit({key: address})
      if (!success) return new Response('Too many connections. Try again in a minute.', {status: 429})
      // Only WebSocket upgrades are passed to the object. Anything else it is asked comes from another of
      // our Workers through a binding, which is what keeps its /stats private (see RelayRoom.fetch).
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(request)
    }
    if (request.headers.get('Accept')?.includes('application/nostr+json')) {
      return Response.json(INFO, {headers: {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/nostr+json'}})
    }
    return new Response(`${INFO.name}\n\n${INFO.description}\n\n${INFO.software}\n`, {headers: {'Content-Type': 'text/plain; charset=utf-8'}})
  }
}

export class RelayRoom {
  private relay: Relay
  private stats: RelayStats

  constructor(
    private ctx: ObjectContext,
    private env: Env
  ) {
    this.stats = sqlStats(ctx.storage.sql)
    const pushes = env.VAPID_PRIVATE_KEY ? sqlPushes(ctx.storage.sql, env.VAPID_PRIVATE_KEY, work => ctx.waitUntil(work), this.stats) : null
    this.relay = new Relay(Date.now, sqlStore(ctx.storage.sql, this.stats), pushes, kind => this.stats.tally(kind))
    // Waking after an idle spell: the sockets are still open, and each remembers its own subscriptions.
    for (const socket of ctx.getWebSockets()) {
      const state = socket.deserializeAttachment() as ConnectionState | null
      if (state) this.relay.add(this.connectionFor(socket), state)
    }
  }

  private connectionFor(socket: HeldSocket) {
    return {
      send: (text: string) => socket.send(text),
      save: (state: ConnectionState) => socket.serializeAttachment(state),
      close: () => {
        try {
          socket.close(1013, 'Too many connections from this address; this was the oldest.')
        } catch {
          // Already closed.
        }
      }
    }
  }

  /** Throws away messages that have been held long enough. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM events WHERE expires_at <= ?', Math.floor(Date.now() / 1000))
    if (this.env.VAPID_PRIVATE_KEY) {
      const old = Date.now() - PUSH_FORGET_MS
      this.ctx.storage.sql.exec('DELETE FROM push_topics WHERE endpoint IN (SELECT endpoint FROM push_targets WHERE updated_at < ?)', old)
      this.ctx.storage.sql.exec('DELETE FROM push_targets WHERE updated_at < ?', old)
      this.ctx.storage.sql.exec('DELETE FROM push_awake WHERE until < ?', Date.now())
    }
    this.stats.flush()
    this.stats.trim()
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
  }

  async fetch(request: Request): Promise<Response> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
    // Not an upgrade, so not from the relay's public face, which passes on nothing else: the dashboard.
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if (new URL(request.url).pathname === '/stats') return Response.json(this.stats.read(this.relay.connectionCounts(ACTIVE_MS)))
      return new Response('Not found', {status: 404})
    }
    const from = await shortHash(request.headers.get('CF-Connecting-IP') ?? 'unknown')
    const refusal = this.relay.refusal(from)
    if (refusal) {
      this.stats.count('refused')
      return new Response(refusal, {status: 503})
    }
    this.stats.count('connections')
    const pair = new WebSocketPair()
    const state: ConnectionState = {id: crypto.randomUUID(), from, subs: {}, since: Date.now()}
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment(state)
    this.relay.add(this.connectionFor(pair[1]), state)
    return new Response(null, {status: 101, webSocket: pair[0]} as ResponseInit)
  }

  async webSocketMessage(socket: HeldSocket, message: string | ArrayBuffer): Promise<void> {
    const state = socket.deserializeAttachment() as ConnectionState | null
    if (state) await this.relay.receive(state.id, message)
  }

  webSocketClose(socket: HeldSocket, code: number): void {
    this.forget(socket)
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code)
    } catch {
      // Already closed.
    }
  }

  webSocketError(socket: HeldSocket): void {
    this.forget(socket)
  }

  private forget(socket: HeldSocket): void {
    const state = socket.deserializeAttachment() as ConnectionState | null
    if (state) this.relay.remove(state.id)
  }
}
