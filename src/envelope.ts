// Message envelopes: each message is signed by its author, then encrypted with the chat's key.
//
// In the clear (sync will need these without decrypting): author ID, the author's sequence number, nonce.
// Encrypted: the payload (content, logical clock, send time), the author's public key and signature.
// The signature covers the chat, author, sequence number and payload, so nobody else in the chat can
// alter a message, renumber it, or replay it into another chat.
import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {bytesEqual, concatBytes, fromHex, toHex, utf8} from './bytes'
import {memberId, MAX_NAME_LENGTH} from './identity'

export const ENVELOPE_VERSION = 1
export const MAX_TEXT_LENGTH = 4000
export const MAX_ENVELOPE_BYTES = 32 * 1024
const NONCE_BYTES = 12

export type Content = {type: 'text'; text: string} | {type: 'profile'; name: string}

export type Message = {
  /** Member ID of the author. */
  author: string
  /** The author's own counter in this chat, from 1. */
  seq: number
  /** Logical clock; the UI orders by (lamport, author). */
  lamport: number
  /** The author's wall clock, as claimed. */
  sentAt: number
  content: Content
}

export type ChatContext = {chatId: string; msgKey: CryptoKey}

export type Author = {id: string; signSecret: Uint8Array; signPublic: Uint8Array}

export function importMsgKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function seqBytes(seq: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(seq))
  return bytes
}

// Every field before the payload has a fixed length, so the concatenation is unambiguous.
const boundBytes = (label: string, chatId: string, author: Uint8Array, seq: number) =>
  concatBytes(utf8(`snrdlr/v1/${label}\0`), utf8(chatId), author, seqBytes(seq))

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function encodeContent(content: Content): [string, unknown] {
  return content.type === 'text' ? ['text', content.text] : ['profile', {name: content.name}]
}

function decodeContent(type: unknown, body: unknown): Content {
  if (type === 'text') {
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_TEXT_LENGTH) throw new Error('bad text body')
    return {type, text: body}
  }
  if (type === 'profile') {
    const name = (body as {name?: unknown} | null)?.name
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) throw new Error('bad profile body')
    return {type, name}
  }
  throw new Error(`unknown message type: ${String(type)}`)
}

export async function sealEnvelope(context: ChatContext, author: Author, message: Omit<Message, 'author'>): Promise<Uint8Array> {
  const authorBytes = fromHex(author.id)
  // The signed payload travels as bytes, so verifying never depends on re-encoding it identically.
  const payload = new Uint8Array(encode([...encodeContent(message.content), message.lamport, message.sentAt]))
  const signature = ed25519.sign(concatBytes(boundBytes('msg', context.chatId, authorBytes, message.seq), payload), author.signSecret)
  const inner = new Uint8Array(encode({p: payload, k: author.signPublic, g: signature}))

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: nonce, additionalData: boundBytes('env', context.chatId, authorBytes, message.seq)},
    context.msgKey,
    inner
  )
  return new Uint8Array(encode({v: ENVELOPE_VERSION, a: authorBytes, s: message.seq, n: nonce, c: new Uint8Array(ciphertext)}))
}

/** Decrypts and verifies an envelope. Throws on anything malformed, tampered with, or from another chat. */
export async function openEnvelope(context: ChatContext, envelope: Uint8Array): Promise<Message> {
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new Error('envelope too large')
  const outer = decode(envelope) as Record<string, unknown> | null
  if (typeof outer !== 'object' || outer === null) throw new Error('malformed envelope')
  const {v, a, s, n, c} = outer
  if (v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version: ${String(v)}`)
  if (!(a instanceof Uint8Array) || a.length !== 32) throw new Error('bad author')
  if (!isCount(s) || s === 0) throw new Error('bad sequence number')
  if (!(n instanceof Uint8Array) || n.length !== NONCE_BYTES) throw new Error('bad nonce')
  if (!(c instanceof Uint8Array)) throw new Error('bad ciphertext')

  const decrypted = await crypto.subtle
    .decrypt(
      {name: 'AES-GCM', iv: new Uint8Array(n), additionalData: boundBytes('env', context.chatId, a, s)},
      context.msgKey,
      new Uint8Array(c)
    )
    .catch(() => {
      throw new Error('envelope failed to decrypt')
    })

  const inner = decode(new Uint8Array(decrypted)) as Record<string, unknown> | null
  if (typeof inner !== 'object' || inner === null) throw new Error('malformed envelope contents')
  const {p, k, g} = inner
  if (!(p instanceof Uint8Array) || !(k instanceof Uint8Array) || !(g instanceof Uint8Array)) throw new Error('malformed envelope contents')
  if (k.length !== 32 || g.length !== 64) throw new Error('malformed envelope contents')

  // The author ID is the hash of the signing key, so a valid signature proves who wrote it.
  if (!bytesEqual(fromHex(memberId(k)), a)) throw new Error('author does not match signing key')
  let signed = false
  try {
    signed = ed25519.verify(g, concatBytes(boundBytes('msg', context.chatId, a, s), p), k)
  } catch {
    // An invalid key or signature encoding is just a failed verification.
  }
  if (!signed) throw new Error('bad signature')

  const payload = decode(p) as unknown
  if (!Array.isArray(payload) || payload.length !== 4) throw new Error('malformed payload')
  const [type, body, lamport, sentAt] = payload as unknown[]
  if (!isCount(lamport) || !isCount(sentAt)) throw new Error('bad clock')
  return {author: toHex(a), seq: s, lamport, sentAt, content: decodeContent(type, body)}
}
