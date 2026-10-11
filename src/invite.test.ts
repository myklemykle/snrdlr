import {encode} from 'cbor-x'
import {describe, expect, it} from 'vitest'
import {toBase64Url} from './bytes'
import {decodeInvite, encodeInvite, inviteFromFragment, inviteToFragment} from './invite'
import {generateGroupSecret} from './keys'

describe('invite', () => {
  it('round-trips through the URL fragment', () => {
    const invite = {secret: generateGroupSecret(), name: 'Hütte ⛰️'}
    expect(inviteFromFragment(inviteToFragment(invite))).toEqual(invite)
  })

  it('stays small enough for one easy-to-scan QR code', () => {
    const payload = encodeInvite({secret: generateGroupSecret(), name: 'x'.repeat(64)})
    expect(payload.length).toBeLessThan(200)
  })

  it('uses only URL-safe characters', () => {
    expect(encodeInvite({secret: new Uint8Array(32).fill(255), name: 'a'})).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('ignores fragments that are not invites', () => {
    expect(inviteFromFragment('')).toBeNull()
    expect(inviteFromFragment('#about')).toBeNull()
    expect(inviteFromFragment('#i=')).toBeNull()
    expect(inviteFromFragment('#i=not base64!')).toBeNull()
  })

  it('rejects unknown versions and malformed fields', () => {
    const secret = generateGroupSecret()
    const pack = (value: unknown) => toBase64Url(encode(value))
    expect(() => decodeInvite(pack({v: 2, g: secret, n: 'a'}))).toThrow(/version/)
    expect(() => decodeInvite(pack({v: 1, g: secret.slice(0, 16), n: 'a'}))).toThrow(/secret/)
    expect(() => decodeInvite(pack({v: 1, g: 'text', n: 'a'}))).toThrow(/secret/)
    expect(() => decodeInvite(pack({v: 1, g: secret, n: 5}))).toThrow(/name/)
    expect(() => decodeInvite(pack({v: 1, g: secret, n: 'x'.repeat(65)}))).toThrow(/name/)
    expect(() => decodeInvite(pack('just a string'))).toThrow()
  })
})
