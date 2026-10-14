// Message envelopes: each message is signed by its author, then encrypted with the chat's key.
//
// In the clear (sync will need these without decrypting): author ID, the author's sequence number, nonce.
// Encrypted: the payload (content, logical clock, send time), the author's public key and signature.
// The signature covers the chat, author, sequence number and payload, so nobody else in the chat can
// alter a message, renumber it, or replay it into another chat.
import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {bytesEqual, concatBytes, fromHex, toHex, utf8} from './bytes'
import {isSingleEmoji} from './emoji'
import {FILE_KEY_BYTES, MAX_FILE_BYTES} from './files'
import {memberId, MAX_NAME_LENGTH} from './identity'

export const ENVELOPE_VERSION = 1
export const MAX_TEXT_LENGTH = 4000
export const MAX_ENVELOPE_BYTES = 32 * 1024
const NONCE_BYTES = 12

export type Content =
  /** Words. If it answers an earlier message, `replyTo` says which; that message is shown above it. */
  | {type: 'text'; text: string; replyTo?: MessageRef}
  /** A member's display name and X25519 key, posted when they join, with the certificates that show they belong. */
  | {type: 'profile'; name: string; dh: Uint8Array; chain?: Uint8Array[]}
  /** A membership certificate, posted by the member who admitted someone. */
  | {type: 'member-cert'; cert: Uint8Array}
  /** In a direct chat: the sender has started a group that includes the recipient, and this lets them in. */
  | {type: 'group-invite'; secret: Uint8Array; name: string; founder: Uint8Array; chain: Uint8Array[]}
  /**
   * The author's reaction to another message. Each person has at most one per message: their latest
   * replaces any earlier one, and an empty emoji takes it away.
   */
  | {type: 'reaction'; target: {author: string; seq: number}; emoji: string}
  /**
   * A picture. The message holds what is needed to fetch, check and open the file, which travels
   * separately (see files.ts), and a tiny preview to show until it arrives.
   */
  | ImageContent
  /**
   * The author's new words for one of their own earlier messages, named by its number: a message in
   * words, or a picture's caption. Their latest edit is the one that counts.
   */
  | {type: 'edit'; target: number; text: string}
  /** A genuine message of a kind this version of the app does not understand; kept for a later version. */
  | {type: 'unknown'; kind: string}

/** Points at another message in the same chat, by its author and that author's numbering. */
export type MessageRef = {author: string; seq: number}

export type ImageContent = {
  type: 'image'
  /** SHA-256 of the encrypted file, in hex. */
  hash: string
  key: Uint8Array
  /** Bytes in the encrypted file. */
  size: number
  width: number
  height: number
  /** A very small JPEG of the picture; may be empty. */
  preview: Uint8Array
  caption?: string
  replyTo?: MessageRef
}

export const IMAGE_MIME = 'image/jpeg'
export const MAX_PREVIEW_BYTES = 2048
const MAX_IMAGE_SIDE = 16384

const MAX_CERT_BYTES = 512
const MAX_CHAIN_LENGTH = 32

const isChain = (value: unknown): value is Uint8Array[] =>
  Array.isArray(value) &&
  value.length <= MAX_CHAIN_LENGTH &&
  value.every(cert => cert instanceof Uint8Array && cert.length > 0 && cert.length <= MAX_CERT_BYTES)

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

const encodeRef = (ref: MessageRef) => [fromHex(ref.author), ref.seq]

function decodeRef(value: unknown): MessageRef {
  const [a, s] = Array.isArray(value) && value.length === 2 ? (value as unknown[]) : []
  if (!(a instanceof Uint8Array) || a.length !== 32 || !isCount(s) || s === 0) throw new Error('bad reference to a message')
  return {author: toHex(a), seq: s}
}

function encodeContent(content: Content): [string, unknown] {
  switch (content.type) {
    case 'text':
      // A reply goes out as a kind of its own, so that an older version of the app keeps it for later
      // instead of refusing it.
      return content.replyTo ? ['reply', {t: content.text, r: encodeRef(content.replyTo)}] : ['text', content.text]
    case 'profile':
      return ['profile', {name: content.name, dh: content.dh, ...(content.chain?.length ? {c: content.chain} : {})}]
    case 'member-cert':
      return ['member-cert', content.cert]
    case 'group-invite':
      return ['group-invite', {g: content.secret, n: content.name, f: content.founder, c: content.chain}]
    case 'reaction':
      return ['reaction', {a: fromHex(content.target.author), s: content.target.seq, e: content.emoji}]
    case 'image':
      return [
        'image',
        {
          m: IMAGE_MIME,
          h: fromHex(content.hash),
          k: content.key,
          z: content.size,
          w: content.width,
          t: content.height,
          p: content.preview,
          ...(content.caption ? {c: content.caption} : {}),
          ...(content.replyTo ? {r: encodeRef(content.replyTo)} : {})
        }
      ]
    case 'edit':
      return ['edit', {s: content.target, t: content.text}]
    case 'unknown':
      throw new Error('cannot send a message of unknown type')
  }
}

