import {describe, expect, it} from 'vitest'
import {fromBase64Url} from './bytes'
import {directChat, newGroupChat} from './chats'
import {createIdentity} from './identity'
import type {OpenMailbox, PostOptions, RelayMailboxes} from './mailbox'
import {verifyChain} from './membership'
import {
  answerRemoteInvite,
  forgetRemoteInvite,
  isOpen,
  makeRemoteInvite,
  mergeInvites,
  openRemoteInvite,
  remoteFragment,
  seedFromFragment,
  watchAnswers,
  type Answer,
  type RemoteInvite
} from './remote-invite'
import {chatFromStandingInvite} from './standing-invite'

/** A stand-in for the relay's store, which also takes back what was left with a cancel tag. */
function makeRelay() {
  const kept = new Map<string, {envelope: Uint8Array; options?: PostOptions}[]>()
  const listeners = new Map<string, Set<(envelope: Uint8Array) => void>>()
  const open: OpenMailbox = (topic, _collectedAt, handlers) => {
    if (!listeners.has(topic)) listeners.set(topic, new Set())
    listeners.get(topic)!.add(handlers.onEnvelope)
    queueMicrotask(() => {
      ;(kept.get(topic) ?? []).forEach(({envelope}) => handlers.onEnvelope(envelope))
      handlers.onCaughtUp?.(Date.now())
    })
    return {
      post: async (envelope, _sentAt, _notify, options) => {
        kept.set(topic, [...(kept.get(topic) ?? []), {envelope, options}])
        listeners.get(topic)!.forEach(listener => listener(envelope))
        return true
      },
      close: () => void listeners.get(topic)!.delete(handlers.onEnvelope)
    }
  }
  const forgotten: string[][] = []
  const mailboxes = Object.assign(open, {
    say: (message: unknown[]) => {
      forgotten.push(message as string[])
      const [, topic] = message as string[]
      kept.set(topic, (kept.get(topic) ?? []).filter(({options}) => !options?.forget))
      return true
    }
  }) as RelayMailboxes
  return {open: mailboxes, kept, forgotten}
}

const anne = createIdentity('Anne')
const hour = 60 * 60_000

