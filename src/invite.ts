import {decode, encode} from 'cbor-x'
import {fromBase64Url, toBase64Url} from './bytes'
import {SECRET_BYTES} from './keys'

export const INVITE_VERSION = 1
const MAX_NAME_LENGTH = 64
const FRAGMENT_PREFIX = '#i='

export type Invite = {
  secret: Uint8Array
  name: string
}

export function encodeInvite(invite: Invite): string {
  const name = invite.name.slice(0, MAX_NAME_LENGTH)
  return toBase64Url(encode({v: INVITE_VERSION, g: invite.secret, n: name}))
}

export function decodeInvite(payload: string): Invite {
  const raw = decode(fromBase64Url(payload))
  if (typeof raw !== 'object' || raw === null) throw new Error('malformed invite')
  const {v, g, n} = raw as Record<string, unknown>
  if (v !== INVITE_VERSION) throw new Error(`unsupported invite version: ${String(v)}`)
  if (!(g instanceof Uint8Array) || g.length !== SECRET_BYTES) throw new Error('malformed invite secret')
  if (typeof n !== 'string' || n.length > MAX_NAME_LENGTH) throw new Error('malformed invite name')
  // Copy: cbor-x may hand back a view into its decode buffer.
  return {secret: new Uint8Array(g), name: n}
}

/** The invite rides in the URL fragment, which browsers never send to the server. */
export function inviteToFragment(invite: Invite): string {
  return FRAGMENT_PREFIX + encodeInvite(invite)
}

export function inviteFromFragment(fragment: string): Invite | null {
  if (!fragment.startsWith(FRAGMENT_PREFIX)) return null
  try {
    return decodeInvite(fragment.slice(FRAGMENT_PREFIX.length))
  } catch {
    return null
  }
}
