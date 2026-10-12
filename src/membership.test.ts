import {describe, expect, it} from 'vitest'
import {createIdentity} from './identity'
import {checkProof, issueCert, makeProof, makeRoster, openCert, verifyChain, type Policy} from './membership'

const CHAT = 'a'.repeat(64)
const OTHER_CHAT = 'b'.repeat(64)
const [founder, anne, bob, mallory] = ['Founder', 'Anne', 'Bob', 'Mallory'].map(createIdentity)

// founder -> anne -> bob
const anneCert = issueCert(CHAT, founder, anne, 1)
const bobCert = issueCert(CHAT, anne, bob, 2)
const bobChain = [anneCert, bobCert]
const group: Policy = {kind: 'group', founder: founder.signPublic}
const binding = new Uint8Array(40).fill(7)

describe('certificates', () => {
  it('round-trip and name who admitted whom', () => {
    const cert = openCert(CHAT, bobCert)
    expect([...cert.subject]).toEqual([...bob.signPublic])
    expect([...cert.subjectDh]).toEqual([...bob.dhPublic])
    expect([...cert.issuer]).toEqual([...anne.signPublic])
    expect(cert.issuedAt).toBe(2)
  })

  it('are only valid in the chat they were issued for', () => {
    expect(() => openCert(OTHER_CHAT, bobCert)).toThrow(/not valid/)
  })

  it('reject any changed byte', () => {
    for (let i = 0; i < bobCert.length; i++) {
      const tampered = new Uint8Array(bobCert)
      tampered[i] ^= 1
      expect(() => openCert(CHAT, tampered), `byte ${i}`).toThrow()
    }
  })
})

describe('verifyChain', () => {
  it('accepts the founder with no certificates, and members with an unbroken chain', () => {
    expect(verifyChain(CHAT, founder.signPublic, [], founder.signPublic)).toBe(true)
    expect(verifyChain(CHAT, founder.signPublic, [anneCert], anne.signPublic)).toBe(true)
    expect(verifyChain(CHAT, founder.signPublic, bobChain, bob.signPublic)).toBe(true)
  })

  it('rejects someone with no chain, a borrowed chain, or a chain from the wrong founder', () => {
    expect(verifyChain(CHAT, founder.signPublic, [], mallory.signPublic)).toBe(false)
    expect(verifyChain(CHAT, founder.signPublic, bobChain, mallory.signPublic)).toBe(false)
    expect(verifyChain(CHAT, mallory.signPublic, bobChain, bob.signPublic)).toBe(false)
  })

  it('rejects a chain with a missing or out-of-order link', () => {
    expect(verifyChain(CHAT, founder.signPublic, [bobCert], bob.signPublic)).toBe(false)
    expect(verifyChain(CHAT, founder.signPublic, [bobCert, anneCert], bob.signPublic)).toBe(false)
  })

  it('rejects a certificate signed by someone who is not a member', () => {
    // Mallory holds the chat secret, so she can compute the chat ID, but nobody admitted her.
    const selfIssued = issueCert(CHAT, mallory, mallory, 3)
    expect(verifyChain(CHAT, founder.signPublic, [selfIssued], mallory.signPublic)).toBe(false)
    const forgedIssuer = issueCert(CHAT, {signSecret: mallory.signSecret, signPublic: founder.signPublic}, mallory, 3)
    expect(verifyChain(CHAT, founder.signPublic, [forgedIssuer], mallory.signPublic)).toBe(false)
  })

  it('rejects an absurdly long chain', () => {
    expect(verifyChain(CHAT, founder.signPublic, Array(33).fill(anneCert), anne.signPublic)).toBe(false)
  })
})

