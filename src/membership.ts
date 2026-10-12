// Who may be in a chat, and how a connection proves it.
//
// Groups: a member holds a chain of certificates leading from the chat's founder to themselves, each
// one signed by an existing member admitting the next. Knowing the chat's secret is not enough.
// DMs: the two members are fixed when the chat is made.
//
// On every new connection each side proves it holds a member's signing key, with a signature bound to
// that particular connection so it cannot be relayed by someone sitting in the middle.
import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {bytesEqual, concatBytes, utf8} from './bytes'
import {memberId} from './identity'

export const MAX_CHAIN_LENGTH = 32

export type Policy = {kind: 'group'; founder: Uint8Array} | {kind: 'dm'; members: [Uint8Array, Uint8Array]}

type Signer = {signSecret: Uint8Array; signPublic: Uint8Array}

export type Cert = {
  /** The admitted member's signing key. */
  subject: Uint8Array
  /** Their X25519 key, vouched for alongside it. */
  subjectDh: Uint8Array
  /** The member who admitted them. */
  issuer: Uint8Array
  issuedAt: number
  signature: Uint8Array
}

const isKey = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length === 32

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return bytes
}

function verify(signature: Uint8Array, message: Uint8Array, key: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, key)
  } catch {
    // An invalid key or signature encoding is just a failed verification.
    return false
  }
}

// Every field has a fixed length, so the concatenation is unambiguous.
const certBytes = (chatId: string, cert: Omit<Cert, 'signature'>) =>
  concatBytes(utf8('snrdlr/v1/cert\0'), utf8(chatId), cert.subject, cert.subjectDh, cert.issuer, u64(cert.issuedAt))

export function issueCert(
  chatId: string,
  issuer: Signer,
  subject: {signPublic: Uint8Array; dhPublic: Uint8Array},
  issuedAt: number
): Uint8Array {
  const cert = {subject: subject.signPublic, subjectDh: subject.dhPublic, issuer: issuer.signPublic, issuedAt}
  const signature = ed25519.sign(certBytes(chatId, cert), issuer.signSecret)
  return new Uint8Array(encode({k: cert.subject, d: cert.subjectDh, i: cert.issuer, t: issuedAt, s: signature}))
}

/** Decodes a certificate and checks its signature for this chat. Throws if it is malformed or not genuine. */
export function openCert(chatId: string, bytes: Uint8Array): Cert {
  // Decoded from a copy: the decoder leaves a property behind on the array it is given.
  const raw = decode(new Uint8Array(bytes)) as Record<string, unknown> | null
  if (typeof raw !== 'object' || raw === null) throw new Error('malformed certificate')
  const {k, d, i, t, s} = raw
  if (!isKey(k) || !isKey(d) || !isKey(i)) throw new Error('malformed certificate keys')
  if (!Number.isSafeInteger(t) || (t as number) < 0) throw new Error('malformed certificate time')
  if (!(s instanceof Uint8Array) || s.length !== 64) throw new Error('malformed certificate signature')
  const cert: Cert = {
    subject: new Uint8Array(k),
    subjectDh: new Uint8Array(d),
    issuer: new Uint8Array(i),
    issuedAt: t as number,
    signature: new Uint8Array(s)
  }
  if (!verify(cert.signature, certBytes(chatId, cert), cert.issuer)) throw new Error('certificate signature is not valid')
  return cert
}

/** True if the chain leads, certificate by certificate, from the founder to `subject`. The founder needs none. */
export function verifyChain(chatId: string, founder: Uint8Array, chain: Uint8Array[], subject: Uint8Array): boolean {
  if (chain.length > MAX_CHAIN_LENGTH) return false
  let holder = founder
  try {
    for (const bytes of chain) {
      const cert = openCert(chatId, bytes)
      if (!bytesEqual(cert.issuer, holder)) return false
      holder = cert.subject
    }
  } catch {
    return false
  }
  return bytesEqual(holder, subject)
}

export function isMember(chatId: string, policy: Policy, key: Uint8Array, chain: Uint8Array[]): boolean {
  if (policy.kind === 'dm') return chain.length === 0 && policy.members.some(member => bytesEqual(member, key))
  return verifyChain(chatId, policy.founder, chain, key)
}

const MAX_WAITING_CERTS = 256

/**
 * Who is known to belong to a chat, built up from certificates as they are seen. A certificate proves
 * itself, so it counts wherever it was found; one whose issuer is not yet known waits until they are.
 */
export function makeRoster(chatId: string, policy: Policy) {
  // Member ID to how many certificates separate them from the founder.
  const depth = new Map<string, number>()
  let waiting: Cert[] = []
  if (policy.kind === 'dm') for (const member of policy.members) depth.set(memberId(member), 0)
  else depth.set(memberId(policy.founder), 0)

  const admit = (cert: Cert): boolean => {
    const issuerDepth = depth.get(memberId(cert.issuer))
    if (issuerDepth === undefined || issuerDepth >= MAX_CHAIN_LENGTH) return false
    const subject = memberId(cert.subject)
    if (!depth.has(subject)) depth.set(subject, issuerDepth + 1)
    return true
  }

  return {
    has: (id: string) => depth.has(id),
    /** Takes in certificates, ignoring any that are not genuine. Returns true if someone new is now a member. */
    add(certs: Uint8Array[]): boolean {
      if (policy.kind === 'dm') return false
      const before = depth.size
      for (const bytes of certs) {
        try {
          waiting.push(openCert(chatId, bytes))
        } catch {
          // Not a valid certificate for this chat.
        }
      }
      for (let progressed = true; progressed; ) {
        const stillWaiting = waiting.filter(cert => !admit(cert))
        progressed = stillWaiting.length < waiting.length
        waiting = stillWaiting
      }
      waiting = waiting.slice(-MAX_WAITING_CERTS)
      return depth.size > before
    }
  }
}

export type Roster = ReturnType<typeof makeRoster>

const proofBytes = (chatId: string, binding: Uint8Array) => concatBytes(utf8('snrdlr/v1/auth\0'), utf8(chatId), binding)

/** Our side of the connection check: who we are, why we belong, and a signature over this connection. */
export function makeProof(chatId: string, member: Signer, chain: Uint8Array[], binding: Uint8Array): Uint8Array {
  const signature = ed25519.sign(proofBytes(chatId, binding), member.signSecret)
  return new Uint8Array(encode({k: member.signPublic, c: chain, s: signature}))
}

/** Checks the other side's proof. Returns their member ID, or null if they should not be let in. */
export function checkProof(chatId: string, policy: Policy, proof: Uint8Array, binding: Uint8Array): string | null {
  try {
    const raw = decode(proof) as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) return null
    const {k, c, s} = raw
    if (!isKey(k) || !(s instanceof Uint8Array) || s.length !== 64) return null
    if (!Array.isArray(c) || !c.every(entry => entry instanceof Uint8Array)) return null
    if (!isMember(chatId, policy, k, c as Uint8Array[])) return null
    if (!verify(s, proofBytes(chatId, binding), k)) return null
    return memberId(k)
  } catch {
    return null
  }
}
