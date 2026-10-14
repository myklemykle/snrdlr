// One open chat: joins its room, and keeps the stored log and the network in step.
//
// Sync: whenever a peer connects (and every so often after), each side sends a version vector saying how
// much of every author's log it holds, and the other replies with the envelopes it is missing. Envelopes
// are signed by their authors, so any member can pass on anyone's messages.
//
// Authors: a message is only kept if its author is known to be a member. Members show that through the
// certificates in their own "joined" message, so a message can arrive before the proof that its author
// belongs; it is held until then, and never stored, shown or passed on if the proof does not come.
import {latestCards, sameCard} from './cards'
import {importMsgKey, openEnvelope, sealEnvelope, streamOf, type CardContent, type ChatContext, type ChatHeldContent, type Content, type ImageContent, type Message, type MessageRef} from './envelope'
import {fileHash, MAX_FILE_BYTES} from './files'
import {memberId, type Identity} from './identity'
import {openAsMember, sealForMembers, type Recipient} from './store-seal'
import {chatKeys, policyOf} from './chats'
import type {ChatKeys} from './keys'
import {KEEP_SECONDS, type Mailbox, type OpenMailbox} from './mailbox'
import {makeRoster} from './membership'
import type {Route} from './route'
import type {ChatRecord, MessageRecord, Store} from './store'

/** For each author, how many of their messages are held without a gap, counting from 1. */
export type VersionVector = Record<string, number>

export type WireHandlers = {
  onEnvelope: (envelope: Uint8Array, peerId: string) => void
  onSync: (have: unknown, peerId: string) => void
  /** A peer says how many messages it holds from the authors of what we just sent it. */
  onAck: (have: unknown, peerId: string) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
  /** A peer asks for a file. */
  onFileWanted: (hash: string, peerId: string) => void
  /** A peer sends a file, or says (with null) that it does not have it. */
  onFile: (hash: string, data: Uint8Array | null, peerId: string) => void
  /** Whether a file a peer is about to send is one we asked that peer for; anything else is not downloaded. */
  expectsFile: (hash: string, byteLength: number, peerId: string) => boolean
}

export type Wire = {
  /** Sends to everyone connected, or to one peer. */
  send: (envelope: Uint8Array, peerId?: string) => Promise<void>
  sendSync: (have: VersionVector, peerId?: string) => Promise<void>
  sendAck: (have: VersionVector, peerId: string) => Promise<void>
  requestFile: (hash: string, peerId: string) => Promise<void>
  /** Sends a file to the peer who asked, or null to say we do not have it. */
  sendFile: (hash: string, data: Uint8Array | null, peerId: string) => Promise<void>
  /** Rejects if the peer does not answer. */
  ping: (peerId: string) => Promise<void>
  routes: () => Promise<Route[]>
  leave: () => Promise<void>
}

/**
 * What the connection is doing: joining the room, waiting for others to appear after joining, testing
 * whether old connections survived, rejoining, or settled.
 */
export type ConnectionStatus = 'connecting' | 'searching' | 'checking' | 'reconnecting' | 'idle'

export type SessionHandlers = {
  onMessages: (messages: MessageRecord[]) => void
  /** The chat's name has changed: a direct chat takes the other person's name, and a group can be renamed. */
  onChatName?: (name: string) => void
  onStatus: (status: ConnectionStatus) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
  /** Messages of ours that some other member's device is now known to hold. Called once for each message. */
  onDelivered?: (messages: MessageRecord[]) => void
  /** The hashes of the files held for this chat, whenever that changes. */
  onFiles?: (held: ReadonlySet<string>) => void
}

/** A card to show in a chat, with the encrypted file of its photo if it has one. */
export type CardToShare = {content: CardContent; photoFile?: Uint8Array}

