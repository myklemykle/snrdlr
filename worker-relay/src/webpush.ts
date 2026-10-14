// Web Push from the relay: telling a device's push service (Apple's, Google's, Mozilla's) to wake it.
//
// What is sent is encrypted for the device (RFC 8291), so the push service cannot read it, and the
// request is signed with the relay's own key (VAPID, RFC 8292), which the device named when it
// subscribed, so nobody else can push to it. Only WebCrypto is used, which Cloudflare's Workers have.

/** Where a device's pushes go, and its keys, as the browser gives them when it subscribes. */
export type PushTarget = {endpoint: string; p256dh: string; auth: string}

/** The relay's own signing key: a P-256 key as a JWK, with its private part. */
export type VapidKey = JsonWebKey

const enc = new TextEncoder()

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return new Uint8Array(Array.from(atob(base64), char => char.charCodeAt(0)))
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey('raw', key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data))
}

/** HKDF with a single block of output, which is all that is needed here. */
async function hkdf(salt: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, secret)
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length)
}

/** The raw public key (65 bytes, uncompressed) of a P-256 JWK. */
export const publicKeyOf = (jwk: JsonWebKey) => concat(new Uint8Array([4]), fromBase64Url(jwk.x!), fromBase64Url(jwk.y!))

/**
 * Encrypts a message for one device, as RFC 8291 says (the "aes128gcm" encoding). `sender` and `salt`
 * are fixed only in tests; normally both are fresh each time.
 */
export async function encryptPush(
  plaintext: Uint8Array<ArrayBuffer>,
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  fixed?: {sender: JsonWebKey; salt: Uint8Array<ArrayBuffer>}
): Promise<Uint8Array<ArrayBuffer>> {
  const receiverPublic = fromBase64Url(target.p256dh)
  const authSecret = fromBase64Url(target.auth)
  const sender = fixed
    ? {
        privateKey: await crypto.subtle.importKey('jwk', fixed.sender, {name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveBits']),
        publicRaw: publicKeyOf(fixed.sender)
      }
    : await (async () => {
        const pair = (await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits'])) as CryptoKeyPair
        return {privateKey: pair.privateKey, publicRaw: new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)}
      })()
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const receiverKey = await crypto.subtle.importKey('raw', receiverPublic, {name: 'ECDH', namedCurve: 'P-256'}, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: 'ECDH', public: receiverKey} as EcdhKeyDeriveParams, sender.privateKey, 256))

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), receiverPublic, sender.publicRaw), 32)
  const contentKey = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  // One record: the message, then the delimiter that marks it as the last.
  const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt'])
  const sealed = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, key, concat(plaintext, new Uint8Array([2]))))
  const recordSize = new Uint8Array(4)
  new DataView(recordSize.buffer).setUint32(0, 4096)
  return concat(salt, recordSize, new Uint8Array([sender.publicRaw.length]), sender.publicRaw, sealed)
}

/** The Authorization header that proves a push comes from the relay (RFC 8292). */
export async function vapidHeader(endpoint: string, vapid: VapidKey, subject: string, now = Date.now()): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({typ: 'JWT', alg: 'ES256'})))
  const claims = toBase64Url(enc.encode(JSON.stringify({aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject})))
  const key = await crypto.subtle.importKey('jwk', vapid, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, enc.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${toBase64Url(publicKeyOf(vapid))}`
}

/** What became of a push: delivered to the push service, gone for good (forget the device), or failed this time. */
export type PushOutcome = 'sent' | 'gone' | 'failed'

/**
 * Sends one push. `collapse` lets the push service replace an earlier push with the same value that
 * has not been delivered yet, so a phone that was off gets one notice per chat, not dozens.
 */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  options: {vapid: VapidKey; subject: string; collapse?: string; ttlSeconds?: number; fetcher?: typeof fetch}
): Promise<PushOutcome> {
  const body = await encryptPush(enc.encode(JSON.stringify(payload)), target)
  const headers: Record<string, string> = {
    Authorization: await vapidHeader(target.endpoint, options.vapid, options.subject),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds ?? 24 * 3600),
    Urgency: 'high'
  }
  if (options.collapse) headers.Topic = options.collapse
  try {
    const response = await (options.fetcher ?? fetch)(target.endpoint, {method: 'POST', headers, body})
    if (response.status === 404 || response.status === 410) return 'gone'
    return response.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}
