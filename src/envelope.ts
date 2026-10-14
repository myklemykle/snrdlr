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
  | {type: 'reaction'; target: MessageRef; emoji: string}
  /**
   * A picture. The message holds what is needed to fetch, check and open the file, which travels
   * separately (see files.ts), and a tiny preview to show until it arrives.
   */
  | ImageContent
  /**
   * The author's new words for one of their own earlier messages, written on any of their devices and
   * named by that device and its number: a message in words, or a picture's caption. Their latest edit
   * is the one that counts.
   */
  | {type: 'edit'; target: {device: string; seq: number}; text: string}
  /** A new name for a group chat. Any member may give one; the latest is the chat's name. */
  | {type: 'rename'; name: string}
  | CardContent
  /** Only in a person's own hidden chat (see devices.ts): one of their devices holds this chat, with what is needed to open it. */
  | ChatHeldContent
  /** Only in a person's own hidden chat: one of their devices has left this chat. */
  | {type: 'chat-left'; id: string}
  /** A genuine message of a kind this version of the app does not understand; kept for a later version. */
  | {type: 'unknown'; kind: string}

/** Points at another message in the same chat, by its author, the device it was written on, and that device's numbering. */
export type MessageRef = {author: string; device: string; seq: number}

/** Bytes in a device tag. A person's first device has none (''), and its messages carry no tag. */
export const DEVICE_BYTES = 8

/**
 * Each device numbers its own messages, so what is counted and synced is a stream of messages: one
 * person on one device. Named by the author's ID, then the device tag if there is one.
 */
export const streamOf = (message: {author: string; device: string}) => (message.device ? `${message.author}.${message.device}` : message.author)

/**
 * Whether one of a person's messages was written after another. On one device its numbering says so;
 * across their devices the logical clock is all there is, with the device and number to break ties.
 */
export const writtenAfter = (a: Pick<Message, 'lamport' | 'device' | 'seq'>, b: Pick<Message, 'lamport' | 'device' | 'seq'>) =>
  a.device === b.device ? a.seq > b.seq : (a.lamport - b.lamport || a.device.localeCompare(b.device)) > 0

const isDevice = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === DEVICE_BYTES

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

/** A file that travels beside the log, as an image message's picture does: what is needed to fetch, check and open it. */
export type PictureRef = Pick<ImageContent, 'hash' | 'key' | 'size' | 'width' | 'height' | 'preview'>

/**
 * The extras of the author's profile that they show in this chat; every part is optional. Their latest
 * replaces any earlier one, and an empty one takes it back.
 */
export type CardContent = {
  type: 'card'
  /** A single emoji. */
  icon?: string
  /** A tiny square JPEG, used in place of the emoji. */
  avatar?: Uint8Array
  /** A larger photo, fetched like any picture. */
  photo?: PictureRef
  contact?: {kind: 'email' | 'phone' | 'instagram' | 'other'; value: string}
  /** Tints the author's messages: #rrggbb. */
  color?: string
}

/** A chat as one device tells the person's others about it: everything that is the same on every device. */
export type ChatHeldContent = {
  type: 'chat-held'
  kind: 'group' | 'dm'
  secret: Uint8Array
  context: Uint8Array
  chain: Uint8Array[]
  peer?: {signPublic: Uint8Array; dhPublic: Uint8Array}
  name: string
}

export const MAX_AVATAR_BYTES = 8192
export const MAX_CONTACT_LENGTH = 100
const CARD_CONTACTS = ['email', 'phone', 'instagram', 'other']

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
  /** Which of the author's devices wrote it: hex, or '' for their first. */
  device: string
  /** That device's own counter in this chat, from 1. */
  seq: number
  /** Logical clock; the UI orders by (lamport, author). */
  lamport: number
  /** The author's wall clock, as claimed. */
  sentAt: number
  content: Content
}

export type ChatContext = {chatId: string; msgKey: CryptoKey}

export type Author = {id: string; signSecret: Uint8Array; signPublic: Uint8Array; device?: string}

