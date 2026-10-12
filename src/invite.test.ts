import {encode} from 'cbor-x'
import {describe, expect, it} from 'vitest'
import {toBase64Url} from './bytes'
import {createIdentity} from './identity'
import {createInvite, decodeInvite, encodeInvite, inviteFromFragment, inviteToFragment, openGrant, sealGrant} from './invite'
import {deriveChatKeys, deriveInviteKeys, generateGroupSecret} from './keys'

const pack = (value: unknown) => toBase64Url(encode(value))

describe('invite', () => {
  it('round-trips through the URL fragment', () => {
    const invite = createInvite(createIdentity('Anne'))
    const decoded = inviteFromFragment(inviteToFragment(invite))!
    expect([...decoded.token]).toEqual([...invite.token])
    expect([...decoded.inviter]).toEqual([...invite.inviter])
  })

  it('is fresh every time and carries nothing derived from the chat', () => {
    const anne = createIdentity('Anne')
    const secret = generateGroupSecret()
    const [first, second] = [createInvite(anne), createInvite(anne)]
    expect([...first.token]).not.toEqual([...second.token])

    // The invite room is unrelated to the chat's own room.
    expect(deriveInviteKeys(first.token).roomId).not.toBe(deriveChatKeys(secret).roomId)
    expect(deriveInviteKeys(first.token).roomId).not.toBe(deriveChatKeys(first.token).roomId)
  })

  it('stays small enough for one easy-to-scan QR code, in URL-safe characters', () => {
    const payload = encodeInvite(createInvite(createIdentity('Anne')))
    expect(payload.length).toBeLessThan(120)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('ignores fragments that are not invites', () => {
    expect(inviteFromFragment('')).toBeNull()
    expect(inviteFromFragment('#c=abc')).toBeNull()
    expect(inviteFromFragment('#i=')).toBeNull()
    expect(inviteFromFragment('#i=not base64!')).toBeNull()
  })

  it('rejects the old invite format, which carried the chat secret itself', () => {
    const old = pack({v: 1, g: generateGroupSecret(), n: 'Chat'})
    expect(() => decodeInvite(old)).toThrow(/version/)
    expect(inviteFromFragment(`#i=${old}`)).toBeNull()
  })

  it('rejects malformed fields', () => {
    const {token, inviter} = createInvite(createIdentity('Anne'))
    expect(() => decodeInvite(pack({v: 2, t: token.slice(0, 16), k: inviter}))).toThrow(/token/)
    expect(() => decodeInvite(pack({v: 2, t: 'text', k: inviter}))).toThrow(/token/)
    expect(() => decodeInvite(pack({v: 2, t: token, k: inviter.slice(0, 8)}))).toThrow(/inviter/)
    expect(() => decodeInvite(pack({v: 2, t: token}))).toThrow(/inviter/)
    expect(() => decodeInvite(pack('just a string'))).toThrow()
  })
})

describe('grant', () => {
  const anne = createIdentity('Anne')
  const chat = {secret: generateGroupSecret(), name: 'Cabin weekend ⛰️'}

  it('delivers the chat secret and name to the joiner', () => {
    const invite = createInvite(anne)
    const grant = openGrant(invite, sealGrant(anne, invite, chat))
    expect([...grant.secret]).toEqual([...chat.secret])
    expect(grant.name).toBe(chat.name)
  })

  it('rejects a grant from anyone but the inviter named in the code', () => {
    // Mallory saw the live code and joined the invite room alongside Bob, hoping to steer him into her chat.
    const invite = createInvite(anne)
    const mallory = createIdentity('Mallory')
    const forged = sealGrant(mallory, invite, {secret: generateGroupSecret(), name: chat.name})
    expect(() => openGrant(invite, forged)).toThrow(/not signed by the inviter/)
  })

  it('rejects a grant reused from another invite', () => {
    const [first, second] = [createInvite(anne), createInvite(anne)]
    expect(() => openGrant(second, sealGrant(anne, first, chat))).toThrow(/not signed by the inviter/)
  })

  it('rejects a grant whose contents were changed', () => {
    const invite = createInvite(anne)
    const sealed = sealGrant(anne, invite, chat)
    for (let i = 0; i < sealed.length; i++) {
      const tampered = new Uint8Array(sealed)
      tampered[i] ^= 1
      expect(() => openGrant(invite, tampered), `byte ${i}`).toThrow()
    }
  })
})
