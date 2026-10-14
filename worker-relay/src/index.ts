// snrdlr's own Nostr relay: a permanent place for devices to find each other, beside the public
// relays, and where sealed messages wait for members who are offline. The rules are in relay.ts;
// this file connects them to Cloudflare.
//
// Every connection is handed to one Durable Object, which holds the WebSockets. Cloudflare lets
// the object go idle between messages without dropping the sockets, so each socket carries its
// own subscriptions as an attachment and the object rebuilds its picture from them when it wakes.
import {LIMITS, Relay, STORED_KIND, type ConnectionState, type MessageStore} from './relay'

type RateLimiter = {limit: (options: {key: string}) => Promise<{success: boolean}>}
type ObjectStub = {fetch: (request: Request) => Promise<Response>}
export type Env = {
  RELAY: {idFromName: (name: string) => unknown; get: (id: unknown) => ObjectStub}
  CONNECT_LIMITER: RateLimiter
}

/** The parts of Cloudflare's hibernating WebSocket that are used here. */
type HeldSocket = {
  send: (text: string) => void
  close: (code?: number, reason?: string) => void
  serializeAttachment: (value: unknown) => void
  deserializeAttachment: () => unknown
}
type Sql = {exec: (query: string, ...values: (string | number)[]) => {toArray: () => Record<string, string | number>[]}; databaseSize: number}
type ObjectContext = {
  acceptWebSocket: (socket: HeldSocket) => void
  getWebSockets: () => HeldSocket[]
  storage: {sql: Sql; getAlarm: () => Promise<number | null>; setAlarm: (at: number) => Promise<void>}
}

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000

/** Stored messages in the object's own SQLite database. */
function sqlStore(sql: Sql): MessageStore {
  sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL, json TEXT NOT NULL)')
  sql.exec('CREATE INDEX IF NOT EXISTS events_by_topic ON events (topic, created_at)')
  sql.exec('CREATE INDEX IF NOT EXISTS events_by_expiry ON events (expires_at)')
  return {
    put({id, topic, createdAt, expiresAt, json}) {
      const added = sql.exec('INSERT OR IGNORE INTO events (id, topic, created_at, expires_at, bytes, json) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', id, topic, createdAt, expiresAt, json.length, json)
      return added.toArray().length > 0
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
    size: () => sql.databaseSize
  }
}
declare const WebSocketPair: new () => {0: unknown; 1: HeldSocket}

const INFO = {
  name: 'snrdlr relay',
  description:
    `Passes short-lived events (kinds 20000 to 29999) between devices connected at the same moment, so they can find each other, and keeps sealed messages of kind ${STORED_KIND} for up to ${LIMITS.keepSeconds / 86400} days. Nothing else is accepted. Subscriptions must name their topics with an #x filter.`,
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

  constructor(private ctx: ObjectContext) {
    this.relay = new Relay(Date.now, sqlStore(ctx.storage.sql))
    // Waking after an idle spell: the sockets are still open, and each remembers its own subscriptions.
    for (const socket of ctx.getWebSockets()) {
      const state = socket.deserializeAttachment() as ConnectionState | null
      if (state) this.relay.add(this.connectionFor(socket), state)
    }
  }

  private connectionFor(socket: HeldSocket) {
    return {send: (text: string) => socket.send(text), save: (state: ConnectionState) => socket.serializeAttachment(state)}
  }

  /** Throws away messages that have been held long enough. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM events WHERE expires_at <= ?', Math.floor(Date.now() / 1000))
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
  }

  async fetch(request: Request): Promise<Response> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
    const from = await shortHash(request.headers.get('CF-Connecting-IP') ?? 'unknown')
    const refusal = this.relay.refusal(from)
    if (refusal) return new Response(refusal, {status: 503})
    const pair = new WebSocketPair()
    const state: ConnectionState = {id: crypto.randomUUID(), from, subs: {}}
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
