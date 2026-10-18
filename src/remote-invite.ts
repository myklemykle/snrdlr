// Invites for someone far away (developer mode, for now): a link that works until it expires, from a
// minute to a week, or until it is cancelled, with nobody needing to be online when it is opened.
//
// The link holds only a random seed. From it, the inviter and whoever opens the link both work out a
// topic on the relay's store and a key. The inviter leaves there, locked with that key, what a joiner
// needs: for a group, a standing invite (standing-invite.ts); for a direct chat, the inviter's public
// keys and name. The relay is asked to keep it only until the invite expires, and it carries a tag
// made from a cancel key that never leaves the inviter's devices, so cancelling deletes it from the
// relay at once (FORGET). After that the link opens nothing.
//
// A group link lets in everyone who opens it while it works. A direct-chat link makes one chat: the
// joiner makes it on their side and leaves an answer, sealed so that only the inviter can open it, under
// a second topic; the inviter's device makes the same chat when it sees the answer, whenever that is,
// and closes the invite.
//
// What cancelling cannot do: someone who already opened a group link holds the group's secret, as every
// member does. Cancelling stops new people; it removes nobody.
//
// The person's open invites are kept in this browser and shared with their other devices through
// their hidden chat (devices.ts), so any of them can see, use and cancel them.
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {decode, encode} from 'cbor-x'
import {concatBytes, fromBase64Url, toBase64Url, toHex, utf8} from './bytes'
import {MAX_NAME_LENGTH, type Identity} from './identity'
import type {OpenMailbox, RelayMailboxes} from './mailbox'
import {makeStandingInvite, openStandingInvite, type StandingInvite} from './standing-invite'
import {openAsMember, sealForMembers} from './store-seal'
import type {ChatRecord} from './store'

export const REMOTE_PREFIX = '#r='
export const MIN_LIFETIME_MS = 60_000
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000
// An answer to a direct-chat invite waits this long past the invite's end for an inviter who is away.
const ANSWER_KEEP_MS = 7 * 24 * 60 * 60_000
// Closed and expired invites are remembered this long, so a device that was away hears they are over.
const FORGET_AFTER_MS = 24 * 60 * 60_000
const LOOK_MS = 15_000
const ANSWER_POLL_MS = 30_000
const FORGET_TRIES_MS = 10_000
const VERSION = 1
const LIST = 'snrdlr.remoteInvites'

export type RemoteInvite = {
  /** In base64url: what the link holds. */
  seed: string
  /** In hex: shown to the relay to cancel. Never leaves the person's devices. */
  cancel: string
  kind: 'group' | 'dm'
  /** The group it lets people into. */
  chatId?: string
  /** What the person sees it as: the group's name, or whom the direct chat is for. */
  name: string
  createdAt: number
  expiresAt: number
  /** When it was cancelled, or a direct-chat invite was used. It works no longer. */
  closedAt?: number
}

/** What opening a link finds. */
export type Opened =
  | {kind: 'group'; standing: StandingInvite; expiresAt: number}
  | {kind: 'dm'; inviter: {signPublic: Uint8Array; dhPublic: Uint8Array}; name: string; expiresAt: number; used: boolean}

/** Someone who answered a direct-chat invite. */
export type Answer = {signPublic: Uint8Array; dhPublic: Uint8Array; name: string}

const derive = (seed: Uint8Array, label: string) => hkdf(sha256, seed, undefined, utf8(`snrdlr/v1/remote-invite/${label}`), 32)
const inviteTopic = (seed: Uint8Array) => toHex(derive(seed, 'topic'))
const answerTopic = (seed: Uint8Array) => toHex(derive(seed, 'answer'))
const isKey = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === 32

async function lock(seed: Uint8Array, message: unknown): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(derive(seed, 'key')), 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, key, new Uint8Array(encode(message)))
  return concatBytes(nonce, new Uint8Array(sealed))
}

async function unlock(seed: Uint8Array, bytes: Uint8Array): Promise<Record<string, unknown> | null> {
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(derive(seed, 'key')), 'AES-GCM', false, ['decrypt'])
    const opened = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(0, 12)}, key, bytes.slice(12))
    const message = decode(new Uint8Array(opened)) as unknown
    return typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const remoteFragment = (invite: RemoteInvite) => REMOTE_PREFIX + invite.seed
export const isRemoteFragment = (fragment: string) => fragment.startsWith(REMOTE_PREFIX)

/** The seed in a link, or null if it is not one. */
export function seedFromFragment(fragment: string): Uint8Array | null {
  if (!isRemoteFragment(fragment)) return null
  try {
    const seed = fromBase64Url(fragment.slice(REMOTE_PREFIX.length))
    return seed.length === 32 ? seed : null
  } catch {
    return null
  }
}

