// The mailbox: sealed messages left with our relay for members who are not online, and collected
// from it. The relay speaks the Nostr protocol, so each message travels as a Nostr event whose
// content is the sealed envelope and whose one tag is the chat's store topic, which only members can
// work out. The relay cannot read the envelope, and each event is signed with a key made for it and
// thrown away, so events cannot be linked to a person or to each other except by their topic.
//
// One connection serves every chat on the device.
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {fromBase64Url, toBase64Url, toHex, utf8} from './bytes'
import {RELAYS} from './relays'

/** The kind of Nostr event our relay keeps. The same number as STORED_KIND in worker-relay/src/relay.ts. */
export const STORED_KIND = 7467
/** How long the relay is asked to keep a message; it keeps none longer than this anyway. */
export const KEEP_SECONDS = 30 * 24 * 60 * 60
// Collecting starts this long before the last time we collected, because messages are filed by their
// senders' clocks, which are not all right.
const OVERLAP_SECONDS = 2 * 24 * 60 * 60
const RECONNECT_MS = [1000, 3000, 10_000, 30_000, 60_000]
const ANSWER_TIMEOUT_MS = 10_000
const MAX_WAITING = 500

export type MailboxHandlers = {
  /** A sealed envelope from the relay: stored earlier, or just posted by someone. May be one we already hold. */
  onEnvelope: (envelope: Uint8Array) => void
  /** Everything stored has been handed over; `asOf` is when it was asked for. */
  onCaughtUp?: (asOf: number) => void
}

export type Mailbox = {
  /**
   * Leaves an envelope with the relay. True once the relay has it; false if that could not be done for
   * now. `notify`, the author's tag in this chat (push.ts), asks the relay to wake members' devices.
   */
  post: (envelope: Uint8Array, sentAt: number, notify?: string) => Promise<boolean>
  close: () => void
}

/** Opens a chat's mailbox, asking for what was stored since `collectedAt` (when we last caught up), if ever. */
export type OpenMailbox = (topic: string, collectedAt: number | undefined, handlers: MailboxHandlers) => Mailbox

export type NostrEvent = {id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string}

/** Wraps a sealed envelope as an event for the relay to keep. */
export function wrapEnvelope(topic: string, envelope: Uint8Array, sentAt: number, notify?: string): NostrEvent {
  const secretKey = schnorr.utils.randomSecretKey()
  const pubkey = toHex(schnorr.getPublicKey(secretKey))
  const created_at = Math.floor(sentAt / 1000)
  const tags = [
    ['x', topic],
    ['expiration', String(created_at + KEEP_SECONDS)],
    ...(notify ? [['n', notify]] : [])
  ]
  const content = toBase64Url(envelope)
  const id = sha256(utf8(JSON.stringify([0, pubkey, created_at, STORED_KIND, tags, content])))
  return {id: toHex(id), pubkey, created_at, kind: STORED_KIND, tags, content, sig: toHex(schnorr.sign(id, secretKey))}
}

/** The envelope inside an event from the relay; null if it is not one of ours. */
export function unwrapEnvelope(event: unknown): Uint8Array | null {
  const {kind, content} = (event ?? {}) as Partial<NostrEvent>
  if (kind !== STORED_KIND || typeof content !== 'string') return null
  try {
    return fromBase64Url(content)
  } catch {
    return null
  }
}

type Sub = {id: string; topic: string; collectedAt: number | undefined; handlers: MailboxHandlers; askedAt: number}

