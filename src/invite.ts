// Invites that only work while the inviter is showing them.
//
// The QR code carries a random one-time token and the inviter's public key, and nothing about the chat.
// The inviter's app waits in a temporary room derived from the token; a joiner who connects there is sent
// a signed "grant" holding the chat's secret. When the inviter closes the invite, their app leaves the
// room and forgets the token, so an old code leads nowhere and reveals nothing.
import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {concatBytes, fromBase64Url, toBase64Url, utf8} from './bytes'
import {MAX_NAME_LENGTH} from './identity'
import {SECRET_BYTES} from './keys'

export const INVITE_VERSION = 2
const FRAGMENT_PREFIX = '#i='

export type Invite = {
  /** Random; names the temporary room and is forgotten when the invite closes. */
  token: Uint8Array
  /** The inviter's signing public key, so the joiner can tell the grant came from them. */
  inviter: Uint8Array
}

/** What a joiner receives: enough to enter the chat. */
export type Grant = {secret: Uint8Array; name: string}

type Signer = {signSecret: Uint8Array; signPublic: Uint8Array}

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
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('malformed inviter key')
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

// Token and secret have fixed lengths, so the name can follow without a separator.
const grantBytes = (token: Uint8Array, grant: Grant) =>
  concatBytes(utf8('snrdlr/v1/grant\0'), token, grant.secret, utf8(grant.name))

/** Signs the chat's secret for this one invite. Signing over the token stops a grant being reused for another. */
export function sealGrant(inviter: Signer, invite: Invite, grant: Grant): Uint8Array {
  const signature = ed25519.sign(grantBytes(invite.token, grant), inviter.signSecret)
  return new Uint8Array(encode({g: grant.secret, n: grant.name, s: signature}))
}

/** Checks a grant came from the person named in the invite. Throws otherwise. */
export function openGrant(invite: Invite, sealed: Uint8Array): Grant {
  const raw = decode(sealed) as Record<string, unknown> | null
  if (typeof raw !== 'object' || raw === null) throw new Error('malformed grant')
  const {g, n, s} = raw
  if (!(g instanceof Uint8Array) || g.length !== SECRET_BYTES) throw new Error('malformed grant secret')
  if (typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH) throw new Error('malformed grant name')
  if (!(s instanceof Uint8Array) || s.length !== 64) throw new Error('malformed grant signature')
  const grant = {secret: new Uint8Array(g), name: n}
  let signed = false
  try {
    signed = ed25519.verify(s, grantBytes(invite.token, grant), invite.inviter)
  } catch {
    // An invalid key or signature encoding is just a failed verification.
  }
  if (!signed) throw new Error('grant was not signed by the inviter')
  return grant
}