export type Session = {
  /** Sends words, optionally as a reply to an earlier message. */
  sendText: (text: string, replyTo?: MessageRef) => Promise<void>
  /** Records in the chat's log that we admitted someone. */
  postCert: (cert: Uint8Array) => Promise<void>
  /** In a direct chat: lets the other person into a group we have started. */
  postGroupInvite: (invite: Extract<Content, {type: 'group-invite'}>) => Promise<void>
  /** Shows this card as ours in the chat, or with null takes ours back. Does nothing if that is already so. */
  shareCard: (card: CardToShare | null) => Promise<void>
  /** Gives a group chat a new name, for every member. */
  rename: (name: string) => Promise<void>
  /** Changes the words of one of our own messages, or a picture's caption. */
  /** New words for one of our own messages, written on this device or another of ours. */
  edit: (target: {device: string; seq: number}, text: string) => Promise<void>
  /** Sets our reaction to a message, replacing any earlier one; an empty emoji removes it. */
  react: (target: MessageRef, emoji: string) => Promise<void>
  /** In the person's own hidden chat: tells their other devices about a chat held or left here. */
  note: (content: ChatHeldContent | {type: 'chat-left'; id: string}) => Promise<void>
  /** Sends a picture: stores its encrypted file, then posts the message that refers to it. */
  postImage: (image: ImageContent, file: Uint8Array) => Promise<void>
  /** Call when the app returns to the foreground or the network comes back, with how long it was away. */
  resume: (awayMs: number) => Promise<void>
  routes: () => Promise<Route[]>
  close: () => Promise<void>
}

const MAX_SEQ_RETRIES = 5
const MAX_VECTOR_AUTHORS = 1024
const RESYNC_INTERVAL_MS = 30_000
// Messages held while their author is not yet known to be a member. Anything dropped is offered again by sync.
const MAX_HELD = 256
// With nobody connected there is no one to ping, so after this long away assume the connection is dead.
const STALE_AFTER_MS = 30_000
// After joining, how long to say "looking for others" before concluding nobody is there.
const SEARCH_GRACE_MS = 8_000
// Connection attempts often fail once and then succeed, for example while a phone changes network.
// A failure is only reported if nobody has connected this long after it.
const ERROR_DELAY_MS = 15_000
// Files are fetched a few at a time. A peer that has not sent one after this long is given up on, and
// one that said it lacks a file is not asked again for a while.
// After receiving messages from a peer, how long to wait before telling them what we now hold, so a
// run of messages is acknowledged once.
const ACK_DELAY_MS = 50
const MAX_FILE_REQUESTS = 3
const FILE_TIMEOUT_MS = 45_000
const FILE_RETRY_MS = 25_000

const compare = (a: MessageRecord, b: MessageRecord) =>
  a.lamport - b.lamport || a.author.localeCompare(b.author) || a.device.localeCompare(b.device) || a.seq - b.seq

/** How many messages are held from each stream (one person on one device), counting from 1 without a gap. */
export function versionVector(messages: MessageRecord[]): VersionVector {
  const held = new Map<string, Set<number>>()
  for (const message of messages) {
    const stream = streamOf(message)
    if (!held.has(stream)) held.set(stream, new Set())
    held.get(stream)!.add(message.seq)
  }
  const vector: VersionVector = {}
  for (const [stream, seqs] of held) {
    let count = 0
    while (seqs.has(count + 1)) count++
    vector[stream] = count
  }
  return vector
}

function parseVector(value: unknown): VersionVector | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_VECTOR_AUTHORS) return null
  for (const [stream, count] of entries) {
    if (!/^[0-9a-f]{64}(\.[0-9a-f]{16})?$/.test(stream) || !Number.isSafeInteger(count) || count < 0) return null
  }
  return value as VersionVector
}

