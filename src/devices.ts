// One person on several devices. Every device of a person holds the same keys (identity.ts) and numbers
// its own messages (envelope.ts). What keeps the devices in step is the person's own hidden chat, whose
// only members are those devices: each one says there which chats it holds and which it has left, and
// each takes up what the others say. It is an ordinary chat in every other way, but its notes travel
// through the relay's store (its devices do not announce themselves to each other; see transport.ts), so
// it also keeps a copy of the chat list that a device can come back to. Each device also says there how far
// it has read each chat, so that what was read on one is not unread on the others.
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {claimChat, isOnScreen, unclaimChat, type ConnectFor} from './background'
import {bytesEqual, concatBytes, utf8} from './bytes'
import {dmContext} from './chats'
import {streamOf, writtenAfter, type ChatHeldContent, type ChatReadContent, type ReadMarks} from './envelope'
import type {Identity} from './identity'
import {deriveChatKeys} from './keys'
import type {OpenMailbox} from './mailbox'
import {verifyChain} from './membership'
import {uniqueChatName} from './names'
import {openSession, type Session} from './session'
import {mergeMarks, type ChatRecord, type MessageRecord, type Store} from './store'

/** A chat is announced again after this long, so that the relay, which forgets after 30 days, still has it. */
const REFRESH_MS = 20 * 24 * 3600_000
const POLL_MS = 4000

type Note = ChatHeldContent | ChatReadContent | {type: 'chat-left'; id: string}

/** The person's own hidden chat. Every device of theirs works out the same one from the keys they share. */
export function selfChat(identity: Identity): ChatRecord {
  const context = identity.signPublic
  const secret = hkdf(sha256, concatBytes(identity.signSecret, identity.dhSecret), undefined, utf8('snrdlr/v1/self'), 32)
  return {id: deriveChatKeys(secret, context).roomId, kind: 'self', secret, context, chain: [], name: 'Your devices', createdAt: 0}
}

const chatIdOf = (note: ChatHeldContent) => deriveChatKeys(note.secret, note.context).roomId

/** What one device tells the others about a chat it holds. */
export function noteFor(chat: ChatRecord): ChatHeldContent {
  if (chat.kind === 'self') throw new Error('the hidden chat is not announced')
  return {
    type: 'chat-held',
    kind: chat.kind,
    secret: chat.secret,
    context: chat.context,
    chain: chat.chain,
    name: chat.name,
    ...(chat.peer ? {peer: chat.peer} : {})
  }
}

/** For each chat mentioned in the hidden chat, the latest that any of the person's devices said about it. */
export function latestNotes(messages: MessageRecord[], selfId: string): Map<string, {message: MessageRecord; note: ChatHeldContent | {type: 'chat-left'; id: string}}> {
  const latest = new Map<string, {message: MessageRecord; note: ChatHeldContent | {type: 'chat-left'; id: string}}>()
  for (const message of messages) {
    const {content} = message
    if (message.author !== selfId || (content.type !== 'chat-held' && content.type !== 'chat-left')) continue
    const id = content.type === 'chat-held' ? chatIdOf(content) : content.id
    const earlier = latest.get(id)
    if (!earlier || writtenAfter(message, earlier.message)) latest.set(id, {message, note: content})
  }
  return latest
}

/** For each chat, how far the person's devices together have said they have read it. */
export function latestReads(messages: MessageRecord[], selfId: string): Map<string, ReadMarks> {
  const reads = new Map<string, ReadMarks>()
  for (const {author, content} of messages) {
    if (author === selfId && content.type === 'chat-read') reads.set(content.id, mergeMarks(reads.get(content.id) ?? {}, content.seen))
  }
  return reads
}

