import {ed25519, x25519} from '@noble/curves/ed25519.js'
import {sha256} from '@noble/hashes/sha2.js'
import {toHex} from './bytes'

export const MAX_NAME_LENGTH = 64

/** The secrets that make up one person on one device. */
export type IdentitySecrets = {
  name: string
  /** Ed25519 key that signs every message. */
  signSecret: Uint8Array
  /** X25519 key, used from Phase 4 to derive direct-message keys. */
  dhSecret: Uint8Array
}

export type Identity = IdentitySecrets & {
  /** Hash of the signing public key; how other members refer to this person. */
  id: string
  signPublic: Uint8Array
  dhPublic: Uint8Array
}

export const memberId = (signPublic: Uint8Array) => toHex(sha256(signPublic))

export const cleanName = (name: string) => name.trim().slice(0, MAX_NAME_LENGTH)

export function loadIdentity(secrets: IdentitySecrets): Identity {
  const signPublic = ed25519.getPublicKey(secrets.signSecret)
  return {...secrets, id: memberId(signPublic), signPublic, dhPublic: x25519.getPublicKey(secrets.dhSecret)}
}

export function createIdentity(name: string): Identity {
  return loadIdentity({
    name: cleanName(name),
    signSecret: ed25519.utils.randomSecretKey(),
    dhSecret: x25519.utils.randomSecretKey()
  })
}