export async function openSession(options: {
  chat: ChatRecord
  identity: Identity
  store: Store
  connect: (keys: ChatKeys, handlers: WireHandlers) => Wire | Promise<Wire>
  handlers: SessionHandlers
  /** The card to show in this chat, or null to show none. Left out, whatever is showing stays. */
  card?: CardToShare | null
  /** Where sealed messages are left for members who are offline, and collected from. Left out, there is none. */
  mailbox?: OpenMailbox
  errorDelayMs?: number
}): Promise<Session> {
  const {chat, identity, store, handlers} = options
  const keys = chatKeys(chat)
  const context: ChatContext = {chatId: chat.id, msgKey: await importMsgKey(keys.msgKey)}

  let messages = await store.listMessages(chat.id)
  // Messages stored by an older version of the app as "unknown" may be readable now.
  for (const [index, stored] of messages.entries()) {
    if (stored.content.type !== 'unknown') continue
    const reread = await openEnvelope(context, stored.envelope).catch(() => null)
    if (reread && reread.content.type !== 'unknown') {
      messages[index] = {...stored, content: reread.content}
      await store.updateContent(messages[index])
    }
  }
  const roster = makeRoster(chat.id, policyOf(chat))
  roster.add(chat.chain)
  /** Takes in any certificates a message carries. Returns true if that made someone new a member. */
  const learnFrom = (content: Content) => {
    if (content.type === 'member-cert') return roster.add([content.cert])
    if (content.type === 'profile' && content.chain) return roster.add(content.chain)
    return false
  }
  for (const stored of messages) learnFrom(stored.content)
  let held: {message: Message; envelope: Uint8Array}[] = []

  let wire: Wire | null = null
  let generation = 0
  let peers: string[] = []
  let closed = false
  let reconnecting = false
  let status: ConnectionStatus = 'connecting'
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  const reportUnlessSomeoneConnects = (message: string) => {
    clearTimeout(errorTimer)
    if (peers.length === 0) setStatus('searching')
    errorTimer = setTimeout(() => !closed && handlers.onError(message), options.errorDelayMs ?? ERROR_DELAY_MS)
  }
  const setStatus = (next: ConnectionStatus) => {
    clearTimeout(searchTimer)
    if (closed) return
    if (next === 'searching') searchTimer = setTimeout(() => setStatus('idle'), SEARCH_GRACE_MS)
    if (next !== status) handlers.onStatus((status = next))
  }
  let chatName = chat.name
  const publish = () => {
    handlers.onMessages(messages)
    // A direct chat is named after the other person; a group, by whoever last gave it a name.
    const naming =
      chat.kind === 'dm'
        ? messages.findLast(message => message.author !== identity.id && message.content.type === 'profile')
        : messages.findLast(message => message.content.type === 'rename')
    const name = naming?.content.type === 'profile' || naming?.content.type === 'rename' ? naming.content.name : null
    if (name !== null && name !== chatName) {
      chatName = name
      void store.renameChat(chat.id, chatName)
      handlers.onChatName?.(chatName)
    }
  }

  const insert = (record: MessageRecord) => {
    const inOrder = messages.length === 0 || compare(messages[messages.length - 1], record) < 0
    messages = [...messages, record]
    if (!inOrder) messages.sort(compare)
    publish()
  }
  const lamportNow = () => messages.reduce((max, message) => Math.max(max, message.lamport), 0)
  // The ordering clock follows the wall clock when it can. A device that has been out of touch would
  // otherwise number its next message just after the last one it happened to see, and the message would
  // appear far up everyone's history instead of at the end.
  const nextLamport = (now: number) => Math.max(lamportNow() + 1, now)
  const holds = (record: MessageRecord) =>
    messages.some(message => message.author === record.author && message.device === record.device && message.seq === record.seq)
  /** Written on this device. Our other devices number their messages separately. */
  const fromHere = (message: MessageRecord) => message.author === identity.id && message.device === identity.device
  const ownStream = streamOf({author: identity.id, device: identity.device})
  const ownSeq = () => messages.reduce((max, message) => (fromHere(message) ? Math.max(max, message.seq) : max), chat.ownSeqFloor ?? 0)

  // Files: the pictures that messages refer to travel separately. Whatever is missing is asked for, one
  // peer at a time, from whoever is connected; any member who holds a file hands it on.
  const heldFiles = new Set(await store.listFiles(chat.id))
  const asked = new Map<string, {peerId: string; at: number}>()
  const lacking = new Map<string, number>()
  let serving: Promise<void> = Promise.resolve()
  const publishFiles = () => handlers.onFiles?.(new Set(heldFiles))
  const missingFiles = () => {
    const missing = new Map<string, {size: number}>()
    for (const {content} of messages) if (content.type === 'image' && !heldFiles.has(content.hash)) missing.set(content.hash, content)
    // Profile photos too, but only the one each person is showing now.
    for (const {photo} of latestCards(messages).values()) if (photo && !heldFiles.has(photo.hash)) missing.set(photo.hash, photo)
    return missing
  }
  function fetchFiles() {
    if (closed || !wire || peers.length === 0) return
    const now = Date.now()
    for (const [hash, request] of asked) {
      if (now - request.at > FILE_TIMEOUT_MS || !peers.includes(request.peerId)) asked.delete(hash)
    }
    for (const hash of missingFiles().keys()) {
      if (asked.size >= MAX_FILE_REQUESTS) break
      if (asked.has(hash)) continue
      const peerId = peers.find(candidate => now - (lacking.get(`${hash}:${candidate}`) ?? -Infinity) > FILE_RETRY_MS)
      if (!peerId) continue
      asked.set(hash, {peerId, at: now})
      void wire.requestFile(hash, peerId).catch(() => asked.delete(hash))
    }
  }
  async function receiveFile(hash: string, data: Uint8Array | null, peerId: string) {
    if (asked.get(hash)?.peerId !== peerId) return
    asked.delete(hash)
    const wanted = missingFiles().get(hash)
    // Checked against the hash in the signed message, so it does not matter who passed the file on.
    const genuine = data && wanted && data.length === wanted.size && data.length <= MAX_FILE_BYTES && (await fileHash(data)) === hash
    if (genuine && !closed) {
      await store.putFile(chat.id, hash, data)
      heldFiles.add(hash)
      publishFiles()
    } else lacking.set(`${hash}:${peerId}`, Date.now())
    fetchFiles()
  }
  function serveFile(hash: string, peerId: string, via: Wire) {
    if (!/^[0-9a-f]{64}$/.test(hash)) return
    // One at a time, so several requests do not crowd out messages.
    serving = serving
      .then(async () => {
        if (wire !== via || !peers.includes(peerId)) return
        const data = heldFiles.has(hash) ? await store.getFile(chat.id, hash) : undefined
        await via.sendFile(hash, data ?? null, peerId)
      })
      .catch(() => {})
  }

  // Delivery: whoever receives messages replies at once with how many it now holds from their authors
  // (normally one author, the sender). That is how an author learns a message has arrived somewhere.
  // It is a small note, not the full account of everything held that sync exchanges.
  const undelivered = new Map<number, MessageRecord>()
  const noteDelivered = (have: VersionVector) => {
    const reached = have[ownStream] ?? 0
    const arrived = [...undelivered.values()].filter(record => record.seq <= reached)
    if (arrived.length === 0) return
    for (const record of arrived) undelivered.delete(record.seq)
    handlers.onDelivered?.(arrived)
  }
  const acks = new Map<string, {timer: ReturnType<typeof setTimeout>; streams: Set<string>}>()
  const acknowledge = (peerId: string, stream: string) => {
    const pending = acks.get(peerId)
    if (pending) return void pending.streams.add(stream)
    const streams = new Set([stream])
    const timer = setTimeout(() => {
      acks.delete(peerId)
      if (closed || !peers.includes(peerId)) return
      const held = versionVector(messages.filter(message => streams.has(streamOf(message))))
      if (Object.keys(held).length > 0) void wire?.sendAck(held, peerId).catch(() => {})
    }, ACK_DELAY_MS)
    acks.set(peerId, {timer, streams})
  }

  // The mailbox: our own messages are left with the relay as they are written, and whatever it holds
  // from others is taken in exactly as if a peer had sent it. Which of ours are known to be there is
  // remembered, so that anything written with no network is left there the next time the chat opens.
  let box: Mailbox | null = null
  let storedSeq = chat.storedSeq ?? 0
  const shelving = new Set<number>()
  const onShelf = new Set<number>()
  const ownHeld = () => messages.filter(fromHere).sort((a, b) => a.seq - b.seq)
  // The relay would already have thrown away anything older than this, so it is not worth leaving there.
  const freshFrom = Date.now() - KEEP_SECONDS * 1000
  /** The members a stored message is locked to: ourselves, and everyone whose invitation and key we have seen. */
  const recipients = (): Recipient[] => {
    const found = new Map<string, Uint8Array>([[identity.id, identity.dhPublic]])
    if (chat.peer) found.set(memberId(chat.peer.signPublic), chat.peer.dhPublic)
    for (const {author, content} of messages) if (content.type === 'profile' && roster.has(author)) found.set(author, content.dh)
    return [...found].map(([id, dhPublic]) => ({id, dhPublic}))
  }
  function shelve(record: MessageRecord) {
    const mailbox = box
    if (!mailbox) return
    // Only this device's messages are tracked; one written on another of ours is just left again.
    const tracked = fromHere(record)
    if (tracked && shelving.has(record.seq)) return
    if (tracked) shelving.add(record.seq)
    void sealForMembers(chat.id, record.envelope, recipients())
      .then(locked => mailbox.post(locked, record.sentAt))
      .catch(() => false)
      .then(kept => {
      if (!tracked) return
      shelving.delete(record.seq)
      if (!kept || closed) return
      onShelf.add(record.seq)
      // Remember how far our messages are all there, without a gap.
      let upTo = storedSeq
      for (const message of ownHeld()) {
        if (message.seq <= upTo) continue
        if (!onShelf.has(message.seq) && message.sentAt > freshFrom) break
        upTo = message.seq
      }
      if (upTo > storedSeq) {
        storedSeq = upTo
        void store.noteMailbox(chat.id, {storedSeq}).catch(() => {})
      }
    })
  }
  function openMailbox() {
    if (!options.mailbox || closed) return
    box = options.mailbox(keys.storeTopic, chat.collectedAt, {
      // Only what was locked to us opens; then it is checked like anything a peer sends.
      onEnvelope: stored =>
        void openAsMember(chat.id, stored, identity).then(envelope => {
          if (envelope && !closed) void receive(envelope)
        }),
      onCaughtUp: asOf => void store.noteMailbox(chat.id, {collectedAt: asOf}).catch(() => {})
    })
    // Ours that the relay may not have, oldest first.
    for (const record of ownHeld()) if (record.seq > storedSeq && record.sentAt > freshFrom) shelve(record)
  }

  /** Signs, stores, then sends a message of our own. Peers who are away get it by sync later. */
  async function post(content: Content): Promise<void> {
    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      const sentAt = Date.now()
      const message = {seq: ownSeq() + 1, lamport: nextLamport(sentAt), sentAt, content}
      const envelope = await sealEnvelope(context, identity, message)
      const record: MessageRecord = {...message, author: identity.id, device: identity.device, chatId: chat.id, receivedAt: message.sentAt, envelope}
      if (await store.addMessage(record)) {
        insert(record)
        undelivered.set(record.seq, record)
        shelve(record)
        await wire?.send(envelope).catch(() => {})
        return
      }
      // Another tab on this device used that sequence number first; pick up its messages and retry.
      messages = await store.listMessages(chat.id)
      publish()
    }
    throw new Error('could not allocate a sequence number')
  }

  async function keep(message: Message, envelope: Uint8Array) {
    const record: MessageRecord = {...message, chatId: chat.id, receivedAt: Date.now(), envelope}
    const isNew = await store.addMessage(record)
    // Already stored but not on screen: another session of this chat (a background sync, another tab)
    // stored it after we loaded the history. Without this it would stay hidden until a reload.
    if (!closed && (isNew || !holds(record))) insert(record)
    // Someone whose key we had not seen: leave our own introduction with the relay again, now locked to
    // them as well, so that they can learn our key from it even if we are never online together.
    if (isNew && !closed && record.content.type === 'profile' && record.author !== identity.id) {
      const own = messages.findLast(({author, content}) => author === identity.id && content.type === 'profile')
      if (own) shelve(own)
    }
    if (record.content.type === 'image' || record.content.type === 'card') fetchFiles()
  }

  /** Takes in a message from the network. Returns its stream, or null if it was not a genuine message. */
  async function receive(envelope: Uint8Array): Promise<string | null> {
    let stream: string | null = null
    try {
      const message = await openEnvelope(context, envelope)
      stream = streamOf(message)
      // A certificate proves itself, so it counts even if the message carrying it cannot be kept yet.
      const someoneNew = learnFrom(message.content)
      if (roster.has(message.author)) await keep(message, envelope)
      else held = [...held, {message, envelope}].slice(-MAX_HELD)
      if (!someoneNew) return stream
      const ready = held.filter(entry => roster.has(entry.message.author))
      held = held.filter(entry => !roster.has(entry.message.author))
      for (const entry of ready) await keep(entry.message, entry.envelope)
    } catch (error) {
      console.warn('dropped a message:', error instanceof Error ? error.message : error)
    }
    return stream
  }

  // Sends a peer everything they say they lack. Their vector is the only evidence of what they hold:
  // a message that was sent to them earlier may have gone into a connection that had quietly died.
  async function answerSync(value: unknown, peerId: string, via: Wire) {
    const have = parseVector(value)
    if (!have) return
    noteDelivered(have)
    const missing = messages.filter(message => message.seq > (have[streamOf(message)] ?? 0))
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
      onEnvelope: (envelope, peerId) =>
        void receive(envelope).then(stream => {
          if (stream && live()) acknowledge(peerId, stream)
        }),
      onAck: have => {
        const held = parseVector(have)
        if (held && live()) noteDelivered(held)
      },
      onSync: (have, peerId) =>
        void ready.then(via => {
          if (live()) void answerSync(have, peerId, via)
        }),
      onPeersChange: peerIds =>
        void ready.then(via => {
          if (!live()) return
          const newcomers = peerIds.filter(peerId => !peers.includes(peerId))
          if (newcomers.length > 0) clearTimeout(errorTimer)
          peers = peerIds
          handlers.onPeersChange(peerIds)
          if (peerIds.length > 0 && status === 'searching') setStatus('idle')
          for (const peerId of newcomers) void via.sendSync(versionVector(messages), peerId).catch(() => {})
          fetchFiles()
        }),
      onFileWanted: (hash, peerId) =>
        void ready.then(via => {
          if (live()) serveFile(hash, peerId, via)
        }),
      onFile: (hash, data, peerId) => {
        if (live()) void receiveFile(hash, data, peerId).catch(() => {})
      },
      expectsFile: (hash, byteLength, peerId) => live() && asked.get(hash)?.peerId === peerId && missingFiles().get(hash)?.size === byteLength,
      onError: message => {
        if (live()) reportUnlessSomeoneConnects(message)
      }
    })
    if (!live()) return void opened.leave().catch(() => {})
    wire = opened
    setStatus('searching')
    wireReady(opened)
  }

  /** Leaves the room and joins it afresh; used when the old connections are probably dead. */
  async function reconnect() {
    reconnecting = true
    setStatus('reconnecting')
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
  publishFiles()
  handlers.onStatus(status)
  // Not awaited: connecting can take seconds, and messages can be written and queued meanwhile.
  void openWire().catch(() => {
    setStatus('idle')
    handlers.onError("Couldn't connect to this chat.")
  })
  // Our "joined" message carries our certificates, so anyone who gets our messages can check we belong.
  // Posted again if an earlier one, from an older version of the app, went out without them.
  const introduced = messages.some(
    ({author, content}) =>
      author === identity.id && content.type === 'profile' && (chat.chain.length === 0 || (content.chain?.length ?? 0) > 0)
  )
  // And again if we have changed our name since: each member's latest is what they are called.
  const called = messages.findLast(({author, content}) => author === identity.id && content.type === 'profile')?.content
  if (!introduced || (called?.type === 'profile' && identity.name !== '' && called.name !== identity.name)) {
    await post({type: 'profile', name: identity.name, dh: identity.dhPublic, ...(chat.chain.length > 0 ? {chain: chat.chain} : {})})
  }

  /** Makes the card we show in this chat match what is wanted; null means show none. */
  async function shareCard(wanted: CardToShare | null) {
    const shown = messages.findLast(({author, content}) => author === identity.id && content.type === 'card')?.content
    const card: CardContent = wanted?.content ?? {type: 'card'}
    // Nothing shown and nothing to show; or already showing exactly this.
    if (shown?.type === 'card' ? sameCard(shown, card) : !wanted) return
    if (card.photo && wanted?.photoFile) {
      await store.putFile(chat.id, card.photo.hash, wanted.photoFile)
      heldFiles.add(card.photo.hash)
      publishFiles()
    }
    await post(card)
  }
  if (options.card !== undefined) await shareCard(options.card)
  openMailbox()

  // Catches anything missed in between, for example when not every pair of members is directly connected.
  const resync = setInterval(() => {
    if (peers.length > 0) void wire?.sendSync(versionVector(messages)).catch(() => {})
    fetchFiles()
  }, RESYNC_INTERVAL_MS)

  return {
    sendText: (text, replyTo) => post({type: 'text', text, ...(replyTo ? {replyTo} : {})}),
    postCert: cert => post({type: 'member-cert', cert}),
    postGroupInvite: invite => post(invite),
    rename: name => post({type: 'rename', name}),
    shareCard,
    edit: (target, text) => post({type: 'edit', target: {device: target.device, seq: target.seq}, text}),
    react: (target, emoji) => post({type: 'reaction', target, emoji}),
    note: content => post(content),
    async postImage(image, file) {
      await store.putFile(chat.id, image.hash, file)
      heldFiles.add(image.hash)
      publishFiles()
      await post(image)
    },
    async resume(awayMs) {
      if (closed || reconnecting || !wire) return
      if (peers.length === 0) {
        if (awayMs >= STALE_AFTER_MS) await reconnect()
        return
      }
      const current = wire
      setStatus('checking')
      const answers = await Promise.all(peers.map(peerId => current.ping(peerId).then(() => true, () => false)))
      if (closed || wire !== current) return
      if (answers.every(Boolean)) {
        setStatus('idle')
        void current.sendSync(versionVector(messages)).catch(() => {})
      } else await reconnect()
    },
    routes: async () => (await wire?.routes()) ?? [],
    async close() {
      closed = true
      clearInterval(resync)
      acks.forEach(({timer}) => clearTimeout(timer))
      clearTimeout(searchTimer)
      clearTimeout(errorTimer)
      box?.close()
      await wire?.leave().catch(() => {})
    }
  }
}
