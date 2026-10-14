import {describe, expect, it} from 'vitest'
import {createIdentity} from './identity'
import {openAsMember, sealForMembers} from './store-seal'

const CHAT = 'ab'.repeat(32)

describe('locking a message for the relay', () => {
  it('opens for each member it was locked to, and for nobody else', async () => {
    const [anne, bob, mallory] = [createIdentity('Anne'), createIdentity('Bob'), createIdentity('Mallory')]
    const envelope = new Uint8Array([1, 2, 3, 4, 5])
    const stored = await sealForMembers(CHAT, envelope, [anne, bob])
    expect(await openAsMember(CHAT, stored, anne)).toEqual(envelope)
    expect(await openAsMember(CHAT, stored, bob)).toEqual(envelope)
    // Mallory may know the chat and everything shared in it; she has no member's private key.
    expect(await openAsMember(CHAT, stored, mallory)).toBeNull()
    expect(await openAsMember(CHAT, stored, {id: bob.id, dhSecret: mallory.dhSecret})).toBeNull()
  })

  it('does not open in another chat, or once altered, and tells apart two lockings of the same message', async () => {
    const anne = createIdentity('Anne')
    const envelope = new Uint8Array(100).fill(7)
    const [first, second] = [await sealForMembers(CHAT, envelope, [anne]), await sealForMembers(CHAT, envelope, [anne])]
    expect(first).not.toEqual(second)
    expect(await openAsMember('cd'.repeat(32), first, anne)).toBeNull()
    const altered = new Uint8Array(first)
    altered[altered.length - 20] ^= 1
    expect(await openAsMember(CHAT, altered, anne)).toBeNull()
    expect(await openAsMember(CHAT, new Uint8Array([1, 2, 3]), anne)).toBeNull()
  })
})
