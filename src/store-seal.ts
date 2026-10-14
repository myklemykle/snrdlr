// How a message is locked before it is left with the relay.
//
// Everything a chat's members share, the chat's secret included, is also known to anyone who gets
// hold of a copy of that secret. Between devices that does not matter, because members only send to
// peers who have proved they were invited. The relay cannot check that: it hands what it holds to
// anyone who knows the chat's topic. So a stored message is locked a second time, to the members
// themselves: with a fresh key, which is then wrapped once for each member using that member's own
// public key. Someone with the chat's secret but no member's private key can fetch it and not open it.
import {x25519} from '@noble/curves/ed25519.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {decode, encode} from 'cbor-x'
import {bytesEqual, concatBytes, fromHex, utf8} from './bytes'

/** Most members a stored message is wrapped for; a bigger chat's extra members get it from other devices. */
export const MAX_RECIPIENTS = 200
const TAG_BYTES = 8
const ZERO_NONCE = new Uint8Array(12)

export type Recipient = {id: string; dhPublic: Uint8Array}

const aesKey = (raw: Uint8Array, usage: KeyUsage[]) => crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, usage)
// Each wrapping key comes from a secret used once, so it is used for exactly one encryption.
const wrapKey = (shared: Uint8Array, chatId: string, memberId: string) => hkdf(sha256, shared, utf8(chatId), utf8(`snrdlr/v1/store-wrap/${memberId}`), 32)
const tagOf = (memberId: string) => fromHex(memberId).subarray(0, TAG_BYTES)

/** Locks an envelope so that only the listed members can open it. */
export async function sealForMembers(chatId: string, envelope: Uint8Array, recipients: Recipient[]): Promise<Uint8Array> {
  const contentKey = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: utf8(chatId)}, await aesKey(contentKey, ['encrypt']), new Uint8Array(envelope)))
  const once = x25519.utils.randomSecretKey()
  const wraps: Uint8Array[] = []
  for (const {id, dhPublic} of recipients.slice(0, MAX_RECIPIENTS)) {
    let shared: Uint8Array
    try {
      shared = x25519.getSharedSecret(once, dhPublic)
    } catch {
      // Not a usable key; that member gets the message from another device instead.
      continue
    }
    const wrapped = await crypto.subtle.encrypt({name: 'AES-GCM', iv: ZERO_NONCE}, await aesKey(wrapKey(shared, chatId, id), ['encrypt']), contentKey)
    wraps.push(concatBytes(tagOf(id), new Uint8Array(wrapped)))
  }
  return new Uint8Array(encode({v: 1, e: x25519.getPublicKey(once), n: nonce, c: sealed, w: wraps}))
}

/** Opens what `sealForMembers` made, as one of its recipients. Null if it was not locked for us, or is not genuine. */
export async function openAsMember(chatId: string, stored: Uint8Array, self: {id: string; dhSecret: Uint8Array}): Promise<Uint8Array | null> {
  try {
    const {v, e, n, c, w} = decode(stored) as Record<string, unknown>
    if (v !== 1 || !(e instanceof Uint8Array) || !(n instanceof Uint8Array) || !(c instanceof Uint8Array) || !Array.isArray(w)) return null
    const tag = tagOf(self.id)
    const shared = x25519.getSharedSecret(self.dhSecret, e)
    const key = await aesKey(wrapKey(shared, chatId, self.id), ['decrypt'])
    for (const wrap of w) {
      if (!(wrap instanceof Uint8Array) || !bytesEqual(wrap.subarray(0, TAG_BYTES), tag)) continue
      const contentKey = await crypto.subtle.decrypt({name: 'AES-GCM', iv: ZERO_NONCE}, key, new Uint8Array(wrap.subarray(TAG_BYTES))).catch(() => null)
      if (!contentKey) continue
      const envelope = await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(n), additionalData: utf8(chatId)}, await aesKey(new Uint8Array(contentKey), ['decrypt']), new Uint8Array(c))
      return new Uint8Array(envelope)
    }
  } catch {
    // Damaged, or not what it claims to be.
  }
  return null
}
