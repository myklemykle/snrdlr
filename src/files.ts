// Files that travel beside the message log, such as images. Each is encrypted with a key of its own,
// which lives in the message that refers to it. Whoever holds only the encrypted file (another
// member passing it on, or later a bot) can store and serve it, and check it is intact, without
// being able to open it.
import {toHex} from './bytes'

export const FILE_KEY_BYTES = 32
/** The largest encrypted file a device will accept. Images are shrunk well below this before sending. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
const NONCE_BYTES = 12

export type SealedFile = {
  /** Nonce, then ciphertext. This is what is stored and sent. */
  data: Uint8Array
  key: Uint8Array
  /** SHA-256 of `data`, in hex: the file's name everywhere. */
  hash: string
}

const importKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function fileHash(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))))
}

export async function sealFile(plain: Uint8Array): Promise<SealedFile> {
  const key = crypto.getRandomValues(new Uint8Array(FILE_KEY_BYTES))
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, await importKey(key), new Uint8Array(plain)))
  const data = new Uint8Array(NONCE_BYTES + ciphertext.length)
  data.set(nonce)
  data.set(ciphertext, NONCE_BYTES)
  return {data, key, hash: await fileHash(data)}
}

/** Throws if the file was altered or the key is wrong. */
export async function openFile(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (data.length <= NONCE_BYTES) throw new Error('file too short')
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(data.subarray(0, NONCE_BYTES))}, await importKey(key), new Uint8Array(data.subarray(NONCE_BYTES)))
  return new Uint8Array(plain)
}
