import {describe, expect, it} from 'vitest'
import {admit, authFor, chatFromGrant, chatFromGroupInvite, chatKeys, dmContext, groupFromDirect, newGroupChat, pairDirect} from './chats'
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

/** Runs the "chat with me" exchange: `shower` shows a code, `scanner` redeems it. Returns each side's chat. */
function pair(shower: typeof anne, scanner: typeof bob) {
  const code = createInvite(shower)
  const {chat, sealedGrant} = pairDirect(shower, code, sealJoinRequest(scanner, code), [], 1)
  return {showers: chat, scanners: chatFromGrant(code, sealedGrant, scanner, 2)}
}

describe('direct chats', () => {
  it('give both people the same chat, named after the other, without a secret ever being sent', () => {
    const {showers, scanners} = pair(anne, bob)
    expect(scanners.id).toBe(showers.id)
    expect([...chatKeys(scanners).msgKey]).toEqual([...chatKeys(showers).msgKey])
    expect(showers).toMatchObject({kind: 'dm', name: 'Bob', chain: []})
    expect(scanners).toMatchObject({kind: 'dm', name: 'Anne', chain: []})
  })

  it('are the same chat however many times, and whichever way round, the two pair', () => {
    expect(pair(bob, anne).showers.id).toBe(pair(anne, bob).showers.id)
  })

  it('differ for every pair of people', () => {
    expect(pair(anne, cindy).showers.id).not.toBe(pair(anne, bob).showers.id)
  })

  it('admit only the two of them, and nobody by certificate', () => {
    const {showers, scanners} = pair(anne, bob)
    expect(authFor(showers, anne).verify(authFor(scanners, bob).prove(binding), binding)).toBe(bob.id)
    expect(authFor(scanners, bob).verify(authFor(showers, anne).prove(binding), binding)).toBe(anne.id)
    // Mallory copies Bob's record of the chat; her key is neither of the two.
    expect(authFor(showers, anne).verify(authFor({...scanners}, mallory).prove(binding), binding)).toBeNull()
    // A direct chat has no invites to redeem.
    const code = createInvite(anne)
    expect(() => admit(showers, anne, code, sealJoinRequest(cindy, code), 3)).toThrow(/only groups/)
  })

  it('use a placeholder name until the scanner has chosen one, avoiding names in use', () => {
    const code = createInvite(anne)
    const nameless = {...bob, name: ''}
    expect(pairDirect(anne, code, sealJoinRequest(nameless, code), ['Direct chat'], 1).chat.name).toBe('Direct chat 2')
  })

  it('cannot be made with oneself', () => {
    const code = createInvite(anne)
    expect(() => pairDirect(anne, code, sealJoinRequest(anne, code), [], 1)).toThrow()
  })
})

describe('adding someone from a direct chat', () => {
  const {showers: annesDm} = pair(anne, bob)

  it('founds a new group that the other person can enter from the message', () => {
    const {chat: group, invite: message} = groupFromDirect(anne, annesDm, 'Group with Bob', [], 5)
    expect(group).toMatchObject({kind: 'group', name: 'Group with Bob', chain: []})
    expect(group.id).not.toBe(annesDm.id)

    const bobs = chatFromGroupInvite(message, anne.signPublic, bob, 6)
    expect(bobs.id).toBe(group.id)
    expect(authFor(group, anne).verify(authFor(bobs, bob).prove(binding), binding)).toBe(bob.id)

    // The third person then joins the group through its own code, from either member.
    const cindys = invite(bobs, bob, cindy)
    expect(authFor(group, anne).verify(authFor(cindys, cindy).prove(binding), binding)).toBe(cindy.id)
  })

  it('refuses an invite that names a founder other than its sender, or admits someone else', () => {
    const {invite: message} = groupFromDirect(anne, annesDm, 'Group', [], 5)
    expect(() => chatFromGroupInvite(message, mallory.signPublic, bob, 6)).toThrow(/founder/)
    expect(() => chatFromGroupInvite(message, anne.signPublic, cindy, 6)).toThrow(/does not admit/)
  })

  it('is only possible from a direct chat', () => {
    expect(() => groupFromDirect(anne, newGroupChat(anne, 'Cabin', [], 0), 'Group', [], 5)).toThrow(/not a direct chat/)
  })
})