/**
 * Makes an invite and leaves it with the relay: into `group`, or, without one, for a direct chat with
 * us. Null if the relay could not be reached.
 */
export async function makeRemoteInvite(
  open: OpenMailbox,
  identity: Identity,
  group: ChatRecord | null,
  lifetimeMs: number,
  now: number
): Promise<RemoteInvite | null> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const cancel = crypto.getRandomValues(new Uint8Array(32))
  const expiresAt = now + Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, lifetimeMs))
  const body = group
    ? {v: VERSION, t: 'g', x: expiresAt, s: makeStandingInvite(group, identity, now)}
    : {v: VERSION, t: 'd', x: expiresAt, k: identity.signPublic, h: identity.dhPublic, n: identity.name}
  const sealed = await lock(seed, body)
  // Only for leaving it: from now on, so nothing is sent back.
  const box = open(inviteTopic(seed), now, {onEnvelope: () => {}})
  try {
    if (!(await box.post(sealed, now, undefined, {expiresAt, forget: toHex(sha256(cancel))}))) return null
  } finally {
    box.close()
  }
  return {
    seed: toBase64Url(seed),
    cancel: toHex(cancel),
    kind: group ? 'group' : 'dm',
    ...(group ? {chatId: group.id} : {}),
    name: group ? group.name : 'Direct chat with me',
    createdAt: now,
    expiresAt
  }
}

