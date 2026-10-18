// A standing invite: what lets whoever holds it join a group at any time, with nobody waiting at the
// other end. FOR TESTING. It exists so the app can be shown to people who are far away; the app's real
// invites only work face to face, while the inviter is showing the code. It travels sealed inside an
// invite left on the relay (remote-invite.ts), which expires and can be cancelled.
//
// How it works: the inviter makes a throwaway member, admits it with a certificate like any other,
// and puts that member's signing key in the link along with the chat's secret. Whoever opens the link
// uses the throwaway key to admit themselves. Their chain of certificates is then an ordinary one,
// founder to inviter to throwaway member to them, so no other device needs to know about any of this.
//
// What that means: whoever opens one holds a permanent key to the chat. They can join and read
// everything, and nothing here can take that back. Only people who turned on developer mode are offered
// the way to make one; any copy of the app can open one.
import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {createIdentity, MAX_NAME_LENGTH, type Identity} from './identity'
import {deriveChatKeys} from './keys'
import {issueCert, MAX_CHAIN_LENGTH, verifyChain} from './membership'
import type {ChatRecord} from './store'

const VERSION = 1
const DEV_SETTING = 'snrdlr.dev'

export type StandingInvite = {
  secret: Uint8Array
  founder: Uint8Array
  name: string
  /** The throwaway member's signing key. */
  key: Uint8Array
  /** Certificates from the founder down to the throwaway member. */
  chain: Uint8Array[]
}

/** Makes a way into a group we belong to. Each call makes a new throwaway member. */
export function makeStandingInvite(chat: ChatRecord, identity: Identity, now: number): Uint8Array {
  if (chat.kind !== 'group') throw new Error('only groups have standing invites')
  const throwaway = createIdentity()
  const chain = [...chat.chain, issueCert(chat.id, identity, throwaway, now)]
  return new Uint8Array(encode({v: VERSION, g: chat.secret, f: chat.context, n: chat.name, k: throwaway.signSecret, c: chain}))
}

export function openStandingInvite(bytes: Uint8Array): StandingInvite | null {
  try {
    // Decoded from a copy: the decoder leaves a property behind on the array it is given.
    const raw = decode(new Uint8Array(bytes)) as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null || raw.v !== VERSION) return null
    const {g, f, n, k, c} = raw
    const isKey = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === 32
    if (!isKey(g) || !isKey(f) || !isKey(k)) return null
    if (typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH) return null
    if (!Array.isArray(c) || c.length === 0 || c.length >= MAX_CHAIN_LENGTH || !c.every(cert => cert instanceof Uint8Array)) return null
    // Copies: the decoder may hand back views into its own buffer.
    return {secret: new Uint8Array(g), founder: new Uint8Array(f), name: n, key: new Uint8Array(k), chain: c.map(cert => new Uint8Array(cert))}
  } catch {
    return null
  }
}

/** Joins the group a standing invite leads to, by admitting ourselves with its key. Throws if the invite is not genuine. */
export function chatFromStandingInvite(invite: StandingInvite, identity: Identity, now: number): ChatRecord {
  const id = deriveChatKeys(invite.secret, invite.founder).roomId
  const throwaway = {signSecret: invite.key, signPublic: ed25519.getPublicKey(invite.key)}
  const chain = [...invite.chain, issueCert(id, throwaway, identity, now)]
  if (!verifyChain(id, invite.founder, chain, identity.signPublic)) throw new Error('standing invite does not lead to this chat')
  return {id, kind: 'group', secret: invite.secret, context: invite.founder, chain, name: invite.name, createdAt: now}
}

/** Whether this device is offered the tools meant for developing and demonstrating the app. */
export function devMode(): boolean {
  try {
    return localStorage.getItem(DEV_SETTING) === '1'
  } catch {
    return false
  }
}

/** Turns developer mode on or off when the address says so (`?dev=1` or `?dev=0`), then tidies the address. */
export function readDevSwitch(): void {
  const url = new URL(location.href)
  const wanted = url.searchParams.get('dev')
  if (wanted === null) return
  try {
    if (wanted === '1') localStorage.setItem(DEV_SETTING, '1')
    else localStorage.removeItem(DEV_SETTING)
  } catch {
    // Without storage there is nowhere to remember it.
  }
  url.searchParams.delete('dev')
  history.replaceState(null, '', url.pathname + url.search + url.hash)
}
