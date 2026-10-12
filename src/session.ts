// One open chat: joins its room, and keeps the stored log and the network in step.
//
// Sync: whenever a peer connects (and every so often after), each side sends a version vector saying how
// much of every author's log it holds, and the other replies with the envelopes it is missing. Envelopes
// are signed by their authors, so any member can pass on anyone's messages.
import {importMsgKey, openEnvelope, sealEnvelope, type ChatContext, type Content} from './envelope'
import type {Identity} from './identity'
import {deriveChatKeys, type ChatKeys} from './keys'
import type {Route} from './route'
import type {ChatRecord, MessageRecord, Store} from './store'

/** For each author, how many of their messages are held without a gap, counting from 1. */
export type VersionVector = Record<string, number>

export type WireHandlers = {
  onEnvelope: (envelope: Uint8Array, peerId: string) => void
  onSync: (have: unknown, peerId: string) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
}

export type Wire = {
  /** Sends to everyone connected, or to one peer. */
  send: (envelope: Uint8Array, peerId?: string) => Promise<void>
  sendSync: (have: VersionVector, peerId?: string) => Promise<void>
  /** Rejects if the peer does not answer. */
  ping: (peerId: string) => Promise<void>
  routes: () => Promise<Route[]>
  leave: () => Promise<void>
}

export type SessionHandlers = {
  onMessages: (messages: MessageRecord[]) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
}

export type Session = {
  sendText: (text: string) => Promise<void>
  /** Call when the app returns to the foreground or the network comes back, with how long it was away. */
  resume: (awayMs: number) => Promise<void>
  routes: () => Promise<Route[]>
  close: () => Promise<void>
}

const MAX_SEQ_RETRIES = 5
const MAX_VECTOR_AUTHORS = 1024
const RESYNC_INTERVAL_MS = 30_000
// With nobody connected there is no one to ping, so after this long away assume the connection is dead.
const STALE_AFTER_MS = 30_000

const compare = (a: MessageRecord, b: MessageRecord) =>
  a.lamport - b.lamport || a.author.localeCompare(b.author) || a.seq - b.seq

export function versionVector(messages: MessageRecord[]): VersionVector {
  const held = new Map<string, Set<number>>()
  for (const {author, seq} of messages) {
    if (!held.has(author)) held.set(author, new Set())
    held.get(author)!.add(seq)
  }
  const vector: VersionVector = {}
  for (const [author, seqs] of held) {
    let count = 0
    while (seqs.has(count + 1)) count++
    vector[author] = count
  }
  return vector
}

function parseVector(value: unknown): VersionVector | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_VECTOR_AUTHORS) return null
  for (const [author, count] of entries) {
    if (!/^[0-9a-f]{64}$/.test(author) || !Number.isSafeInteger(count) || count < 0) return null
  }
  return value as VersionVector
}