/** Everything the relay holds under a topic: resolves once it has all come. */
function collect(open: OpenMailbox, topic: string, timeoutMs: number): Promise<Uint8Array[] | null> {
  return new Promise(resolve => {
    const found: Uint8Array[] = []
    let done = false
    const finish = (result: Uint8Array[] | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      box.close()
      resolve(result)
    }
    const box = open(topic, undefined, {onEnvelope: envelope => found.push(envelope), onCaughtUp: () => finish(found)})
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}

/**
 * Opens the invite a link leads to. Null if it is over: expired, cancelled, or never there. Throws if
 * the relay could not be asked.
 */
export async function openRemoteInvite(open: OpenMailbox, seed: Uint8Array, now: number, timeoutMs = LOOK_MS): Promise<Opened | null> {
  const held = await collect(open, inviteTopic(seed), timeoutMs)
  if (!held) throw new Error('the relay did not answer')
  for (const envelope of held) {
    const body = await unlock(seed, envelope)
    if (!body || body.v !== VERSION || !Number.isSafeInteger(body.x)) continue
    const expiresAt = body.x as number
    if (expiresAt <= now) return null
    if (body.t === 'g' && body.s instanceof Uint8Array) {
      const standing = openStandingInvite(body.s)
      if (standing) return {kind: 'group', standing, expiresAt}
    } else if (body.t === 'd' && isKey(body.k) && isKey(body.h) && typeof body.n === 'string' && body.n.length <= MAX_NAME_LENGTH) {
      // Someone else got there first: a direct-chat invite makes one chat.
      const answers = await collect(open, answerTopic(seed), timeoutMs)
      if (!answers) throw new Error('the relay did not answer')
      return {kind: 'dm', inviter: {signPublic: new Uint8Array(body.k), dhPublic: new Uint8Array(body.h)}, name: body.n, expiresAt, used: answers.length > 0}
    }
  }
  return null
}

/** Answers a direct-chat invite, so the inviter's device makes the chat too. True once the relay has it. */
export async function answerRemoteInvite(open: OpenMailbox, seed: Uint8Array, opened: Opened & {kind: 'dm'}, identity: Identity, now: number): Promise<boolean> {
  const topic = answerTopic(seed)
  const answer = new Uint8Array(encode({k: identity.signPublic, h: identity.dhPublic, n: identity.name}))
  const sealed = await sealForMembers(topic, answer, [{id: topic, dhPublic: opened.inviter.dhPublic}])
  const box = open(topic, now, {onEnvelope: () => {}})
  try {
    return await box.post(sealed, now, undefined, {expiresAt: opened.expiresAt + ANSWER_KEEP_MS})
  } finally {
    box.close()
  }
}

/**
 * Calls back with each answer to one of our direct-chat invites, until stopped. It looks now and then
 * rather than staying subscribed, because the relay allows a connection only a few subscriptions and
 * the chats need them.
 */
export function watchAnswers(open: OpenMailbox, invite: RemoteInvite, identity: Identity, onAnswer: (answer: Answer) => void, pollMs = ANSWER_POLL_MS): () => void {
  const topic = answerTopic(fromBase64Url(invite.seed))
  const heard = new Set<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const look = async () => {
    for (const envelope of (await collect(open, topic, LOOK_MS)) ?? []) {
      const opened = await openAsMember(topic, envelope, {id: topic, dhSecret: identity.dhSecret})
      if (!opened || stopped) continue
      try {
        const {k, h, n} = decode(opened) as Record<string, unknown>
        if (!isKey(k) || !isKey(h) || typeof n !== 'string' || n.length > MAX_NAME_LENGTH || heard.has(toHex(k))) continue
        heard.add(toHex(k))
        onAnswer({signPublic: new Uint8Array(k), dhPublic: new Uint8Array(h), name: n})
      } catch {
        // Not an answer.
      }
    }
    if (!stopped) timer = setTimeout(() => void look(), pollMs)
  }
  void look()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Has the relay delete an invite now. True once the relay no longer holds it; false if it could not be
 * reached, or still has it.
 */
export async function forgetRemoteInvite(mailboxes: RelayMailboxes, invite: RemoteInvite): Promise<boolean> {
  const topic = inviteTopic(fromBase64Url(invite.seed))
  // Opening a mailbox brings the connection up; FORGET goes on it once it is.
  const box = mailboxes(topic, Date.now(), {onEnvelope: () => {}})
  const started = Date.now()
  let said = false
  while (!(said = mailboxes.say(['FORGET', topic, invite.cancel])) && Date.now() - started < FORGET_TRIES_MS) {
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  // Asked for after FORGET, on the same connection, so the answer comes after it was dealt with.
  const left = said ? await collect(mailboxes, topic, LOOK_MS) : null
  box.close()
  return left !== null && left.length === 0
}

/** Whether an invite still works, as far as this device knows. */
export const isOpen = (invite: RemoteInvite, now: number) => invite.closedAt === undefined && invite.expiresAt > now

function isInvite(value: unknown): value is RemoteInvite {
  if (typeof value !== 'object' || value === null) return false
  const {seed, cancel, kind, chatId, name, createdAt, expiresAt, closedAt} = value as Record<string, unknown>
  return (
    typeof seed === 'string' &&
    seedFromFragment(REMOTE_PREFIX + seed) !== null &&
    typeof cancel === 'string' &&
    /^[0-9a-f]{64}$/.test(cancel) &&
    (kind === 'group' || kind === 'dm') &&
    (chatId === undefined || typeof chatId === 'string') &&
    typeof name === 'string' &&
    Number.isSafeInteger(createdAt) &&
    Number.isSafeInteger(expiresAt) &&
    (closedAt === undefined || Number.isSafeInteger(closedAt))
  )
}

/**
 * Two devices' lists as one. An invite closed on either is closed; those long over are dropped. The
 * same lists always give the same result, so devices that have heard each other stop repeating it.
 */
export function mergeInvites(here: RemoteInvite[], there: RemoteInvite[], now: number): RemoteInvite[] {
  const merged = new Map<string, RemoteInvite>()
  for (const invite of [...here, ...there]) {
    if (!isInvite(invite)) continue
    const seen = merged.get(invite.seed)
    const closedAt = [seen?.closedAt, invite.closedAt].filter((at): at is number => at !== undefined)
    merged.set(invite.seed, {...(seen ?? invite), ...(closedAt.length ? {closedAt: Math.min(...closedAt)} : {})})
  }
  return [...merged.values()]
    .filter(invite => Math.min(invite.expiresAt, invite.closedAt ?? Infinity) + FORGET_AFTER_MS > now)
    .sort((a, b) => a.createdAt - b.createdAt || (a.seed < b.seed ? -1 : 1))
}

export const sameInvites = (a: RemoteInvite[], b: RemoteInvite[]) => JSON.stringify(a) === JSON.stringify(b)

export function parseInvites(text: string): RemoteInvite[] {
  try {
    const list = JSON.parse(text) as unknown
    return Array.isArray(list) ? list.filter(isInvite) : []
  } catch {
    return []
  }
}

const listeners = new Set<() => void>()

export function loadInvites(): RemoteInvite[] {
  try {
    return parseInvites(localStorage.getItem(LIST) ?? '[]')
  } catch {
    return []
  }
}

export function saveInvites(list: RemoteInvite[]): void {
  try {
    localStorage.setItem(LIST, JSON.stringify(list))
  } catch {
    // Without storage, the list lasts as long as the page.
  }
  listeners.forEach(listener => listener())
}

/** Calls back whenever the list changes, here or because another device said so. */
export function onInvitesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const addInvite = (invite: RemoteInvite, now = Date.now()) => saveInvites(mergeInvites(loadInvites(), [invite], now))

export function closeInvite(seed: string, now = Date.now()): void {
  saveInvites(mergeInvites(loadInvites().map(invite => (invite.seed === seed && invite.closedAt === undefined ? {...invite, closedAt: now} : invite)), [], now))
}
