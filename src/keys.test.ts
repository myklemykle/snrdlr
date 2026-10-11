import {describe, expect, it} from 'vitest'
import {toHex} from './bytes'
import {deriveChatKeys, generateGroupSecret} from './keys'

describe('deriveChatKeys', () => {
  it('is deterministic, so both phones land in the same room', () => {
    const secret = generateGroupSecret()
    const [a, b] = [deriveChatKeys(secret), deriveChatKeys(new Uint8Array(secret))]
    expect([a.roomId, a.sdpPassword, toHex(a.msgKey)]).toEqual([b.roomId, b.sdpPassword, toHex(b.msgKey)])
  })

  it('matches a fixed vector, so a refactor cannot silently change rooms or keys', () => {
    const keys = deriveChatKeys(new Uint8Array(32).fill(7))
    expect(keys.roomId).toBe('a6e49084a4d52aa6c4e522484deb77a457bfac73d5608876e2403fe2dfd22122')
    expect(keys.sdpPassword).toBe('-Yeh49tjbf8mZfyUEXvpX-oybVkGYxas56ha4ey0HNg')
    expect(toHex(keys.msgKey)).toMatchInlineSnapshot(`"2fd6571110b0666708ebe1f0e1e678c462832ace6639e89a71a86df67e7c3b8e"`)
  })

  it('gives different secrets different rooms and passwords', () => {
    const a = deriveChatKeys(generateGroupSecret())
    const b = deriveChatKeys(generateGroupSecret())
    expect(a.roomId).not.toBe(b.roomId)
    expect(a.sdpPassword).not.toBe(b.sdpPassword)
    expect(toHex(a.msgKey)).not.toBe(toHex(b.msgKey))
  })

  it('derives three unrelated values of the expected shape', () => {
    const keys = deriveChatKeys(new Uint8Array(32).fill(7))
    expect(keys.msgKey).toHaveLength(32)
    expect(toHex(keys.msgKey)).not.toBe(keys.roomId)
    expect(keys.roomId).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.sdpPassword).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('rejects a secret of the wrong length', () => {
    expect(() => deriveChatKeys(new Uint8Array(16))).toThrow()
  })
})