export async function openSession(options: {
  chat: ChatRecord
  identity: Identity
  store: Store
  connect: (keys: ChatKeys, handlers: WireHandlers) => Wire | Promise<Wire>
  handlers: SessionHandlers
}): Promise<Session> {
  const {chat, identity, store, handlers} = options
  const keys = deriveChatKeys(chat.secret)
  const context: ChatContext = {chatId: chat.id, msgKey: await importMsgKey(keys.msgKey)}

  let messages = await store.listMessages(chat.id)
  let wire: Wire | null = null
  let generation = 0
  let peers: string[] = []
  let closed = false
  let reconnecting = false
  const publish = () => handlers.onMessages(messages)

  const insert = (record: MessageRecord) => {
    const inOrder = messages.length === 0 || compare(messages[messages.length - 1], record) < 0
    messages = [...messages, record]
    if (!inOrder) messages.sort(compare)
    publish()
  }
  const lamportNow = () => messages.reduce((max, message) => Math.max(max, message.lamport), 0)
  const ownSeq = () => messages.reduce((max, message) => (message.author === identity.id ? Math.max(max, message.seq) : max), 0)

  /** Signs, stores, then sends a message of our own. Peers who are away get it by sync later. */
  async function post(content: Content): Promise<void> {
    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      const message = {seq: ownSeq() + 1, lamport: lamportNow() + 1, sentAt: Date.now(), content}
      const envelope = await sealEnvelope(context, identity, message)
      const record: MessageRecord = {...message, author: identity.id, chatId: chat.id, receivedAt: message.sentAt, envelope}
      if (await store.addMessage(record)) {
        insert(record)
        await wire?.send(envelope).catch(() => {})
        return
      }
      // Another tab on this device used that sequence number first; pick up its messages and retry.
      messages = await store.listMessages(chat.id)
      publish()
    }
    throw new Error('could not allocate a sequence number')
  }

  async function receive(envelope: Uint8Array) {
    try {
      const message = await openEnvelope(context, envelope)
      const record: MessageRecord = {...message, chatId: chat.id, receivedAt: Date.now(), envelope}
      if ((await store.addMessage(record)) && !closed) insert(record)
    } catch (error) {
      console.warn('dropped a message:', error instanceof Error ? error.message : error)
    }
  }

  // Sends a peer everything they say they lack. Their vector is the only evidence of what they hold:
  // a message that was sent to them earlier may have gone into a connection that had quietly died.
  async function answerSync(value: unknown, peerId: string, via: Wire) {
    const have = parseVector(value)
    if (!have) return
    const missing = messages.filter(message => message.seq > (have[message.author] ?? 0))
    for (const message of missing) {
      if (wire !== via || !peers.includes(peerId)) return
      try {
        await via.send(message.envelope, peerId)
      } catch {
        return
      }
    }
  }

  async function openWire() {
    const mine = ++generation
    const live = () => mine === generation && !closed
    // Peers can show up before `connect` has returned the wire, so handlers that reply wait for it.
    let wireReady!: (opened: Wire) => void
    const ready = new Promise<Wire>(resolve => (wireReady = resolve))
    const opened = await options.connect(keys, {
      onEnvelope: envelope => void receive(envelope),
      onSync: (have, peerId) =>
        void ready.then(via => {
          if (live()) void answerSync(have, peerId, via)
        }),
      onPeersChange: peerIds =>
        void ready.then(via => {
          if (!live()) return
          const newcomers = peerIds.filter(peerId => !peers.includes(peerId))
          peers = peerIds
          handlers.onPeersChange(peerIds)
          for (const peerId of newcomers) void via.sendSync(versionVector(messages), peerId).catch(() => {})
        }),
      onError: message => {
        if (live()) handlers.onError(message)
      }
    })
    if (!live()) return void opened.leave().catch(() => {})
    wire = opened
    wireReady(opened)
  }

  /** Leaves the room and joins it afresh; used when the old connections are probably dead. */
  async function reconnect() {
    reconnecting = true
    try {
      const old = wire
      wire = null
      generation++
      peers = []
      handlers.onPeersChange([])
      await old?.leave().catch(() => {})
      if (!closed) await openWire()
    } finally {
      reconnecting = false
    }
  }

  publish()
  // Not awaited: connecting can take seconds, and messages can be written and queued meanwhile.
  void openWire().catch(() => handlers.onError("Couldn't connect to this chat."))
  if (!messages.some(message => message.author === identity.id && message.content.type === 'profile')) {
    await post({type: 'profile', name: identity.name})
  }

  // Catches anything missed in between, for example when not every pair of members is directly connected.
  const resync = setInterval(() => {
    if (peers.length > 0) void wire?.sendSync(versionVector(messages)).catch(() => {})
  }, RESYNC_INTERVAL_MS)

  return {
    sendText: text => post({type: 'text', text}),
    async resume(awayMs) {
      if (closed || reconnecting || !wire) return
      if (peers.length === 0) {
        if (awayMs >= STALE_AFTER_MS) await reconnect()
        return
      }
      const current = wire
      const answers = await Promise.all(peers.map(peerId => current.ping(peerId).then(() => true, () => false)))
      if (closed || wire !== current) return
      if (answers.every(Boolean)) void current.sendSync(versionVector(messages)).catch(() => {})
      else await reconnect()
    },
    routes: async () => (await wire?.routes()) ?? [],
    async close() {
      closed = true
      clearInterval(resync)
      await wire?.leave().catch(() => {})
    }
  }
}
