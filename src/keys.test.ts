import {describe, expect, it} from 'vitest'
import {toHex} from './bytes'
import {deriveChatKeys, deriveInviteKeys, generateGroupSecret} from './keys'

const founder = new Uint8Array(32).fill(1)
const flat = (keys: ReturnType<typeof deriveChatKeys>) => [keys.roomId, keys.sdpPassword, toHex(keys.msgKey)]

describe('deriveChatKeys', () => {
  it('is deterministic, so every member lands in the same room', () => {
    const secret = generateGroupSecret()
    expect(flat(deriveChatKeys(secret, founder))).toEqual(flat(deriveChatKeys(new Uint8Array(secret), new Uint8Array(founder))))
  })

  it('matches a fixed vector, so a refactor cannot silently change rooms or keys', () => {
    expect(flat(deriveChatKeys(new Uint8Array(32).fill(7), founder))).toMatchInlineSnapshot(`
      [
        "64d3bf793aed369088b646af7d85fc6cabb702b266d686d5163811f276d165b0",
        "QSGtIfHazg38awk_poWMw6YtUWf8qszhBWnib0mymsw",
        "3b35b8c1c52f72079f81a4877290653459878c3be9009b28c92bacca6c17e4f8",
      ]
    `)
  })

  it('gives different secrets different rooms, passwords and message keys', () => {
    const [a, b] = [flat(deriveChatKeys(generateGroupSecret(), founder)), flat(deriveChatKeys(generateGroupSecret(), founder))]
    for (const index of [0, 1, 2]) expect(a[index]).not.toBe(b[index])
  })

  it('ties the chat to its founder: the same secret under another founder is a different chat', () => {
    const secret = generateGroupSecret()
    const [a, b] = [flat(deriveChatKeys(secret, founder)), flat(deriveChatKeys(secret, new Uint8Array(32).fill(2)))]
    for (const index of [0, 1, 2]) expect(a[index]).not.toBe(b[index])
  })

  it('derives three unrelated values of the expected shape', () => {
    const keys = deriveChatKeys(new Uint8Array(32).fill(7), founder)
    expect(keys.roomId).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.sdpPassword).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(keys.msgKey).toHaveLength(32)
    expect(toHex(keys.msgKey)).not.toBe(keys.roomId)
  })

  it('rejects a secret of the wrong length or a missing context', () => {
    expect(() => deriveChatKeys(new Uint8Array(16), founder)).toThrow()
    expect(() => deriveChatKeys(new Uint8Array(32), new Uint8Array())).toThrow()
  })
})

describe('deriveInviteKeys', () => {
  it('names a room unrelated to any chat made from the same bytes', () => {
    const token = generateGroupSecret()
    expect(deriveInviteKeys(token).roomId).not.toBe(deriveChatKeys(token, founder).roomId)
    expect(deriveInviteKeys(token).roomId).toBe(deriveInviteKeys(new Uint8Array(token)).roomId)
  })
})
