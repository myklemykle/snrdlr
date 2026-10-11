import 'fake-indexeddb/auto'
import {describe, expect, it, vi} from 'vitest'
import {createIdentity, type Identity} from './identity'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {openSession, type Wire, type WireHandlers} from './session'
import {openStore, type ChatRecord, type MessageRecord, type Store} from './store'

let counter = 0

/** An in-memory stand-in for the WebRTC room: everything sent reaches every other connected member. */
function makeNetwork() {
  const members = new Map<string, WireHandlers>()
  const announce = () => members.forEach((handlers, id) => handlers.onPeersChange([...members.keys()].filter(peer => peer !== id)))
  return {
    sent: [] as Uint8Array[],
    /** Delivers raw bytes to one member, as a peer in the room could. */
    inject: (to: string, envelope: Uint8Array) => members.get(to)!.onEnvelope(envelope, 'injected'),
    connect(peerId: string) {
      return (_keys: unknown, handlers: WireHandlers): Wire => {
        members.set(peerId, handlers)
        queueMicrotask(announce)
        return {
          send: async (envelope, target) => {
            this.sent.push(envelope)
            members.forEach((peer, id) => id !== peerId && (!target || target === id) && peer.onEnvelope(envelope, peerId))
          },
          routes: async () => [],
          leave: async () => {
            members.delete(peerId)
            announce()
          }
        }
      }
    }
  }
}

function makeChat(): ChatRecord {
  const secret = generateGroupSecret()
  return {id: deriveChatKeys(secret).roomId, secret, name: 'Test', createdAt: 0}
}

async function join(network: ReturnType<typeof makeNetwork>, chat: ChatRecord, identity: Identity, store?: Store) {
  const state = {messages: [] as MessageRecord[], store: store ?? (await openStore(`session-${counter++}`))}
  const session = await openSession({
    chat,
    identity,
    store: state.store,
    connect: network.connect(identity.id),
    handlers: {onMessages: messages => (state.messages = messages), onPeersChange: () => {}, onError: () => {}}
  })
  return {...state, session, get view() { return state.messages }}
}

const texts = (messages: MessageRecord[]) => messages.flatMap(m => (m.content.type === 'text' ? [m.content.text] : []))
const names = (messages: MessageRecord[]) => messages.flatMap(m => (m.content.type === 'profile' ? [m.content.name] : []))
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

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
    const anneSeqs = bob.view.filter(m => m.author === identity.id).map(m => m.seq)
    expect(anneSeqs).toEqual([1, 2, 3])
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
    const genuine = network.sent.at(-1)!
    const before = bob.view.length

    const tampered = new Uint8Array(genuine)
    tampered[tampered.length - 1] ^= 1
    network.inject(bobId(bob), tampered)
    network.inject(bobId(bob), genuine)

    const otherNetwork = makeNetwork()
    const outsider = await join(otherNetwork, makeChat(), createIdentity('Eve'))
    await outsider.session.sendText('from another chat')
    network.inject(bobId(bob), otherNetwork.sent.at(-1)!)
    network.inject(bobId(bob), new Uint8Array([0xff, 0x00, 0x13]))
    await settle()

    expect(bob.view).toHaveLength(before)
    expect(texts(bob.view)).toEqual(['genuine'])
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})

// The fake network keys members by identity ID; a session's own profile message carries it.
function bobId(member: {view: MessageRecord[]}): string {
  return member.view.find(m => m.content.type === 'profile' && m.content.name === 'Bob')!.author
}