export function importMsgKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function seqBytes(seq: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(seq))
  return bytes
}

// Every field before the payload has a fixed length, so the concatenation is unambiguous. A device tag
// changes the label, so a message with one can never be read as one without.
const boundBytes = (label: string, chatId: string, author: Uint8Array, seq: number, device?: Uint8Array) =>
  device
    ? concatBytes(utf8(`snrdlr/v1/${label}-d\0`), utf8(chatId), author, device, seqBytes(seq))
    : concatBytes(utf8(`snrdlr/v1/${label}\0`), utf8(chatId), author, seqBytes(seq))

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

const encodePicture = (picture: PictureRef) => ({
  h: fromHex(picture.hash),
  k: picture.key,
  z: picture.size,
  w: picture.width,
  t: picture.height,
  p: picture.preview
})

function decodePicture(body: Record<string, unknown>): PictureRef {
  const {h, k, z, w, t, p} = body
  const isBytes = (value: unknown, length: number): value is Uint8Array => value instanceof Uint8Array && value.length === length
  const isSide = (value: unknown): value is number => isCount(value) && value > 0 && value <= MAX_IMAGE_SIDE
  if (!isBytes(h, 32) || !isBytes(k, FILE_KEY_BYTES)) throw new Error('bad picture')
  if (!isCount(z) || z === 0 || z > MAX_FILE_BYTES || !isSide(w) || !isSide(t)) throw new Error('bad picture')
  if (!(p instanceof Uint8Array) || p.length > MAX_PREVIEW_BYTES) throw new Error('bad picture')
  return {hash: toHex(h), key: new Uint8Array(k), size: z, width: w, height: t, preview: new Uint8Array(p)}
}

const encodeRef = (ref: MessageRef) => (ref.device ? [fromHex(ref.author), ref.seq, fromHex(ref.device)] : [fromHex(ref.author), ref.seq])