describe('connection proof', () => {
  it('identifies a genuine member', () => {
    expect(checkProof(CHAT, group, makeProof(CHAT, bob, bobChain, binding), binding)).toBe(bob.id)
    expect(checkProof(CHAT, group, makeProof(CHAT, founder, [], binding), binding)).toBe(founder.id)
  })

  it('rejects a non-member, even one who knows the chat', () => {
    expect(checkProof(CHAT, group, makeProof(CHAT, mallory, [], binding), binding)).toBeNull()
    expect(checkProof(CHAT, group, makeProof(CHAT, mallory, bobChain, binding), binding)).toBeNull()
  })

  it('rejects a genuine proof replayed on a different connection or in a different chat', () => {
    const proof = makeProof(CHAT, bob, bobChain, binding)
    expect(checkProof(CHAT, group, proof, new Uint8Array(40).fill(8))).toBeNull()
    expect(checkProof(OTHER_CHAT, group, proof, binding)).toBeNull()
  })

  it('rejects a member\'s chain presented with someone else\'s signature', () => {
    const stolen = makeProof(CHAT, {signSecret: mallory.signSecret, signPublic: bob.signPublic}, bobChain, binding)
    expect(checkProof(CHAT, group, stolen, binding)).toBeNull()
  })

  it('never throws on junk', () => {
    for (const junk of [new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(500).fill(255)]) {
      expect(checkProof(CHAT, group, junk, binding)).toBeNull()
    }
  })

  it('admits exactly the two members of a direct chat', () => {
    const dm: Policy = {kind: 'dm', members: [anne.signPublic, bob.signPublic]}
    expect(checkProof(CHAT, dm, makeProof(CHAT, anne, [], binding), binding)).toBe(anne.id)
    expect(checkProof(CHAT, dm, makeProof(CHAT, bob, [], binding), binding)).toBe(bob.id)
    expect(checkProof(CHAT, dm, makeProof(CHAT, mallory, [], binding), binding)).toBeNull()
    // Nobody can be added to a direct chat by certificate.
    const cert = issueCert(CHAT, anne, mallory, 1)
    expect(checkProof(CHAT, dm, makeProof(CHAT, mallory, [cert], binding), binding)).toBeNull()
  })
})

describe('roster', () => {
  it('starts with the founder and grows with each genuine certificate', () => {
    const roster = makeRoster(CHAT, group)
    expect(roster.has(founder.id)).toBe(true)
    expect(roster.has(anne.id)).toBe(false)

    expect(roster.add([anneCert])).toBe(true)
    expect(roster.has(anne.id)).toBe(true)
    expect(roster.add([anneCert])).toBe(false)
  })

  it('keeps a certificate whose issuer is not yet known until they are', () => {
    const roster = makeRoster(CHAT, group)
    expect(roster.add([bobCert])).toBe(false)
    expect(roster.has(bob.id)).toBe(false)

    expect(roster.add([anneCert])).toBe(true)
    expect(roster.has(bob.id)).toBe(true)
  })

  it('ignores certificates that are forged, self-issued, or from another chat', () => {
    const roster = makeRoster(CHAT, group)
    const forged = new Uint8Array(anneCert)
    forged[forged.length - 1] ^= 1
    const added = roster.add([
      forged,
      issueCert(CHAT, mallory, mallory, 1),
      issueCert(OTHER_CHAT, founder, mallory, 1),
      new Uint8Array([9, 9, 9])
    ])
    expect(added).toBe(false)
    expect(roster.has(mallory.id)).toBe(false)
    expect(roster.has(anne.id)).toBe(false)
  })

  it('does not let a chain grow past the limit', () => {
    const roster = makeRoster(CHAT, group)
    let holder = founder
    const people = Array.from({length: 33}, (_, i) => createIdentity(`P${i}`))
    for (const person of people) {
      roster.add([issueCert(CHAT, holder, person, 1)])
      holder = person
    }
    expect(roster.has(people[31].id)).toBe(true)
    expect(roster.has(people[32].id)).toBe(false)
  })

  it('in a direct chat is exactly the two people, whatever certificates say', () => {
    const roster = makeRoster(CHAT, {kind: 'dm', members: [anne.signPublic, bob.signPublic]})
    expect(roster.add([issueCert(CHAT, anne, mallory, 1)])).toBe(false)
    expect([anne, bob, mallory, founder].map(person => roster.has(person.id))).toEqual([true, true, false, false])
  })
})
