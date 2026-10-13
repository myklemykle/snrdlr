// snrdlr's own Nostr relay: a permanent place for devices to find each other, beside the public
// relays. The rules are in relay.ts; this file connects them to Cloudflare.
//
// Every connection is handed to one Durable Object, which holds the WebSockets. Cloudflare lets
// the object go idle between messages without dropping the sockets, so each socket carries its
// own subscriptions as an attachment and the object rebuilds its picture from them when it wakes.
import {LIMITS, Relay, type ConnectionState} from './relay'

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
type ObjectContext = {acceptWebSocket: (socket: HeldSocket) => void; getWebSockets: () => HeldSocket[]}
declare const WebSocketPair: new () => {0: unknown; 1: HeldSocket}

const INFO = {
  name: 'snrdlr relay',
  description:
    'Passes short-lived events (kinds 20000 to 29999) between devices connected at the same moment, so they can find each other. Stores nothing. Subscriptions must name their topics with an #x filter.',
  software: 'https://github.com/myklemykle/snrdlr',
  supported_nips: [1, 11],
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
  private relay = new Relay()

  constructor(private ctx: ObjectContext) {
    // Waking after an idle spell: the sockets are still open, and each remembers its own subscriptions.
    for (const socket of ctx.getWebSockets()) {
      const state = socket.deserializeAttachment() as ConnectionState | null
      if (state) this.relay.add(this.connectionFor(socket), state)
    }
  }

  private connectionFor(socket: HeldSocket) {
    return {send: (text: string) => socket.send(text), save: (state: ConnectionState) => socket.serializeAttachment(state)}
  }

  async fetch(request: Request): Promise<Response> {
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
