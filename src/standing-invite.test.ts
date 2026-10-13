import {describe, expect, it} from 'vitest'
import {newGroupChat} from './chats'
import {createIdentity} from './identity'
import {issueCert, makeRoster, verifyChain} from './membership'
import {chatFromStandingInvite, isStandingFragment, makeStandingInvite, standingFromFragment} from './standing-invite'

const anne = createIdentity('Anne')
const group = () => newGroupChat(anne, 'Demo', [], 0)

describe('standing invites', () => {
  it('lets someone join later with nobody at the other end, as an ordinary member', () => {
    const chat = group()
    const link = makeStandingInvite(chat, anne, 1000)
    expect(isStandingFragment(link)).toBe(true)

    const bob = createIdentity('Bob')
    const joined = chatFromStandingInvite(standingFromFragment(link)!, bob, 2000)
    expect(joined).toMatchObject({id: chat.id, kind: 'group', name: 'Demo'})
    expect(joined.secret).toEqual(chat.secret)
    // Founder to throwaway member to Bob.
    expect(joined.chain).toHaveLength(2)
    expect(verifyChain(chat.id, anne.signPublic, joined.chain, bob.signPublic)).toBe(true)

    // Any other member's device accepts Bob from those certificates alone.
    const roster = makeRoster(chat.id, {kind: 'group', founder: anne.signPublic})
    expect(roster.has(bob.id)).toBe(false)
    roster.add(joined.chain)
    expect(roster.has(bob.id)).toBe(true)
  })

  it('works from a member who is not the founder, and for several people', () => {
    const chat = group()
    const cindy = createIdentity('Cindy')
    const cindys = {...chat, chain: [issueCert(chat.id, anne, cindy, 0)]}
    const invite = standingFromFragment(makeStandingInvite(cindys, cindy, 0))!
    for (const name of ['Bob', 'Dave']) {
      const person = createIdentity(name)
      const joined = chatFromStandingInvite(invite, person, 0)
      expect(joined.chain).toHaveLength(3)
      expect(verifyChain(chat.id, anne.signPublic, joined.chain, person.signPublic)).toBe(true)
    }
  })

  it('makes a different link each time', () => {
    const chat = group()
    expect(makeStandingInvite(chat, anne, 0)).not.toBe(makeStandingInvite(chat, anne, 0))
  })

  it('refuses a link that was tampered with or made up', () => {
    const chat = group()
    const invite = standingFromFragment(makeStandingInvite(chat, anne, 0))!
    const bob = createIdentity('Bob')
    // A key that the chain does not lead to.
    expect(() => chatFromStandingInvite({...invite, key: createIdentity().signSecret}, bob, 0)).toThrow()
    // A chain for some other chat.
    const other = standingFromFragment(makeStandingInvite(group(), anne, 0))!
    expect(() => chatFromStandingInvite({...invite, chain: other.chain}, bob, 0)).toThrow()
    // Someone who is not a member cannot make one that works.
    const mallory = createIdentity('Mallory')
    const forged = standingFromFragment(makeStandingInvite(chat, mallory, 0))!
    expect(() => chatFromStandingInvite(forged, bob, 0)).toThrow()

    for (const junk of ['#s=', '#s=AAAA', '#s=not base64 !!', '#i=abc']) expect(standingFromFragment(junk)).toBeNull()
  })

  it('is for groups only', () => {
    expect(() => makeStandingInvite({...group(), kind: 'dm'}, anne, 0)).toThrow()
  })
})
