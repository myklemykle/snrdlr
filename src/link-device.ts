// Adding a device: giving a new device the person's keys, so that it becomes them too (see devices.ts).
//
// One of the two devices shows a code, and the other opens it, by scanning it or by following it as a
// link. Either one may show it: a computer without a camera shows its code to the phone, and a phone
// can show its code to a new phone. The code holds a one-time token, from which both work out a
// meeting place on the relay's store and a key that keeps what they leave there from the relay.
//
// The new device leaves a request there: a public key made for this, which it alone can use. The device
// that is already the person shows a check number worked out from the token and that key, the new
// device shows the same number, and once the person says they match, the keys are left there locked to
// the new device's key. Everything else, the chats included, then comes through the person's hidden chat.
import {x25519} from '@noble/curves/ed25519.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {decode, encode} from 'cbor-x'
import {concatBytes, fromBase64Url, toBase64Url, toHex, utf8} from './bytes'
import {DEVICE_BYTES} from './envelope'
import type {IdentitySecrets} from './identity'
import type {Mailbox, OpenMailbox} from './mailbox'
import {openAsMember, sealForMembers} from './store-seal'

export const DEVICE_PREFIX = '#device1.'
/** A code is only good for this long. */
export const LINK_LIFETIME_MS = 10 * 60_000
const RETRY_MS = 3000

/** Which device shows the code: the new one, or the one that is already the person. */
export type LinkRole = 'new' | 'existing'

export type DeviceLink = {token: Uint8Array; role: LinkRole; expires: number}

export function makeLink(role: LinkRole, now = Date.now()): DeviceLink {
  return {token: crypto.getRandomValues(new Uint8Array(32)), role, expires: now + LINK_LIFETIME_MS}
}

export const linkToFragment = (link: DeviceLink) =>
  `${DEVICE_PREFIX}${link.role === 'new' ? 'n' : 'e'}.${toBase64Url(link.token)}.${Math.floor(link.expires / 1000).toString(36)}`

export const isDeviceFragment = (fragment: string) => fragment.startsWith(DEVICE_PREFIX)

export function linkFromFragment(fragment: string): DeviceLink | null {
  if (!isDeviceFragment(fragment)) return null
  const [role, token, expires] = fragment.slice(DEVICE_PREFIX.length).split('.')
  try {
    const bytes = fromBase64Url(token ?? '')
    const seconds = parseInt(expires ?? '', 36)
    if ((role !== 'n' && role !== 'e') || bytes.length !== 32 || !Number.isSafeInteger(seconds)) return null
    return {token: bytes, role: role === 'n' ? 'new' : 'existing', expires: seconds * 1000}
  } catch {
    return null
  }
}

const derive = (token: Uint8Array, label: string) => hkdf(sha256, token, undefined, utf8(`snrdlr/v1/device-link/${label}`), 32)
const topicOf = (token: Uint8Array) => toHex(derive(token, 'topic'))

/** The number both devices show, so the person can tell the request came from the device in front of them. */
export function checkNumber(token: Uint8Array, dhPublic: Uint8Array): string {
  const digest = sha256(concatBytes(utf8('snrdlr/v1/device-link/check'), token, dhPublic))
  const value = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1_000_000
  const digits = value.toString().padStart(6, '0')
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

async function lock(token: Uint8Array, message: unknown): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(derive(token, 'key')), 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, key, new Uint8Array(encode(message)))
  return concatBytes(nonce, new Uint8Array(sealed))
}

async function unlock(token: Uint8Array, bytes: Uint8Array): Promise<Record<string, unknown> | null> {
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(derive(token, 'key')), 'AES-GCM', false, ['decrypt'])
    const opened = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(0, 12)}, key, bytes.slice(12))
    const message = decode(new Uint8Array(opened)) as unknown
    return typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Leaves a message, trying again now and then until it is there or the handover is over. */
function leave(box: Mailbox, message: Promise<Uint8Array>, over: () => boolean) {
  void message.then(async bytes => {
    while (!over()) {
      if (await box.post(bytes, Date.now()).catch(() => false)) return
      await new Promise(resolve => setTimeout(resolve, RETRY_MS))
    }
  })
}

/**
 * What a new device is given: the keys that make it the person, and its own device tag. The device
 * letting it in picks the tag, so that it knows which of the person's devices it let in.
 */
export type Given = Pick<IdentitySecrets, 'name' | 'signSecret' | 'dhSecret'> & {device: string}

/**
 * The new device's side. Asks at once, then waits to be given the person's keys. `check` is the number
 * to show, which the other device shows too.
 */
export function askToJoin(link: DeviceLink, mailboxes: OpenMailbox, onGiven: (given: Given) => void): {check: string; close: () => void} {
  const secret = x25519.utils.randomSecretKey()
  const dhPublic = x25519.getPublicKey(secret)
  const topic = topicOf(link.token)
  let over = false
  const box = mailboxes(topic, undefined, {
    onEnvelope: envelope =>
      void unlock(link.token, envelope).then(async message => {
        if (over || !(message?.g instanceof Uint8Array)) return
        const opened = await openAsMember(topic, message.g, {id: topic, dhSecret: secret})
        if (!opened || over) return
        try {
          const {n, s, d, t} = decode(opened) as Record<string, unknown>
          if (typeof n !== 'string' || !(s instanceof Uint8Array) || s.length !== 32 || !(d instanceof Uint8Array) || d.length !== 32) return
          if (typeof t !== 'string' || !/^[0-9a-f]{16}$/.test(t)) return
          over = true
          box.close()
          onGiven({name: n, signSecret: new Uint8Array(s), dhSecret: new Uint8Array(d), device: t})
        } catch {
          // Not what a device sends.
        }
      })
  })
  leave(box, lock(link.token, {w: dhPublic}), () => over)
  return {
    check: checkNumber(link.token, dhPublic),
    close: () => {
      over = true
      box.close()
    }
  }
}

/** A new device asking to be the person: what it shows, and how to let it in. */
export type Request = {check: string; give: (secrets: Given) => void}

/** The side of the device that is already the person: waits for a new device to ask. */
export function awaitRequest(link: DeviceLink, mailboxes: OpenMailbox, onRequest: (request: Request) => void): () => void {
  const topic = topicOf(link.token)
  const seen = new Set<string>()
  let over = false
  const box = mailboxes(topic, undefined, {
    onEnvelope: envelope =>
      void unlock(link.token, envelope).then(message => {
        const dhPublic = message?.w
        if (over || !(dhPublic instanceof Uint8Array) || dhPublic.length !== 32 || seen.has(toHex(dhPublic))) return
        seen.add(toHex(dhPublic))
        onRequest({
          check: checkNumber(link.token, dhPublic),
          give: secrets => {
            const keys = new Uint8Array(encode({n: secrets.name, s: secrets.signSecret, d: secrets.dhSecret, t: secrets.device}))
            const sealed = sealForMembers(topic, keys, [{id: topic, dhPublic}])
            leave(box, sealed.then(g => lock(link.token, {g})), () => over)
          }
        })
      })
  })
  // Kept open a little longer, so that what was just given still reaches the relay.
  return () =>
    setTimeout(() => {
      over = true
      box.close()
    }, 15_000)
}

/** A tag for a device that was just added; the person's first device has none. */
export const newDeviceTag = () => toHex(crypto.getRandomValues(new Uint8Array(DEVICE_BYTES)))
