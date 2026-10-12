import {describe, expect, it} from 'vitest'
import {admit, authFor, chatFromGrant, dmContext, newGroupChat} from './chats'
import {createIdentity} from './identity'
import {createInvite, sealJoinRequest} from './invite'

const [anne, bob, cindy, mallory] = ['Anne', 'Bob', 'Cindy', 'Mallory'].map(createIdentity)
const binding = new Uint8Array(32).fill(5)

/** Runs the invite exchange: `inviter` shows a code for `chat`, `joiner` redeems it. */
function invite(chat: ReturnType<typeof newGroupChat>, inviter: typeof anne, joiner: typeof bob) {
  const code = createInvite(inviter)
  const {sealedGrant} = admit(chat, inviter, code, sealJoinRequest(joiner, code), 1)
  return chatFromGrant(code, sealedGrant, joiner, 2)
}

describe('joining a group', () => {
  const annes = newGroupChat(anne, 'Cabin', [], 0)

  it('gives the joiner the same chat, with a chain that proves they belong', () => {
    const bobs = invite(annes, anne, bob)
    expect(bobs.id).toBe(annes.id)
    expect(bobs.name).toBe('Cabin')
    expect(bobs.chain).toHaveLength(1)

    // Each side accepts the other on a connection.
    expect(authFor(annes, anne).verify(authFor(bobs, bob).prove(binding), binding)).toBe(bob.id)
    expect(authFor(bobs, bob).verify(authFor(annes, anne).prove(binding), binding)).toBe(anne.id)
  })

  it('lets a member who was invited invite someone else', () => {
    const bobs = invite(annes, anne, bob)
    const cindys = invite(bobs, bob, cindy)
    expect(cindys.id).toBe(annes.id)
    expect(cindys.chain).toHaveLength(2)
    expect(authFor(annes, anne).verify(authFor(cindys, cindy).prove(binding), binding)).toBe(cindy.id)
  })

  it('keeps out someone who only has the chat secret', () => {
    // Mallory copied the chat record off Bob's phone but has no certificate for her own key.
    const bobs = invite(annes, anne, bob)
    const stolen = {...bobs}
    expect(authFor(annes, anne).verify(authFor(stolen, mallory).prove(binding), binding)).toBeNull()
    expect(authFor(annes, anne).verify(authFor({...stolen, chain: []}, mallory).prove(binding), binding)).toBeNull()
  })

  it('refuses a grant that does not actually admit the joiner', () => {
    const code = createInvite(anne)
    // The grant was made out for Bob's key; Mallory intercepts it.
    const {sealedGrant} = admit(annes, anne, code, sealJoinRequest(bob, code), 1)
    expect(() => chatFromGrant(code, sealedGrant, mallory, 2)).toThrow(/does not admit/)
  })

  it('returns the certificate so it can be posted to the chat', () => {
    const code = createInvite(anne)
    const {cert, sealedGrant} = admit(annes, anne, code, sealJoinRequest(bob, code), 1)
    expect([...chatFromGrant(code, sealedGrant, bob, 2).chain[0]]).toEqual([...cert])
  })
})

describe('newGroupChat', () => {
  it('is founded by its creator and avoids names already in use', () => {
    const chat = newGroupChat(anne, 'Chat', ['Chat'], 5)
    expect(chat).toMatchObject({kind: 'group', name: 'Chat 2', chain: [], createdAt: 5})
    expect([...chat.context]).toEqual([...anne.signPublic])
    expect(newGroupChat(anne, 'Chat', [], 5).id).not.toBe(chat.id)
  })
})

describe('dmContext', () => {
  it('is the same whichever of the two computes it', () => {
    expect([...dmContext(anne.signPublic, bob.signPublic)]).toEqual([...dmContext(bob.signPublic, anne.signPublic)])
    expect(dmContext(anne.signPublic, bob.signPublic)).toHaveLength(64)
  })

  it('refuses a chat with oneself', () => {
    expect(() => dmContext(anne.signPublic, anne.signPublic)).toThrow()
  })
})
