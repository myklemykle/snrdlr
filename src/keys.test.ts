import {describe, expect, it} from 'vitest'
import {deriveChatKeys, generateGroupSecret} from './keys'

describe('deriveChatKeys', () => {
  it('is deterministic, so both phones land in the same room', () => {
    const secret = generateGroupSecret()
    expect(deriveChatKeys(secret)).toEqual(deriveChatKeys(new Uint8Array(secret)))
  })

  it('matches a fixed vector, so a refactor cannot silently change rooms', () => {
    const keys = deriveChatKeys(new Uint8Array(32).fill(7))
    expect(keys).toMatchInlineSnapshot(`
      {
        "roomId": "a6e49084a4d52aa6c4e522484deb77a457bfac73d5608876e2403fe2dfd22122",
        "sdpPassword": "-Yeh49tjbf8mZfyUEXvpX-oybVkGYxas56ha4ey0HNg",
      }
    `)
  })

  it('gives different secrets different rooms and passwords', () => {
    const a = deriveChatKeys(generateGroupSecret())
    const b = deriveChatKeys(generateGroupSecret())
    expect(a.roomId).not.toBe(b.roomId)
    expect(a.sdpPassword).not.toBe(b.sdpPassword)
  })

  it('separates the room id from the SDP password', () => {
    const keys = deriveChatKeys(new Uint8Array(32).fill(7))
    expect(keys.roomId).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.sdpPassword).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('rejects a secret of the wrong length', () => {
    expect(() => deriveChatKeys(new Uint8Array(16))).toThrow()
  })
})