function decodeRef(value: unknown): MessageRef {
  const [a, s, d] = Array.isArray(value) && (value.length === 2 || value.length === 3) ? (value as unknown[]) : []
  if (!(a instanceof Uint8Array) || a.length !== 32 || !isCount(s) || s === 0) throw new Error('bad reference to a message')
  if (d !== undefined && !isDevice(d)) throw new Error('bad reference to a message')
  return {author: toHex(a), device: d ? toHex(d) : '', seq: s}
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
      return [
        'reaction',
        {a: fromHex(content.target.author), s: content.target.seq, e: content.emoji, ...(content.target.device ? {d: fromHex(content.target.device)} : {})}
      ]
    case 'image':
      return [
        'image',
        {
          m: IMAGE_MIME,
          ...encodePicture(content),
          ...(content.caption ? {c: content.caption} : {}),
          ...(content.replyTo ? {r: encodeRef(content.replyTo)} : {})
        }
      ]
    case 'rename':
      return ['rename', content.name]
    case 'card':
      return [
        'card',
        {
          ...(content.icon ? {i: content.icon} : {}),
          ...(content.avatar?.length ? {a: content.avatar} : {}),
          ...(content.photo ? {p: encodePicture(content.photo)} : {}),
          ...(content.contact ? {c: [content.contact.kind, content.contact.value]} : {}),
          ...(content.color ? {o: content.color} : {})
        }
      ]
    case 'chat-held':
      return [
        'chat-held',
        {
          k: content.kind === 'dm' ? 'd' : 'g',
          s: content.secret,
          x: content.context,
          c: content.chain,
          n: content.name,
          ...(content.peer ? {p: [content.peer.signPublic, content.peer.dhPublic]} : {})
        }
      ]
    case 'chat-left':
      return ['chat-left', fromHex(content.id)]
    case 'edit':
      return ['edit', {s: content.target.seq, t: content.text, ...(content.target.device ? {d: fromHex(content.target.device)} : {})}]
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
  if (type === 'card') {
    const {i, a, p, c, o} = (body ?? {}) as Record<string, unknown>
    const card: CardContent = {type}
    if (i !== undefined) {
      if (typeof i !== 'string' || !isSingleEmoji(i)) throw new Error('bad card body')
      card.icon = i
    }
    if (a !== undefined) {
      if (!(a instanceof Uint8Array) || a.length === 0 || a.length > MAX_AVATAR_BYTES) throw new Error('bad card body')
      card.avatar = new Uint8Array(a)
    }
    if (p !== undefined) {
      if (typeof p !== 'object' || p === null) throw new Error('bad card body')
      card.photo = decodePicture(p as Record<string, unknown>)
    }
    if (c !== undefined) {
      const [kind, value] = Array.isArray(c) && c.length === 2 ? (c as unknown[]) : []
      if (typeof kind !== 'string' || !CARD_CONTACTS.includes(kind)) throw new Error('bad card body')
      if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_CONTACT_LENGTH) throw new Error('bad card body')
      card.contact = {kind: kind as NonNullable<CardContent['contact']>['kind'], value}
    }
    if (o !== undefined) {
      if (typeof o !== 'string' || !/^#[0-9a-f]{6}$/.test(o)) throw new Error('bad card body')
      card.color = o
    }
    return card
  }
  if (type === 'rename') {
    if (typeof body !== 'string' || body.trim() === '' || body.length > MAX_NAME_LENGTH) throw new Error('bad rename body')
    return {type, name: body}
  }
  if (type === 'chat-held') {
    const {k, s, x, c, n, p} = (body ?? {}) as Record<string, unknown>
    const isBytes = (value: unknown, length: number): value is Uint8Array => value instanceof Uint8Array && value.length === length
    if (k !== 'g' && k !== 'd') throw new Error('bad chat body')
    if (!isBytes(s, 32) || !isBytes(x, k === 'd' ? 64 : 32) || !isChain(c)) throw new Error('bad chat body')
    if (typeof n !== 'string' || n.length === 0 || n.length > MAX_NAME_LENGTH) throw new Error('bad chat body')
    const [sign, dh] = Array.isArray(p) && p.length === 2 ? (p as unknown[]) : []
    if (k === 'd' && (!isBytes(sign, 32) || !isBytes(dh, 32))) throw new Error('bad chat body')
    return {
      type,
      kind: k === 'd' ? 'dm' : 'group',
      secret: new Uint8Array(s),
      context: new Uint8Array(x),
      chain: c.map(cert => new Uint8Array(cert)),
      name: n,
      ...(k === 'd' ? {peer: {signPublic: new Uint8Array(sign as Uint8Array), dhPublic: new Uint8Array(dh as Uint8Array)}} : {})
    }
  }
  if (type === 'chat-left') {
    if (!(body instanceof Uint8Array) || body.length !== 32) throw new Error('bad chat body')
    return {type, id: toHex(body)}
  }
  if (type === 'edit') {
    const {s, t, d} = (body ?? {}) as Record<string, unknown>
    if (!isCount(s) || s === 0 || typeof t !== 'string' || t.length > MAX_TEXT_LENGTH) throw new Error('bad edit body')
    if (d !== undefined && !isDevice(d)) throw new Error('bad edit body')
    return {type, target: {device: d ? toHex(d) : '', seq: s}, text: t}
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
    const {a, s, e, d} = (body ?? {}) as Record<string, unknown>
    if (!(a instanceof Uint8Array) || a.length !== 32 || !isCount(s) || s === 0) throw new Error('bad reaction body')
    if (d !== undefined && !isDevice(d)) throw new Error('bad reaction body')
    if (typeof e !== 'string' || (e !== '' && !isSingleEmoji(e))) throw new Error('bad reaction body')
    return {type, target: {author: toHex(a), device: d ? toHex(d) : '', seq: s}, emoji: e}
  }
  if (type === 'image') {
    const {m, h, k, z, w, t, p, c, r} = (body ?? {}) as Record<string, unknown>
    // A kind of picture a newer version sends: keep the message for when this device can show it.
    if (typeof m === 'string' && m !== IMAGE_MIME && m.length <= 64) return {type: 'unknown', kind: 'image'}
    if (m !== IMAGE_MIME) throw new Error('bad image body')
    let picture: PictureRef
    try {
      picture = decodePicture({h, k, z, w, t, p})
    } catch {
      throw new Error('bad image body')
    }
    if (c !== undefined && (typeof c !== 'string' || c.length === 0 || c.length > MAX_TEXT_LENGTH)) throw new Error('bad image body')
    return {
      type,
      ...picture,
      ...(c ? {caption: c as string} : {}),
      ...(r !== undefined ? {replyTo: decodeRef(r)} : {})
    }
  }
  // Signed and decrypted correctly, so it is real; a newer app version sent something we cannot read yet.
  if (typeof type === 'string' && type.length > 0 && type.length <= 64) return {type: 'unknown', kind: type}
  throw new Error('bad message type')
}