/** The chat a note describes, as this device will hold it; null unless it really is a chat this person is in. */
export function chatFromNote(note: ChatHeldContent, identity: Identity, taken: string[], now: number): ChatRecord | null {
  const id = chatIdOf(note)
  if (note.kind === 'group') {
    const founded = bytesEqual(note.context, identity.signPublic) && note.chain.length === 0
    if (!founded && !verifyChain(id, note.context, note.chain, identity.signPublic)) return null
  } else {
    if (!note.peer) return null
    try {
      if (!bytesEqual(note.context, dmContext(identity.signPublic, note.peer.signPublic))) return null
    } catch {
      return null
    }
  }
  return {
    id,
    kind: note.kind,
    secret: note.secret,
    context: note.context,
    chain: note.chain,
    ...(note.peer ? {peer: note.peer} : {}),
    name: uniqueChatName(note.name, taken),
    createdAt: now,
    historyBefore: now
  }
}

/**
 * Brings this device's chats into line with what the person's devices have said, and says what this
 * device holds that they have not heard of. Returns true if this device's chats changed.
 */
export async function tendChats(store: Store, identity: Identity, messages: MessageRecord[], say: (note: Note) => Promise<void>, now = Date.now()) {
  const latest = latestNotes(messages, identity.id)
  const local = new Map((await store.listChats()).map(chat => [chat.id, chat]))
  let changed = false
  for (const [id, {message, note}] of latest) {
    const here = local.get(id)
    if (note.type === 'chat-held' && !here) {
      // Left here since another device last spoke of it: tell them.
      const leftAt = await store.leftAt(id)
      if (leftAt !== undefined && leftAt > message.sentAt) {
        await say({type: 'chat-left', id})
        continue
      }
      const chat = chatFromNote(note, identity, [...local.values()].map(chat => chat.name), now)
      if (!chat) continue
      local.set(id, await store.saveChat(chat))
      changed = true
    } else if (note.type === 'chat-left' && here && here.createdAt <= message.sentAt) {
      // Left on another device. A chat on screen here is let go once it is closed.
      if (isOnScreen(id)) continue
      await claimChat(id)
      try {
        await store.deleteChat(id, identity)
      } finally {
        unclaimChat(id)
      }
      local.delete(id)
      changed = true
    }
  }
  // Ours that the others have not heard of, or were told some time ago.
  for (const chat of local.values()) {
    const said = latest.get(chat.id)
    if (!said || said.note.type === 'chat-left' || now - said.message.sentAt > REFRESH_MS) await say(noteFor(chat))
  }
  // How far each chat has been read, here and on the others.
  const reads = latestReads(messages, identity.id)
  for (const chat of local.values()) {
    // Read here before reading was marked this way: worked out once from when it was read.
    const here = chat.readMarks ?? (chat.readAt === undefined ? {} : ((await store.markRead(chat.id, chat.readAt)) ?? {}))
    const there = reads.get(chat.id) ?? {}
    if (mergeMarks(here, there) !== here) {
      await store.markReadElsewhere(chat.id, there)
      changed = true
    }
    if (mergeMarks(there, here) !== there) await say({type: 'chat-read', id: chat.id, seen: mergeMarks(there, here)})
  }
  return changed
}

// Which of the person's devices this one has already told them about, so that a device added by someone
// else does not go unnoticed. Kept per device, in the browser.
const KNOWN_DEVICES = 'snrdlr.devices'

type Known = {since: number; streams: string[]}

function readKnown(): Known | null {
  try {
    const known = JSON.parse(localStorage.getItem(KNOWN_DEVICES) ?? 'null') as Known | null
    return known && Number.isFinite(known.since) && Array.isArray(known.streams) ? known : null
  } catch {
    return null
  }
}
function writeKnown(known: Known) {
  try {
    localStorage.setItem(KNOWN_DEVICES, JSON.stringify(known))
  } catch {
    // Then the person may be told again.
  }
}

/** Called when this device lets another in: the person knows about that one already. */
export const noteAddedHere = (stream: string) => acknowledgeDevice(stream)

