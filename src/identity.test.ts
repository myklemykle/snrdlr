import {describe, expect, it} from 'vitest'
import {createIdentity, loadIdentity} from './identity'

describe('identity', () => {
  it('creates distinct identities with a 32-byte hash as the member ID', () => {
    const anne = createIdentity('Anne')
    const bob = createIdentity('Bob')
    expect(anne.id).toMatch(/^[0-9a-f]{64}$/)
    expect(anne.id).not.toBe(bob.id)
    expect(anne.signPublic).toHaveLength(32)
    expect(anne.dhPublic).toHaveLength(32)
  })

  it('rebuilds the same identity from its stored secrets', () => {
    const anne = createIdentity('Anne')
    const reloaded = loadIdentity({name: anne.name, signSecret: anne.signSecret, dhSecret: anne.dhSecret})
    expect(reloaded.id).toBe(anne.id)
    expect([...reloaded.dhPublic]).toEqual([...anne.dhPublic])
  })

  it('trims and caps the display name', () => {
    expect(createIdentity('  Anne  ').name).toBe('Anne')
    expect(createIdentity('x'.repeat(100)).name).toHaveLength(64)
  })
})
