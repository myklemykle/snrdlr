// Files left with our relay, for members who are away: pictures, voice messages and profile photos.
//
// A file is already sealed with a key of its own, which only the message that refers to it carries
// (files.ts), so the relay keeps it as it is, unable to open it. It goes in pieces small enough for one
// message each, under a topic of its own worked out from the chat's store topic and the file's hash, so
// that the relay sees only another random-looking topic, and a big file never pushes a chat's messages
// out of the relay's per-topic allowance. Like messages, it is kept for 30 days.
import {sha256} from '@noble/hashes/sha2.js'
import {decode, encode} from 'cbor-x'
import {concatBytes, fromHex, toHex, utf8} from './bytes'
import {fileHash, MAX_FILE_BYTES} from './files'
import type {OpenMailbox} from './mailbox'

/** Bytes of file in each piece: with its wrapping and encoding, comfortably inside one relay message. */
export const PIECE_BYTES = 40_000
const MAX_PIECES = Math.ceil(MAX_FILE_BYTES / PIECE_BYTES)

export const fileTopic = (storeTopic: string, hash: string) => toHex(sha256(concatBytes(utf8('snrdlr/v1/file'), utf8(storeTopic), fromHex(hash))))

/** Leaves a file with the relay, piece by piece. True once every piece is kept. */
export async function leaveFile(open: OpenMailbox, storeTopic: string, hash: string, data: Uint8Array): Promise<boolean> {
  // Only for posting: from now on, so nothing already kept is sent back.
  const box = open(fileTopic(storeTopic, hash), Date.now(), {onEnvelope: () => {}})
  try {
    const count = Math.ceil(data.length / PIECE_BYTES)
    for (let index = 0; index < count; index++) {
      const piece = new Uint8Array(encode({i: index, n: count, d: data.subarray(index * PIECE_BYTES, (index + 1) * PIECE_BYTES)}))
      if (!(await box.post(piece, Date.now()))) return false
    }
    return true
  } finally {
    box.close()
  }
}

/**
 * Collects a file from the relay. Resolves with it once every piece has come and it is the very file
 * named (its size and hash, from the signed message), or with null if the relay does not have it all.
 */
export function fetchFile(open: OpenMailbox, storeTopic: string, hash: string, size: number, timeoutMs = 30_000): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    const pieces = new Map<number, Uint8Array>()
    let count = 0
    let done = false
    const finish = (data: Uint8Array | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      box.close()
      resolve(data)
    }
    const complete = () => count > 0 && pieces.size >= count
    const whole = async () => {
      const data = new Uint8Array([...pieces.values()].reduce((sum, piece) => sum + piece.length, 0))
      let at = 0
      for (let index = 0; index < count; index++) {
        data.set(pieces.get(index)!, at)
        at += pieces.get(index)!.length
      }
      finish(data.length === size && (await fileHash(data)) === hash ? data : null)
    }
    const box = open(fileTopic(storeTopic, hash), undefined, {
      onEnvelope: envelope => {
        if (done) return
        try {
          const {i, n, d} = decode(envelope) as {i: unknown; n: unknown; d: unknown}
          const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
          if (!isCount(i) || !isCount(n) || n < 1 || n > MAX_PIECES || i >= n || !(d instanceof Uint8Array) || d.length > PIECE_BYTES) return
          if (count && n !== count) return
          count = n
          pieces.set(i, new Uint8Array(d))
          if (complete()) void whole()
        } catch {
          // Not a piece of a file.
        }
      },
      // Everything the relay holds has come; without all of it, the file is not there.
      onCaughtUp: () => !complete() && finish(null)
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}
