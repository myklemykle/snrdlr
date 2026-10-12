import 'fake-indexeddb/auto'
import {describe, expect, it, vi} from 'vitest'
import {createIdentity, type Identity} from './identity'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {openSession, versionVector, type ConnectionStatus, type Wire, type WireHandlers} from './session'
import {openStore, type ChatRecord, type MessageRecord, type Store} from './store'

let counter = 0

/** An in-memory stand-in for the WebRTC room: everything sent reaches every other connected member. */
function makeNetwork() {
  const members = new Map<string, WireHandlers>()
  const dead = new Set<string>()
  const announce = () => members.forEach((handlers, id) => handlers.onPeersChange([...members.keys()].filter(peer => peer !== id)))
  const deliver = (from: string, target: string | undefined, act: (handlers: WireHandlers) => void) => {
    if (dead.has(from)) return
    members.forEach((handlers, id) => id !== from && !dead.has(id) && (!target || target === id) && act(handlers))
  }
  return {
    /** Every envelope put on the wire, with who sent it and to whom. */
    sent: [] as {from: string; to?: string; envelope: Uint8Array}[],
    joins: 0,
    /** Delivers raw bytes to one member, as a peer in the room could. */
    inject: (to: string, envelope: Uint8Array) => members.get(to)!.onEnvelope(envelope, 'injected'),
    /** Silently breaks a member's connections, as a phone does when the app is in the background. */
    kill: (peerId: string) => dead.add(peerId),
    connect(peerId: string) {
      return (_keys: unknown, handlers: WireHandlers): Wire => {
        this.joins++
        dead.delete(peerId)
        members.set(peerId, handlers)
        queueMicrotask(announce)
        return {
          send: async (envelope, target) => {
            this.sent.push({from: peerId, to: target, envelope})
            deliver(peerId, target, peer => peer.onEnvelope(envelope, peerId))
          },
          sendSync: async (have, target) => deliver(peerId, target, peer => peer.onSync(have, peerId)),
          ping: async target => {
            if (dead.has(peerId) || dead.has(target) || !members.has(target)) throw new Error('no answer')
          },
          routes: async () => [],
          leave: async () => {
            // A dead connection cannot say goodbye: the others still list this member until it rejoins.
            if (dead.has(peerId)) return
            if (members.get(peerId) === handlers) members.delete(peerId)
            announce()
          }
        }
      }
    }
  }
}

type Network = ReturnType<typeof makeNetwork>

function makeChat(): ChatRecord {
  const secret = generateGroupSecret()
  return {id: deriveChatKeys(secret).roomId, secret, name: 'Test', createdAt: 0}
}

async function join(network: Network, chat: ChatRecord, identity: Identity, store?: Store) {
  const state = {messages: [] as MessageRecord[], peers: [] as string[], statuses: [] as ConnectionStatus[]}
  const ownStore = store ?? (await openStore(`session-${counter++}`))
  const session = await openSession({
    chat,
    identity,
    store: ownStore,
    connect: network.connect(identity.id),
    handlers: {
      onMessages: messages => (state.messages = messages),
      onStatus: status => state.statuses.push(status),
      onPeersChange: peers => (state.peers = peers),
      onError: () => {}
    }
  })
  return {
    session,
    store: ownStore,
    identity,
    get view() {
      return state.messages
    },
    get peers() {
      return state.peers
    },
    statuses: state.statuses
  }
}

const texts = (messages: MessageRecord[]) => messages.flatMap(m => (m.content.type === 'text' ? [m.content.text] : []))
const names = (messages: MessageRecord[]) => messages.flatMap(m => (m.content.type === 'profile' ? [m.content.name] : []))
const keys = (messages: MessageRecord[]) => messages.map(m => `${m.author.slice(0, 6)}:${m.seq}`)
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

const record = (author: string, seq: number) => ({author, seq}) as MessageRecord

describe('versionVector', () => {
  it('counts each author up to their first gap', () => {
    const vector = versionVector([record('a', 1), record('a', 2), record('a', 4), record('b', 2), record('c', 1)])
    expect(vector).toEqual({a: 2, b: 0, c: 1})
  })

  it('is empty for an empty log', () => {
    expect(versionVector([])).toEqual({})
  })
})