/** Mailboxes on one relay, sharing a connection that is opened when first needed and kept up while any is open. */
export function relayMailboxes(url: string, makeSocket: (url: string) => WebSocket = target => new WebSocket(target)): OpenMailbox {
  const subs = new Map<string, Sub>()
  // Events not yet acknowledged by the relay, by event id, in the order they were posted.
  const waiting = new Map<string, {json: string; done: (kept: boolean) => void; timer?: ReturnType<typeof setTimeout>}>()
  let socket: WebSocket | null = null
  let attempts = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let serial = 0

  const ask = (sub: Sub) => {
    sub.askedAt = Date.now()
    const since = sub.collectedAt === undefined ? {} : {since: Math.max(0, Math.floor(sub.collectedAt / 1000) - OVERLAP_SECONDS)}
    socket?.send(JSON.stringify(['REQ', sub.id, {'#x': [sub.topic], kinds: [STORED_KIND], ...since}]))
  }
  const send = (id: string) => {
    const entry = waiting.get(id)
    if (!entry || socket?.readyState !== WebSocket.OPEN) return
    socket.send(`["EVENT",${entry.json}]`)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => settle(id, false), ANSWER_TIMEOUT_MS)
  }
  const settle = (id: string, kept: boolean) => {
    const entry = waiting.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    waiting.delete(id)
    entry.done(kept)
  }

  function connect() {
    if (socket || subs.size === 0) return
    if (retry) clearTimeout(retry)
    retry = null
    let opened: WebSocket
    try {
      opened = makeSocket(url)
    } catch {
      return again()
    }
    socket = opened
    opened.onopen = () => {
      if (socket !== opened) return
      attempts = 0
      subs.forEach(ask)
      for (const id of waiting.keys()) send(id)
    }
    opened.onmessage = ({data}) => {
      if (typeof data !== 'string') return
      let message: unknown
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      if (!Array.isArray(message)) return
      const [type, first, second, third] = message as [string, unknown, unknown, unknown]
      // Answers about what was posted still count on a connection that is being wound down.
      if (socket !== opened && type !== 'OK') return
      const sub = typeof first === 'string' ? [...subs.values()].find(candidate => candidate.id === first) : undefined
      if (type === 'EVENT' && sub) {
        const envelope = unwrapEnvelope(second)
        if (envelope) sub.handlers.onEnvelope(envelope)
      } else if (type === 'EOSE' && sub) {
        sub.collectedAt = sub.askedAt
        sub.handlers.onCaughtUp?.(sub.askedAt)
      } else if (type === 'OK' && typeof first === 'string') {
        // The relay has it, now or from before. A refusal for going too fast is tried again later.
        const kept = second === true || (typeof third === 'string' && third.startsWith('duplicate'))
        settle(first, kept)
      }
    }
    opened.onclose = () => {
      if (socket !== opened) return
      socket = null
      // Whatever was waiting for an answer did not get one.
      for (const id of [...waiting.keys()]) settle(id, false)
      again()
    }
    opened.onerror = () => opened.close()
  }

  function again() {
    if (retry || subs.size === 0) return
    retry = setTimeout(() => {
      retry = null
      connect()
    }, RECONNECT_MS[Math.min(attempts++, RECONNECT_MS.length - 1)])
  }

  // A phone drops connections while the app is out of sight without saying so. Coming back, or the
  // network returning, is the moment to check: ask again, and start over if no answer comes.
  const check = () => {
    if (subs.size === 0) return
    if (!socket || socket.readyState > WebSocket.OPEN) {
      socket = null
      attempts = 0
      return connect()
    }
    if (socket.readyState !== WebSocket.OPEN) return
    const checked = socket
    const before = [...subs.values()].map(sub => sub.collectedAt)
    subs.forEach(ask)
    setTimeout(() => {
      const answered = [...subs.values()].some((sub, index) => sub.collectedAt !== before[index])
      if (socket === checked && !answered && subs.size > 0) checked.close()
    }, ANSWER_TIMEOUT_MS)
  }
  if (typeof addEventListener === 'function' && typeof document !== 'undefined') {
    addEventListener('online', check)
    document.addEventListener('visibilitychange', () => !document.hidden && check())
  }

  return (topic, collectedAt, handlers) => {
    const sub: Sub = {id: `m${serial++}`, topic, collectedAt, handlers, askedAt: Date.now()}
    subs.set(sub.id, sub)
    if (socket?.readyState === WebSocket.OPEN) ask(sub)
    else connect()
    return {
      post: (envelope, sentAt, notify) =>
        new Promise<boolean>(resolve => {
          if (!subs.has(sub.id) || waiting.size >= MAX_WAITING) return resolve(false)
          const event = wrapEnvelope(topic, envelope, sentAt, notify)
          waiting.set(event.id, {json: JSON.stringify(event), done: resolve})
          if (socket?.readyState === WebSocket.OPEN) send(event.id)
          else {
            // Given a little while for the connection to come up, then left for the next time the chat opens.
            waiting.get(event.id)!.timer = setTimeout(() => settle(event.id, false), ANSWER_TIMEOUT_MS)
            connect()
          }
        }),
      close: () => {
        if (!subs.delete(sub.id)) return
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', sub.id]))
        if (subs.size === 0) {
          if (retry) clearTimeout(retry)
          retry = null
          const closing = socket
          socket = null
          // Let anything just posted get its answer before hanging up.
          setTimeout(() => closing?.close(), waiting.size > 0 ? 1500 : 0)
        }
      }
    }
  }
}

// Set for local testing against scripts/local-relay.mjs; unset, messages are left with our own relay.
const storeUrl = import.meta.env?.VITE_STORE_RELAY?.trim()
/** The app's mailboxes, on our relay. */
export const mailboxes: OpenMailbox = relayMailboxes(storeUrl || RELAYS[0])
