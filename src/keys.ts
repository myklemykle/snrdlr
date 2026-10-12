import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {toBase64Url, toHex, utf8} from './bytes'

export const SECRET_BYTES = 32

export type ChatKeys = {
  /** Trystero room name; the only value signaling relays see (hashed again by Trystero). Also the chat's ID. */
  roomId: string
  /** Trystero `password`, which encrypts SDP so relays cannot read or rewrite it. */
  sdpPassword: string
  /** AES-256-GCM key bytes for message envelopes. Never leaves the members' devices. */
  msgKey: Uint8Array
}

export function generateGroupSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
}

function derive(secret: Uint8Array, label: string, salt?: Uint8Array): Uint8Array {
  return hkdf(sha256, secret, salt, utf8(`snrdlr/v1/${label}`), 32)
}

/** Keys for the short-lived room where an invite token is exchanged for the chat's secret. */
export function deriveInviteKeys(token: Uint8Array): Pick<ChatKeys, 'roomId' | 'sdpPassword'> {
  if (token.length !== SECRET_BYTES) throw new Error('invite token must be 32 bytes')
  return {
    roomId: toHex(derive(token, 'invite-room')),
    sdpPassword: toBase64Url(derive(token, 'invite-sdp'))
  }
}

/**
 * `context` fixes who anchors the chat: the founder's signing key for a group, both members' keys for a
 * direct chat. Mixing it in means nobody can present the same secret with a different founder.
 */
export function deriveChatKeys(secret: Uint8Array, context: Uint8Array): ChatKeys {
  if (secret.length !== SECRET_BYTES) throw new Error('chat secret must be 32 bytes')
  if (context.length === 0) throw new Error('chat context is required')
  return {
    roomId: toHex(derive(secret, 'room', context)),
    sdpPassword: toBase64Url(derive(secret, 'sdp', context)),
    msgKey: derive(secret, 'msg', context)
  }
}