function decodeContent(type: unknown, body: unknown): Content {
  if (type === 'text') {
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_TEXT_LENGTH) throw new Error('bad text body')
    return {type, text: body}
  }
  if (type === 'reply') {
    const {t, r} = (body ?? {}) as Record<string, unknown>
    if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TEXT_LENGTH) throw new Error('bad reply body')
    return {type: 'text', text: t, replyTo: decodeRef(r)}
  }
  if (type === 'edit') {
    const {s, t} = (body ?? {}) as Record<string, unknown>
    if (!isCount(s) || s === 0 || typeof t !== 'string' || t.length > MAX_TEXT_LENGTH) throw new Error('bad edit body')
    return {type, target: s, text: t}
  }
  if (type === 'profile') {
    const {name, dh, c} = (body ?? {}) as {name?: unknown; dh?: unknown; c?: unknown}
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) throw new Error('bad profile body')
    if (!(dh instanceof Uint8Array) || dh.length !== 32) throw new Error('bad profile body')
    if (c !== undefined && !isChain(c)) throw new Error('bad profile body')
    return {type, name, dh: new Uint8Array(dh), ...(c?.length ? {chain: c.map(cert => new Uint8Array(cert))} : {})}
  }
  if (type === 'member-cert') {
    if (!(body instanceof Uint8Array) || body.length === 0 || body.length > MAX_CERT_BYTES) throw new Error('bad certificate body')
    return {type, cert: new Uint8Array(body)}
  }
  if (type === 'group-invite') {
    const {g, n, f, c} = (body ?? {}) as Record<string, unknown>
    const isBytes = (value: unknown, length: number) => value instanceof Uint8Array && value.length === length
    if (!isBytes(g, 32) || !isBytes(f, 32)) throw new Error('bad group invite body')
    if (typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH) throw new Error('bad group invite body')
    if (!isChain(c)) throw new Error('bad group invite body')
    return {
      type,
      secret: new Uint8Array(g as Uint8Array),
      name: n,
      founder: new Uint8Array(f as Uint8Array),
      chain: (c as Uint8Array[]).map(cert => new Uint8Array(cert))
    }
  }
  if (type === 'reaction') {
    const {a, s, e} = (body ?? {}) as Record<string, unknown>
    if (!(a instanceof Uint8Array) || a.length !== 32 || !isCount(s) || s === 0) throw new Error('bad reaction body')
    if (typeof e !== 'string' || (e !== '' && !isSingleEmoji(e))) throw new Error('bad reaction body')
    return {type, target: {author: toHex(a), seq: s}, emoji: e}
  }
  if (type === 'image') {
    const {m, h, k, z, w, t, p, c, r} = (body ?? {}) as Record<string, unknown>
    // A kind of picture a newer version sends: keep the message for when this device can show it.
    if (typeof m === 'string' && m !== IMAGE_MIME && m.length <= 64) return {type: 'unknown', kind: 'image'}
    const isBytes = (value: unknown, length: number): value is Uint8Array => value instanceof Uint8Array && value.length === length
    const isSide = (value: unknown): value is number => isCount(value) && value > 0 && value <= MAX_IMAGE_SIDE
    if (m !== IMAGE_MIME || !isBytes(h, 32) || !isBytes(k, FILE_KEY_BYTES)) throw new Error('bad image body')
    if (!isCount(z) || z === 0 || z > MAX_FILE_BYTES || !isSide(w) || !isSide(t)) throw new Error('bad image body')
    if (!(p instanceof Uint8Array) || p.length > MAX_PREVIEW_BYTES) throw new Error('bad image body')
    if (c !== undefined && (typeof c !== 'string' || c.length === 0 || c.length > MAX_TEXT_LENGTH)) throw new Error('bad image body')
    return {
      type,
      hash: toHex(h),
      key: new Uint8Array(k),
      size: z,
      width: w,
      height: t,
      preview: new Uint8Array(p),
      ...(c ? {caption: c as string} : {}),
      ...(r !== undefined ? {replyTo: decodeRef(r)} : {})
    }
  }
  // Signed and decrypted correctly, so it is real; a newer app version sent something we cannot read yet.
  if (typeof type === 'string' && type.length > 0 && type.length <= 64) return {type: 'unknown', kind: type}
  throw new Error('bad message type')
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