describe('invites from afar', () => {
  it('lets several people into a group with nobody online, until it is cancelled', async () => {
    const relay = makeRelay()
    const group = newGroupChat(anne, 'Picnic', [], 0)
    const invite = (await makeRemoteInvite(relay.open, anne, group, hour, 1000))!
    expect(invite).toMatchObject({kind: 'group', chatId: group.id, name: 'Picnic', expiresAt: 1000 + hour})
    // The relay is told when to let it go, and how it can be taken back.
    const [{options}] = [...relay.kept.values()][0]
    expect(options).toEqual({expiresAt: 1000 + hour, forget: expect.stringMatching(/^[0-9a-f]{64}$/)})

    const seed = seedFromFragment(remoteFragment(invite))!
    for (const name of ['Bob', 'Cindy']) {
      const person = createIdentity(name)
      const opened = await openRemoteInvite(relay.open, seed, 2000)
      if (opened?.kind !== 'group') throw new Error('not a group invite')
      const joined = chatFromStandingInvite(opened.standing, person, 2000)
      expect(joined.id).toBe(group.id)
      expect(verifyChain(group.id, anne.signPublic, joined.chain, person.signPublic)).toBe(true)
    }

    expect(await forgetRemoteInvite(relay.open, invite)).toBe(true)
    expect(relay.forgotten[0]).toEqual(['FORGET', expect.any(String), invite.cancel])
    expect(await openRemoteInvite(relay.open, seed, 3000)).toBeNull()
  })

  it('opens nothing once it has expired', async () => {
    const relay = makeRelay()
    const invite = (await makeRemoteInvite(relay.open, anne, newGroupChat(anne, 'Picnic', [], 0), hour, 0))!
    expect(await openRemoteInvite(relay.open, fromBase64Url(invite.seed), hour + 1)).toBeNull()
  })

  it('keeps lifetimes between a minute and a week', async () => {
    const relay = makeRelay()
    expect((await makeRemoteInvite(relay.open, anne, null, 1, 0))!.expiresAt).toBe(60_000)
    expect((await makeRemoteInvite(relay.open, anne, null, 30 * 24 * hour, 0))!.expiresAt).toBe(7 * 24 * hour)
  })

  it('makes one direct chat: both sides arrive at the same one, and the next person finds it used', async () => {
    const relay = makeRelay()
    const invite = (await makeRemoteInvite(relay.open, anne, null, hour, 0))!
    const answers: Answer[] = []
    const stop = watchAnswers(relay.open, invite, anne, answer => answers.push(answer), 10)

    const bob = createIdentity('Bob')
    const seed = fromBase64Url(invite.seed)
    const opened = await openRemoteInvite(relay.open, seed, 1000)
    if (opened?.kind !== 'dm') throw new Error('not a direct-chat invite')
    expect(opened).toMatchObject({name: 'Anne', used: false})
    const bobs = directChat(bob, opened.inviter, opened.name, 1000)
    expect(await answerRemoteInvite(relay.open, seed, opened, bob, 1000)).toBe(true)

    await expect.poll(() => answers.length).toBe(1)
    expect(answers[0].name).toBe('Bob')
    expect(directChat(anne, answers[0], answers[0].name, 1000).id).toBe(bobs.id)
    stop()

    expect(await openRemoteInvite(relay.open, seed, 2000)).toMatchObject({kind: 'dm', used: true})
  })

  it('keeps answers from anyone but the inviter, who alone can open them', async () => {
    const relay = makeRelay()
    const invite = (await makeRemoteInvite(relay.open, anne, null, hour, 0))!
    const seed = fromBase64Url(invite.seed)
    const opened = await openRemoteInvite(relay.open, seed, 0)
    if (opened?.kind !== 'dm') throw new Error('not a direct-chat invite')
    await answerRemoteInvite(relay.open, seed, opened, createIdentity('Bob'), 0)
    const heard: Answer[] = []
    // Someone else holding the link, but not Anne's keys.
    const stop = watchAnswers(relay.open, invite, createIdentity('Mallory'), answer => heard.push(answer), 10)
    await new Promise(resolve => setTimeout(resolve, 50))
    stop()
    expect(heard).toEqual([])
  })

  it('refuses links that are not invites, and invites that were made up', async () => {
    for (const bad of ['#r=', '#r=abc', '#i=xyz', '#r=' + 'A'.repeat(42)]) expect(seedFromFragment(bad)).toBeNull()
    const relay = makeRelay()
    expect(await openRemoteInvite(relay.open, crypto.getRandomValues(new Uint8Array(32)), 0)).toBeNull()
  })

  it("merges two devices' lists: closed on either means closed, and long-over invites are dropped", () => {
    const base = {cancel: 'ab'.repeat(32), kind: 'dm', name: 'Direct chat with me', createdAt: 0} as const
    const seed = (n: number) => 'A'.repeat(42) + 'AQgw'[n]
    const a: RemoteInvite = {...base, seed: seed(0), expiresAt: 10 * hour}
    const b: RemoteInvite = {...base, seed: seed(1), expiresAt: 10 * hour}
    const old: RemoteInvite = {...base, seed: seed(2), expiresAt: hour}
    const now = 25.5 * hour
    const merged = mergeInvites([a, old], [{...a, closedAt: 2 * hour}, b], now)
    expect(merged).toEqual([{...a, closedAt: 2 * hour}, b])
    expect(mergeInvites(merged, [a, b], now)).toEqual(merged)
    expect(isOpen(merged[0], 0)).toBe(false)
    expect(isOpen(merged[1], 0)).toBe(true)
    expect(isOpen(merged[1], 10 * hour)).toBe(false)
  })
})
