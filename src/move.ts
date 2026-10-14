// Moving house: carrying a person's keys and chats from the browser into the installed app. On an
// iPhone the two keep separate storage, so "Add to Home Screen" starts the installed app empty. The
// person copies a code out of the browser and pastes it into the installed app.
//
// The code holds the keys themselves. Message history is not in it; that comes back from the other
// members' devices, as it does for anyone who was away.
import {decode, encode} from 'cbor-x'
import {fromBase64Url, toBase64Url} from './bytes'
import {admit} from './gate'
import type {IdentitySecrets} from './identity'
import type {ChatRecord, Store} from './store'

const PREFIX = 'snrdlr-move1.'
const MOVED = 'snrdlr.moved'
// What comes along besides keys and chats: choices that would otherwise have to be made again. The
// profile's photo stays behind with its file, and can be chosen again.
const SETTINGS = [/^snrdlr\.profile$/, /^snrdlr\.soundSet$/, /^snrdlr\.soundVolume\./, /^snrdlr\.recentEmoji$/]

type Moving = {
  identity: IdentitySecrets
  /** Each chat, with how far our own numbering had got in it, so the installed app carries on from there. */
  chats: ChatRecord[]
  settings: Record<string, string>
}

const isBytes = (value: unknown, length?: number): value is Uint8Array => value instanceof Uint8Array && (length === undefined || value.length === length)

/** Everything the installed app needs, as one line of text to copy. */
export async function packMove(store: Store, identity: IdentitySecrets & {id: string}): Promise<string> {
  const chats: ChatRecord[] = []
  for (const chat of await store.listChats()) {
    const ownSeq = (await store.listMessages(chat.id)).reduce((max, message) => (message.author === identity.id && message.device === identity.device ? Math.max(max, message.seq) : max), chat.ownSeqFloor ?? 0)
    const {readAt: _readAt, ...kept} = chat
    chats.push({...kept, ownSeqFloor: ownSeq})
  }
  const settings: Record<string, string> = {}
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!
      if (!SETTINGS.some(pattern => pattern.test(key))) continue
      let value = localStorage.getItem(key)!
      if (key === 'snrdlr.profile') value = JSON.stringify({...JSON.parse(value), photo: undefined})
      settings[key] = value
    }
  } catch {
    // The settings are a convenience; the keys and chats are what matter.
  }
  const {name, signSecret, dhSecret} = identity
  return PREFIX + toBase64Url(new Uint8Array(encode({i: {name, signSecret, dhSecret}, c: chats, s: settings})))
}

/** Reads a pasted code. Throws if it is not one, or is damaged. */
export function unpackMove(text: string): Moving {
  const code = text.trim()
  if (!code.startsWith(PREFIX)) throw new Error('not a move code')
  const {i, c, s} = decode(fromBase64Url(code.slice(PREFIX.length))) as {i?: Partial<IdentitySecrets>; c?: unknown; s?: unknown}
  if (!i || typeof i.name !== 'string' || i.name === '' || !isBytes(i.signSecret, 32) || !isBytes(i.dhSecret, 32)) throw new Error('bad move code')
  if (!Array.isArray(c)) throw new Error('bad move code')
  const chats = c.map((chat: Partial<ChatRecord>): ChatRecord => {
    const sound =
      typeof chat.id === 'string' &&
      (chat.kind === 'group' || chat.kind === 'dm') &&
      isBytes(chat.secret) &&
      isBytes(chat.context) &&
      Array.isArray(chat.chain) &&
      chat.chain.every(cert => isBytes(cert)) &&
      typeof chat.name === 'string' &&
      typeof chat.createdAt === 'number' &&
      Number.isSafeInteger(chat.ownSeqFloor) &&
      (chat.peer === undefined || (isBytes(chat.peer.signPublic, 32) && isBytes(chat.peer.dhPublic, 32)))
    if (!sound) throw new Error('bad move code')
    return chat as ChatRecord
  })
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries((s ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string' && SETTINGS.some(pattern => pattern.test(key))) settings[key] = value
  }
  return {identity: {name: i.name, signSecret: i.signSecret, dhSecret: i.dhSecret}, chats, settings}
}

/** Makes this (empty) copy of the app the person described by the code. Refuses if there are chats here already. */
export async function applyMove(store: Store, moving: Moving): Promise<void> {
  if ((await store.listChats()).length > 0) throw new Error('already in use')
  await store.saveIdentity(moving.identity)
  for (const chat of moving.chats) await store.saveChat(chat)
  try {
    for (const [key, value] of Object.entries(moving.settings)) localStorage.setItem(key, value)
  } catch {
    // As when packing.
  }
  admit()
}

/**
 * Whether this browser's copy has been moved out. Two copies of one person must never both be in use:
 * they would number their messages the same, and other members would keep only one of each pair.
 */
export function movedOut(): boolean {
  try {
    return localStorage.getItem(MOVED) === '1'
  } catch {
    return false
  }
}

export function setMovedOut(moved: boolean): void {
  try {
    if (moved) localStorage.setItem(MOVED, '1')
    else localStorage.removeItem(MOVED)
  } catch {
    // Without storage there is nothing here to move.
  }
}
