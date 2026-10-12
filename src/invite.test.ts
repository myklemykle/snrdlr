import {encode} from 'cbor-x'
import {describe, expect, it} from 'vitest'
import {toBase64Url} from './bytes'
import {createIdentity} from './identity'
import {
  createInvite,
  decodeInvite,
  encodeInvite,
  inviteFromFragment,
  inviteToFragment,
  openGrant,
  openJoinRequest,
  sealGrant,
  sealJoinRequest,
  type Grant
} from './invite'
import {generateGroupSecret} from './keys'

const pack = (value: unknown) => toBase64Url(encode(value))
const anne = createIdentity('Anne')
const bob = createIdentity('Bob')
const mallory = createIdentity('Mallory')

describe('invite', () => {
  it('round-trips through the URL fragment', () => {
    const invite = createInvite(anne)
    const decoded = inviteFromFragment(inviteToFragment(invite))!
    expect([...decoded.token]).toEqual([...invite.token])
    expect([...decoded.inviter]).toEqual([...invite.inviter])
  })

  it('is fresh every time', () => {
    expect([...createInvite(anne).token]).not.toEqual([...createInvite(anne).token])
  })

  it('stays small enough for one easy-to-scan QR code, in URL-safe characters', () => {
    const payload = encodeInvite(createInvite(anne))
    expect(payload.length).toBeLessThan(120)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('ignores fragments that are not invites', () => {
    for (const fragment of ['', '#c=abc', '#i=', '#i=not base64!']) expect(inviteFromFragment(fragment)).toBeNull()
  })

  it('rejects earlier invite formats', () => {
    const {token, inviter} = createInvite(anne)
    expect(() => decodeInvite(pack({v: 1, g: generateGroupSecret(), n: 'Chat'}))).toThrow(/version/)
    expect(() => decodeInvite(pack({v: 2, t: token, k: inviter}))).toThrow(/version/)
  })

  it('rejects malformed fields', () => {
    const {token, inviter} = createInvite(anne)
    expect(() => decodeInvite(pack({v: 3, t: token.slice(0, 16), k: inviter}))).toThrow(/token/)
    expect(() => decodeInvite(pack({v: 3, t: 'text', k: inviter}))).toThrow(/token/)
    expect(() => decodeInvite(pack({v: 3, t: token, k: inviter.slice(0, 8)}))).toThrow(/inviter/)
    expect(() => decodeInvite(pack({v: 3, t: token}))).toThrow(/inviter/)
    expect(() => decodeInvite(pack('just a string'))).toThrow()
  })
})

describe('join request', () => {
  it('tells the inviter which keys to admit', () => {
    const invite = createInvite(anne)
    const request = openJoinRequest(invite, sealJoinRequest(bob, invite))
    expect([...request.signPublic]).toEqual([...bob.signPublic])
    expect([...request.dhPublic]).toEqual([...bob.dhPublic])
  })

  it('cannot name a key the sender does not hold', () => {
    const invite = createInvite(anne)
    const forged = sealJoinRequest({signSecret: mallory.signSecret, signPublic: bob.signPublic, dhPublic: mallory.dhPublic}, invite)
    expect(() => openJoinRequest(invite, forged)).toThrow(/not signed/)
  })

  it('cannot be replayed against a different invite', () => {
    const [first, second] = [createInvite(anne), createInvite(anne)]
    expect(() => openJoinRequest(second, sealJoinRequest(bob, first))).toThrow(/not signed/)
  })

  it('rejects junk', () => {
    const invite = createInvite(anne)
    expect(() => openJoinRequest(invite, new Uint8Array(encode('junk')))).toThrow()
    expect(() => openJoinRequest(invite, new Uint8Array(encode({k: bob.signPublic})))).toThrow()
  })
})

describe('grant', () => {
  const grant: Grant = {
    secret: generateGroupSecret(),
    name: 'Cabin weekend ⛰️',
    founder: anne.signPublic,
    chain: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
  }

  it('delivers the chat secret, name, founder and certificates to the joiner', () => {
    const invite = createInvite(anne)
    const opened = openGrant(invite, sealGrant(anne, invite, grant))
    expect([...opened.secret]).toEqual([...grant.secret])
    expect(opened.name).toBe(grant.name)
    expect([...opened.founder]).toEqual([...grant.founder])
    expect(opened.chain.map(cert => [...cert])).toEqual([[1, 2, 3], [4, 5]])
  })

  it('rejects a grant from anyone but the inviter named in the code', () => {
    // Mallory saw the live code and joined the invite room alongside Bob, hoping to steer him into her chat.
    const invite = createInvite(anne)
    const forged = sealGrant(mallory, invite, {...grant, secret: generateGroupSecret()})
    expect(() => openGrant(invite, forged)).toThrow(/not signed by the inviter/)
  })

  it('rejects a grant reused from another invite', () => {
    const [first, second] = [createInvite(anne), createInvite(anne)]
    expect(() => openGrant(second, sealGrant(anne, first, grant))).toThrow(/not signed by the inviter/)
  })

  it('rejects a grant whose contents were changed', () => {
    const invite = createInvite(anne)
    const sealed = sealGrant(anne, invite, grant)
    for (let i = 0; i < sealed.length; i++) {
      const tampered = new Uint8Array(sealed)
      tampered[i] ^= 1
      expect(() => openGrant(invite, tampered), `byte ${i}`).toThrow()
    }
  })
})
