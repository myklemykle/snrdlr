import {describe, expect, it, vi} from 'vitest'
import {createIdentity} from './identity'
import {askToJoin, awaitRequest, checkNumber, linkFromFragment, linkToFragment, makeLink, type Given, type Request} from './link-device'
import type {OpenMailbox} from './mailbox'

/** A stand-in for the relay's store: keeps what is left under each topic and hands it to whoever asks. */
function makeShelf() {
  const kept = new Map<string, Uint8Array[]>()
  const listeners = new Map<string, Set<(envelope: Uint8Array) => void>>()
  const open: OpenMailbox = (topic, _collectedAt, handlers) => {
    if (!listeners.has(topic)) listeners.set(topic, new Set())
    listeners.get(topic)!.add(handlers.onEnvelope)
    queueMicrotask(() => (kept.get(topic) ?? []).forEach(envelope => handlers.onEnvelope(envelope)))
    return {
      post: async envelope => {
        kept.set(topic, [...(kept.get(topic) ?? []), envelope])
        listeners.get(topic)!.forEach(listener => listener(envelope))
        return true
      },
      close: () => void listeners.get(topic)!.delete(handlers.onEnvelope)
    }
  }
  return {open, kept}
}

describe('adding a device', () => {
  it('carries the code in a link, and refuses one that is not', () => {
    const link = makeLink('new', 1_000_000_000_000)
    const back = linkFromFragment(linkToFragment(link))
    expect(back).toEqual({...link, expires: Math.floor(link.expires / 1000) * 1000})
    expect(linkFromFragment(linkToFragment(makeLink('existing')))?.role).toBe('existing')
    for (const bad of ['#device1.x.abc.1', '#device1.n.abc.1', '#chat=1', '#device1.']) expect(linkFromFragment(bad)).toBeNull()
  })

  it.each(['new', 'existing'] as const)('gives the new device the keys, whichever device shows the code (%s)', async role => {
    const shelf = makeShelf()
    const anne = createIdentity('Anne')
    const link = makeLink(role)
    const requests: Request[] = []
    const given: Given[] = []
    // The device showing the code starts first, and the other comes along after.
    const start = [() => awaitRequest(link, shelf.open, request => requests.push(request)), () => askToJoin(link, shelf.open, keys => given.push(keys))]
    const [first, second] = role === 'new' ? [start[1], start[0]] : start
    const one = first()
    const two = second()
    const asking = ('check' in one ? one : two) as ReturnType<typeof askToJoin>
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    // Both show the same number.
    expect(requests[0].check).toBe(asking.check)
    expect(given).toEqual([])
    requests[0].give({...anne, device: '0123456789abcdef'})
    await vi.waitFor(() => expect(given).toHaveLength(1))
    expect(given[0]).toEqual({name: 'Anne', signSecret: anne.signSecret, dhSecret: anne.dhSecret, device: '0123456789abcdef'})
  })

  it('leaves nothing the relay, or anyone else watching the place, can read', async () => {
    const shelf = makeShelf()
    const anne = createIdentity('Anne')
    const link = makeLink('existing')
    // The person lets in the first device to ask, which is the one in front of them, and no other.
    const requests: Request[] = []
    awaitRequest(link, shelf.open, request => {
      requests.push(request)
      if (requests.length === 1) request.give({...anne, device: '0123456789abcdef'})
    })
    const given: Given[] = []
    askToJoin(link, shelf.open, keys => given.push(keys))
    await vi.waitFor(() => expect(given).toHaveLength(1))
    // Someone else who has seen the code asks too, but only gets what was locked to their own key.
    const snoop: Given[] = []
    askToJoin(link, shelf.open, keys => snoop.push(keys))
    await new Promise(resolve => setTimeout(resolve, 50))
    const everything = [...shelf.kept.values()].flat()
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
    for (const bytes of everything) expect(hex(bytes)).not.toContain(hex(anne.signSecret))
    // The snoop's request reaches the person, with a different number, and gets nothing unless let in.
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].check).not.toBe(requests[0].check)
    expect(snoop).toEqual([])
  })

  it('shows a different number for a different request', () => {
    const token = new Uint8Array(32).fill(3)
    expect(checkNumber(token, new Uint8Array(32).fill(1))).not.toBe(checkNumber(token, new Uint8Array(32).fill(2)))
    expect(checkNumber(token, new Uint8Array(32).fill(1))).toMatch(/^\d{3} \d{3}$/)
  })
})
