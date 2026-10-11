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

function derive(secret: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, secret, undefined, utf8(`snrdlr/v1/${label}`), 32)
}

export function deriveChatKeys(secret: Uint8Array): ChatKeys {
  if (secret.length !== SECRET_BYTES) throw new Error('group secret must be 32 bytes')
  return {
    roomId: toHex(derive(secret, 'room')),
    sdpPassword: toBase64Url(derive(secret, 'sdp')),
    msgKey: derive(secret, 'msg')
  }
}
