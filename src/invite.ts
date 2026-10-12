// Invites that only work while the inviter is showing them.
//
// The QR code carries a random one-time token and the inviter's public key, and nothing about the chat.
// The inviter's app waits in a temporary room derived from the token. A joiner who connects there sends
// a signed request naming their keys, and is sent back a signed "grant": the chat's secret and the
// certificates that make them a member. When the inviter closes the invite, their app leaves the room
// and forgets the token, so an old code leads nowhere and reveals nothing.
import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {concatBytes, fromBase64Url, toBase64Url, utf8} from './bytes'
import {MAX_NAME_LENGTH} from './identity'
import {SECRET_BYTES} from './keys'
import {MAX_CHAIN_LENGTH} from './membership'

export const INVITE_VERSION = 3
const FRAGMENT_PREFIX = '#i='

export type Invite = {
  /** Random; names the temporary room and is forgotten when the invite closes. */
  token: Uint8Array
  /** The inviter's signing public key, so the joiner can tell the grant came from them. */
  inviter: Uint8Array
}

/** What a joiner tells the inviter: the keys to admit, and their name if they have chosen one yet. */
export type JoinRequest = {signPublic: Uint8Array; dhPublic: Uint8Array; name: string}

/** What a joiner receives: enough to enter the chat and prove they belong. */
export type Grant =
  /** Membership of a group: its secret, and certificates from its founder down to the joiner. */
  | {kind: 'group'; secret: Uint8Array; name: string; founder: Uint8Array; chain: Uint8Array[]}
  /** A direct chat with the inviter: no secret travels; both sides derive it from each other's keys. */
  | {kind: 'dm'; dhPublic: Uint8Array; name: string}

type Signer = {signSecret: Uint8Array; signPublic: Uint8Array}

const isKey = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === 32
const isSignature = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === 64

function verify(signature: Uint8Array, message: Uint8Array, key: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, key)
  } catch {
    // An invalid key or signature encoding is just a failed verification.
    return false
  }
}

export function createInvite(inviter: Signer): Invite {
  return {token: crypto.getRandomValues(new Uint8Array(SECRET_BYTES)), inviter: inviter.signPublic}
}

export function encodeInvite(invite: Invite): string {
  return toBase64Url(encode({v: INVITE_VERSION, t: invite.token, k: invite.inviter}))
}

export function decodeInvite(payload: string): Invite {
  const raw = decode(fromBase64Url(payload))
  if (typeof raw !== 'object' || raw === null) throw new Error('malformed invite')
  const {v, t, k} = raw as Record<string, unknown>
  if (v !== INVITE_VERSION) throw new Error(`unsupported invite version: ${String(v)}`)
  if (!(t instanceof Uint8Array) || t.length !== SECRET_BYTES) throw new Error('malformed invite token')
  if (!isKey(k)) throw new Error('malformed inviter key')
  // Copy: cbor-x may hand back views into its decode buffer.
  return {token: new Uint8Array(t), inviter: new Uint8Array(k)}
}

/** The invite rides in the URL fragment, which browsers never send to the server. */
export function inviteToFragment(invite: Invite): string {
  return FRAGMENT_PREFIX + encodeInvite(invite)
}

export const isInviteFragment = (fragment: string) => fragment.startsWith(FRAGMENT_PREFIX)

export function inviteFromFragment(fragment: string): Invite | null {
  if (!isInviteFragment(fragment)) return null
  try {
    return decodeInvite(fragment.slice(FRAGMENT_PREFIX.length))
  } catch {
    return null
  }
}

// Fixed-length fields first, so each concatenation is unambiguous.
const requestBytes = (token: Uint8Array, request: JoinRequest) =>
  concatBytes(utf8('snrdlr/v1/join\0'), token, request.signPublic, request.dhPublic, utf8(request.name))

/** The joiner's request. Signing it shows the signing key is theirs and the X25519 key goes with it. */
export function sealJoinRequest(joiner: Signer & {dhPublic: Uint8Array; name: string}, invite: Invite): Uint8Array {
  const request = {signPublic: joiner.signPublic, dhPublic: joiner.dhPublic, name: joiner.name}
  const signature = ed25519.sign(requestBytes(invite.token, request), joiner.signSecret)
  return new Uint8Array(encode({k: request.signPublic, d: request.dhPublic, n: request.name, s: signature}))
}

export function openJoinRequest(invite: Invite, sealed: Uint8Array): JoinRequest {
  const raw = decode(sealed) as Record<string, unknown> | null
  if (typeof raw !== 'object' || raw === null) throw new Error('malformed join request')
  const {k, d, n, s} = raw
  if (!isKey(k) || !isKey(d) || !isSignature(s)) throw new Error('malformed join request')
  if (typeof n !== 'string' || n.length > MAX_NAME_LENGTH) throw new Error('malformed join request')
  const request = {signPublic: new Uint8Array(k), dhPublic: new Uint8Array(d), name: n}
  if (!verify(s, requestBytes(invite.token, request), request.signPublic)) throw new Error('join request is not signed by its key')
  return request
}

const grantBytes = (token: Uint8Array, body: Uint8Array) => concatBytes(utf8('snrdlr/v1/grant\0'), token, body)

/** Signs the grant for this one invite. Signing over the token stops a grant being reused for another. */
export function sealGrant(inviter: Signer, invite: Invite, grant: Grant): Uint8Array {
  // The signed body travels as bytes, so verifying never depends on re-encoding it identically.
  const body = new Uint8Array(
    encode(
      grant.kind === 'dm'
        ? {t: 'dm', d: grant.dhPublic, n: grant.name}
        : {t: 'group', g: grant.secret, n: grant.name, f: grant.founder, c: grant.chain}
    )
  )
  const signature = ed25519.sign(grantBytes(invite.token, body), inviter.signSecret)
  return new Uint8Array(encode({b: body, s: signature}))
}

/** Checks a grant came from the person named in the invite. Throws otherwise. */
export function openGrant(invite: Invite, sealed: Uint8Array): Grant {
  const outer = decode(sealed) as Record<string, unknown> | null
  if (typeof outer !== 'object' || outer === null) throw new Error('malformed grant')
  const {b, s} = outer
  if (!(b instanceof Uint8Array) || !isSignature(s)) throw new Error('malformed grant')
  if (!verify(s, grantBytes(invite.token, b), invite.inviter)) throw new Error('grant was not signed by the inviter')

  const body = decode(b) as Record<string, unknown> | null
  if (typeof body !== 'object' || body === null) throw new Error('malformed grant body')
  const {t, g, n, f, c, d} = body
  if (typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH) throw new Error('malformed grant name')
  if (t === 'dm') {
    if (!isKey(d)) throw new Error('malformed grant key')
    return {kind: 'dm', dhPublic: new Uint8Array(d), name: n}
  }
  if (t !== 'group') throw new Error('unknown grant kind')
  if (!(g instanceof Uint8Array) || g.length !== SECRET_BYTES) throw new Error('malformed grant secret')
  if (!isKey(f)) throw new Error('malformed grant founder')
  if (!Array.isArray(c) || c.length > MAX_CHAIN_LENGTH || !c.every(entry => entry instanceof Uint8Array)) {
    throw new Error('malformed grant chain')
  }
  return {
    kind: 'group',
    secret: new Uint8Array(g),
    name: n,
    founder: new Uint8Array(f),
    chain: (c as Uint8Array[]).map(entry => new Uint8Array(entry))
  }
}