/** A device of the person's that this one has not told them about: when it first spoke. */
export type NewDevice = {stream: string; at: number}

/**
 * The person's devices that first appeared after this device began keeping count, and that the person
 * has not been told about. A device let in from this one does not count.
 */
export function newDevices(messages: MessageRecord[], identity: Identity, now = Date.now()): NewDevice[] {
  const first = new Map<string, number>()
  for (const message of messages) {
    if (message.author !== identity.id) continue
    const stream = streamOf(message)
    first.set(stream, Math.min(first.get(stream) ?? Infinity, message.sentAt))
  }
  first.delete(streamOf({author: identity.id, device: identity.device}))
  let known = readKnown()
  if (!known) writeKnown((known = {since: now, streams: [...first.keys()]}))
  return [...first]
    .filter(([stream, at]) => !known.streams.includes(stream) && at >= known.since)
    .map(([stream, at]) => ({stream, at}))
}

/** The person has seen the notice about a device. */
export function acknowledgeDevice(stream: string) {
  // Counting starts now if it has not already: a device that was there before is not news.
  const known = readKnown() ?? {since: Date.now(), streams: []}
  if (!known.streams.includes(stream)) writeKnown({...known, streams: [...known.streams, stream]})
}

const deviceListeners = new Set<(news: NewDevice[]) => void>()
let latestNews: NewDevice[] = []

/** Calls back with the devices the person should be told about, now and whenever that changes. */
export function onNewDevices(listener: (news: NewDevice[]) => void): () => void {
  deviceListeners.add(listener)
  listener(latestNews)
  return () => deviceListeners.delete(listener)
}

function tellNews(news: NewDevice[]) {
  if (news.map(entry => entry.stream).join() === latestNews.map(entry => entry.stream).join()) return
  latestNews = news
  deviceListeners.forEach(listener => listener(news))
}

const listeners = new Set<() => void>()

/** Calls back whenever chats were added or removed here because of something another device said. */
export function onChatsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Keeps the hidden chat open, and this device's chats in step with the person's others, until stopped. */
export function startSelfSync(options: {store: Store; identity: Identity; connectFor: ConnectFor; mailbox?: OpenMailbox; pollMs?: number}): () => Promise<void> {
  const {store, identity} = options
  let session: Session | null = null
  let messages: MessageRecord[] = []
  let stopped = false
  let tending = false
  let again = false
  let hiddenAt: number | null = null

  const tend = async () => {
    const current = session
    if (!current || stopped) return
    if (tending) return void (again = true)
    tending = true
    try {
      if (await tendChats(store, identity, messages, note => current.note(note))) listeners.forEach(listener => listener())
    } catch {
      // Tried again at the next change or check.
    } finally {
      tending = false
      if (again) {
        again = false
        void tend()
      }
    }
  }

  const onVisibility = () => {
    if (document.hidden) hiddenAt = Date.now()
    else {
      void session?.resume(hiddenAt === null ? 0 : Date.now() - hiddenAt)
      hiddenAt = null
    }
  }
  const opened = (async () => {
    const chat = await store.saveChat(selfChat(identity))
    const open = await openSession({
      chat,
      identity,
      store,
      mailbox: options.mailbox,
      connect: options.connectFor(chat),
      handlers: {
        onMessages: next => {
          messages = next
          tellNews(newDevices(next, identity))
          void tend()
        },
        onStatus: () => {},
        onPeersChange: () => {},
        onError: () => {}
      }
    })
    if (stopped) return void (await open.close())
    session = open
    void tend()
  })().catch(() => {})
  // Chats joined, started or left here are picked up by looking now and then.
  const timer = setInterval(() => void tend(), options.pollMs ?? POLL_MS)
  globalThis.document?.addEventListener('visibilitychange', onVisibility)

  return async () => {
    stopped = true
    clearInterval(timer)
    globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    await opened
    await session?.close()
  }
}