export async function sealEnvelope(context: ChatContext, author: Author, message: Omit<Message, 'author' | 'device'>): Promise<Uint8Array> {
  const authorBytes = fromHex(author.id)
  const device = author.device ? fromHex(author.device) : undefined
  if (device && device.length !== DEVICE_BYTES) throw new Error('bad device tag')
  // The signed payload travels as bytes, so verifying never depends on re-encoding it identically.
  const payload = new Uint8Array(encode([...encodeContent(message.content), message.lamport, message.sentAt]))
  const signature = ed25519.sign(concatBytes(boundBytes('msg', context.chatId, authorBytes, message.seq, device), payload), author.signSecret)
  const inner = new Uint8Array(encode({p: payload, k: author.signPublic, g: signature}))

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: nonce, additionalData: boundBytes('env', context.chatId, authorBytes, message.seq, device)},
    context.msgKey,
    inner
  )
  return new Uint8Array(
    encode({v: ENVELOPE_VERSION, a: authorBytes, ...(device ? {d: device} : {}), s: message.seq, n: nonce, c: new Uint8Array(ciphertext)})
  )
}

/** Decrypts and verifies an envelope. Throws on anything malformed, tampered with, or from another chat. */
export async function openEnvelope(context: ChatContext, envelope: Uint8Array): Promise<Message> {
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new Error('envelope too large')
  const outer = decode(envelope) as Record<string, unknown> | null
  if (typeof outer !== 'object' || outer === null) throw new Error('malformed envelope')
  const {v, a, d, s, n, c} = outer
  if (v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version: ${String(v)}`)
  if (!(a instanceof Uint8Array) || a.length !== 32) throw new Error('bad author')
  if (d !== undefined && !isDevice(d)) throw new Error('bad device tag')
  const device = d === undefined ? undefined : new Uint8Array(d)
  if (!isCount(s) || s === 0) throw new Error('bad sequence number')
  if (!(n instanceof Uint8Array) || n.length !== NONCE_BYTES) throw new Error('bad nonce')
  if (!(c instanceof Uint8Array)) throw new Error('bad ciphertext')

  const decrypted = await crypto.subtle
    .decrypt(
      {name: 'AES-GCM', iv: new Uint8Array(n), additionalData: boundBytes('env', context.chatId, a, s, device)},
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
    signed = ed25519.verify(g, concatBytes(boundBytes('msg', context.chatId, a, s, device), p), k)
  } catch {
    // An invalid key or signature encoding is just a failed verification.
  }
  if (!signed) throw new Error('bad signature')

  const payload = decode(p) as unknown
  if (!Array.isArray(payload) || payload.length !== 4) throw new Error('malformed payload')
  const [type, body, lamport, sentAt] = payload as unknown[]
  if (!isCount(lamport) || !isCount(sentAt)) throw new Error('bad clock')
  return {author: toHex(a), device: device ? toHex(device) : '', seq: s, lamport, sentAt, content: decodeContent(type, body)}
}