describe('session', () => {
  it('delivers signed messages both ways and stores them on both devices', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    await anne.session.sendText('hello bob')
    await settle()
    await bob.session.sendText('hello anne')
    await settle()

    expect(texts(anne.view)).toEqual(['hello bob', 'hello anne'])
    expect(texts(bob.view)).toEqual(['hello bob', 'hello anne'])
    expect(texts(await bob.store.listMessages(chat.id))).toEqual(['hello bob', 'hello anne'])
  })

  it('shows messages sent at the same moment in the same order on both devices', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    await Promise.all([anne.session.sendText('from anne'), bob.session.sendText('from bob')])
    await settle()

    expect(texts(anne.view)).toHaveLength(2)
    expect(texts(anne.view)).toEqual(texts(bob.view))
  })

  it('introduces each member to the other by name', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    expect(names(anne.view).sort()).toEqual(['Anne', 'Bob'])
    expect(names(bob.view).sort()).toEqual(['Anne', 'Bob'])
  })

  it('delivers messages written while the other person was away', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    await anne.session.sendText('are you there?')
    await anne.session.sendText('guess not')
    await settle()

    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    expect(texts(bob.view)).toEqual(['are you there?', 'guess not'])
    expect(names(bob.view).sort()).toEqual(['Anne', 'Bob'])
  })

  it('passes on an absent member\'s messages, still verifiable, through whoever holds them', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    await anne.session.sendText('from anne, before leaving')
    await settle()
    await anne.session.close()

    const cindy = await join(network, chat, createIdentity('Cindy'))
    await settle()

    expect(texts(cindy.view)).toEqual(['from anne, before leaving'])
    expect(cindy.view.find(m => m.content.type === 'text')!.author).toBe(anne.identity.id)
    expect(keys(cindy.view).sort()).toEqual(keys(bob.view).sort())
  })

  it('converges four members to one history as each takes a turn offline', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const people = await Promise.all(['Anne', 'Bob', 'Cindy', 'Dave'].map(name => join(network, chat, createIdentity(name))))
    await settle()

    for (let turn = 0; turn < people.length; turn++) {
      const away = people[turn]
      await away.session.close()
      for (const [index, person] of people.entries()) {
        if (index !== turn) await person.session.sendText(`${names(person.view).length} round ${turn} from ${index}`)
      }
      await settle()
      // Written with nobody listening; it must still reach everyone later.
      const offlineStore = away.store
      people[turn] = await join(makeNetwork(), chat, away.identity, offlineStore)
      await people[turn].session.sendText(`offline note from ${turn}`)
      await people[turn].session.close()
      people[turn] = await join(network, chat, away.identity, offlineStore)
      await settle()
    }
    await settle()

    const [first, ...rest] = people.map(person => keys(person.view))
    expect(first).toHaveLength(4 + 4 * 3 + 4)
    for (const view of rest) expect(view).toEqual(first)
    for (const person of people) expect(keys(await person.store.listMessages(chat.id))).toEqual(first)
  })

  it('fills a gap in one author\'s messages from a peer', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    await anne.session.sendText('one')
    await anne.session.sendText('two')
    await anne.session.sendText('three')
    const [, , , three] = await anne.store.listMessages(chat.id)

    // Bob somehow holds only Anne's latest message.
    const bobStore = await openStore(`session-${counter++}`)
    await bobStore.addMessage(three)
    const bob = await join(network, chat, createIdentity('Bob'), bobStore)
    await settle()

    expect(texts(bob.view)).toEqual(['one', 'two', 'three'])
  })

  it('does not resend what a peer already has', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bobIdentity = createIdentity('Bob')
    const bob = await join(network, chat, bobIdentity)
    await settle()
    await anne.session.sendText('one')
    await settle()
    await bob.session.close()
    await anne.session.sendText('two')
    await settle()
    network.sent.length = 0

    await join(network, chat, bobIdentity, bob.store)
    await settle()

    // Only the one message Bob missed crosses the wire, in one direction.
    expect(network.sent).toHaveLength(1)
    expect(network.sent[0]).toMatchObject({from: anne.identity.id, to: bobIdentity.id})
  })

  it('restores history and keeps numbering after the app is closed and reopened', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const identity = createIdentity('Anne')
    const first = await join(network, chat, identity)
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    await first.session.sendText('before restart')
    await first.session.close()

    const second = await join(network, chat, identity, first.store)
    await settle()
    expect(texts(second.view)).toEqual(['before restart'])
    expect(names(second.view).filter(name => name === 'Anne')).toHaveLength(1)

    await second.session.sendText('after restart')
    await settle()
    expect(texts(bob.view)).toEqual(['before restart', 'after restart'])
    expect(bob.view.filter(m => m.author === identity.id).map(m => m.seq)).toEqual([1, 2, 3])
  })

  it('rejoins and catches up when it comes back to dead connections', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    network.kill(bob.identity.id)
    await anne.session.sendText('sent while bob was in the background')
    await settle()
    expect(texts(bob.view)).toEqual([])

    const joinsBefore = network.joins
    await bob.session.resume(60_000)
    await settle()

    expect(network.joins).toBe(joinsBefore + 1)
    expect(texts(bob.view)).toEqual(['sent while bob was in the background'])
    expect(bob.peers).toEqual([anne.identity.id])
  })

  it('resends what it thought it had delivered to a peer that silently dropped off and came back', async () => {
    const now = vi.spyOn(Date, 'now')
    let clock = 1_760_000_000_000
    now.mockImplementation(() => clock)
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    // Bob's phone sleeps. Anne's side still shows him connected, so her messages look delivered.
    network.kill(bob.identity.id)
    for (const text of ['one', 'two', 'three']) await anne.session.sendText(text)
    await settle()
    expect(anne.peers).toEqual([bob.identity.id])

    clock += 60_000
    await bob.session.resume(60_000)
    await settle()

    expect(texts(bob.view)).toEqual(['one', 'two', 'three'])
    now.mockRestore()
  })

  it('reports what the connection is doing while it joins, checks and rejoins', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    expect(bob.statuses).toEqual(['connecting', 'searching', 'idle'])

    bob.statuses.length = 0
    await bob.session.resume(60_000)
    expect(bob.statuses).toEqual(['checking', 'idle'])

    bob.statuses.length = 0
    network.kill(bob.identity.id)
    await bob.session.resume(60_000)
    await settle()
    expect(bob.statuses).toEqual(['checking', 'reconnecting', 'searching', 'idle'])
    expect(anne.peers).toEqual([bob.identity.id])
  })

  it('carries on its own numbering when rejoining a chat it had left', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bobIdentity = createIdentity('Bob')
    const bob = await join(network, chat, bobIdentity)
    await settle()
    await bob.session.sendText('before leaving')
    await settle()
    await bob.session.close()
    await bob.store.deleteChat(chat.id, bobIdentity.id)
    expect(await bob.store.listMessages(chat.id)).toEqual([])

    // Invited back: the chat is saved again, and Bob writes before sync has returned his old messages.
    const rejoined = await bob.store.saveChat({...chat})
    const again = await join(makeNetwork(), rejoined, bobIdentity, bob.store)
    await again.session.sendText('written straight after rejoining')
    await again.session.close()
    const back = await join(network, rejoined, bobIdentity, bob.store)
    await settle()

    expect(texts(anne.view)).toEqual(['before leaving', 'written straight after rejoining'])
    expect(texts(back.view)).toEqual(['before leaving', 'written straight after rejoining'])
  })

  it('leaves healthy connections alone when it comes back', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    const joinsBefore = network.joins
    await bob.session.resume(60_000)
    await anne.session.resume(0)
    await settle()

    expect(network.joins).toBe(joinsBefore)
  })

  it('rejoins after a long absence when alone, but not after a short one', async () => {
    const network = makeNetwork()
    const anne = await join(network, makeChat(), createIdentity('Anne'))
    await settle()

    await anne.session.resume(2_000)
    expect(network.joins).toBe(1)
    await anne.session.resume(60_000)
    expect(network.joins).toBe(2)
  })

  it('drops tampered, replayed and foreign envelopes without disturbing the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    await anne.session.sendText('genuine')
    await settle()
    const genuine = network.sent.at(-1)!.envelope
    const before = bob.view.length

    const tampered = new Uint8Array(genuine)
    tampered[tampered.length - 1] ^= 1
    network.inject(bob.identity.id, tampered)
    network.inject(bob.identity.id, genuine)

    const otherNetwork = makeNetwork()
    const outsider = await join(otherNetwork, makeChat(), createIdentity('Eve'))
    await outsider.session.sendText('from another chat')
    network.inject(bob.identity.id, otherNetwork.sent.at(-1)!.envelope)
    network.inject(bob.identity.id, new Uint8Array([0xff, 0x00, 0x13]))
    await settle()

    expect(bob.view).toHaveLength(before)
    expect(texts(bob.view)).toEqual(['genuine'])
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('ignores a malformed sync request', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    network.sent.length = 0

    const wire = network.connect('mallory')({}, {onEnvelope() {}, onSync() {}, onPeersChange() {}, onError() {}})
    await settle()
    network.sent.length = 0
    for (const junk of [null, 'everything', [], {'not-an-id': 0}, {[anne.identity.id]: -1}, {[anne.identity.id]: 1.5}]) {
      await wire.sendSync(junk as never)
    }
    await settle()

    expect(network.sent.filter(entry => entry.to === 'mallory')).toHaveLength(0)
    expect(bob.view.length).toBeGreaterThan(0)
  })
})
