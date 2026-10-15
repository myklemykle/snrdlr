import 'fake-indexeddb/auto'
import {describe, expect, it, vi} from 'vitest'
import {createIdentity, type Identity} from './identity'
import {chatKeys, newGroupChat} from './chats'
import {importMsgKey, openEnvelope, sealEnvelope, type ImageContent} from './envelope'
import {sealFile} from './files'
import {issueCert} from './membership'
import {latestCards} from './cards'
import {latestEdits} from './edits'
import type {OpenMailbox} from './mailbox'
import {tallyReactions} from './reactions'
import {pushTag, worthNotifying} from './push-tag'
import {openSession, versionVector, type ConnectionStatus} from './session'
import {openAsMember} from './store-seal'
import {openStore, type ChatRecord, type MessageRecord, type Store} from './store'
import {makeNetwork} from './test-network'

let counter = 0

type Network = ReturnType<typeof makeNetwork>

const founders = new Map<string, Identity>()

function makeChat(): ChatRecord {
  const founder = createIdentity('Founder')
  const chat = newGroupChat(founder, 'Test', [], 0)
  founders.set(chat.id, founder)
  return chat
}

/** The chat as held by someone the founder admitted. */
const admitted = (chat: ChatRecord, identity: Identity): ChatRecord => ({
  ...chat,
  chain: [issueCert(chat.id, founders.get(chat.id)!, identity, 0)]
})

async function join(network: Network, shared: ChatRecord, identity: Identity, store?: Store, asHeld?: ChatRecord, mailbox?: OpenMailbox) {
  const chat = asHeld ?? admitted(shared, identity)
  const state = {
    messages: [] as MessageRecord[],
    peers: [] as string[],
    statuses: [] as ConnectionStatus[],
    errors: [] as string[],
    files: new Set() as ReadonlySet<string>,
    delivered: [] as string[],
    names: [] as string[]
  }
  const ownStore = store ?? (await openStore(`session-${counter++}`))
  const session = await openSession({
    chat,
    identity,
    store: ownStore,
    connect: network.connect(identity.device ? `${identity.id}.${identity.device}` : identity.id),
    mailbox,
    handlers: {
      onMessages: messages => (state.messages = messages),
      onStatus: status => state.statuses.push(status),
      onChatName: name => state.names.push(name),
      onPeersChange: peers => (state.peers = peers),
      onError: message => state.errors.push(message),
      onFiles: files => (state.files = files),
      onDelivered: arrived => state.delivered.push(...arrived.flatMap(m => (m.content.type === 'text' ? [m.content.text] : [])))
    },
    errorDelayMs: 60
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
    get files() {
      return state.files
    },
    /** The texts of our messages known to have reached someone, in the order that was learned. */
    delivered: state.delivered,
    /** Each name the chat has been given since this session opened. */
    names: state.names,
    statuses: state.statuses,
    errors: state.errors
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
  it('lets one person write from two devices: each numbers its own messages, and everyone sees one person', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = createIdentity('Anne')
    const desk = {...anne, device: '0123456789abcdef'}
    const phone = await join(network, chat, anne)
    const bob = await join(network, chat, createIdentity('Bob'))
    await phone.session.sendText('from my phone')
    await settle()
    // The desktop was away for that, and catches up from Bob, who has it.
    await phone.session.close()
    const computer = await join(network, chat, desk)
    await vi.waitFor(() => expect(texts(computer.view)).toEqual(['from my phone']))
    await computer.session.sendText('from my desk')
    await vi.waitFor(() => expect(texts(bob.view)).toEqual(['from my phone', 'from my desk']))
    const fromAnne = bob.view.filter(m => m.content.type === 'text')
    expect(fromAnne.map(m => [m.author, m.device])).toEqual([
      [anne.id, ''],
      [anne.id, desk.device]
    ])
    // Two streams, each counting from 1: the same numbers on different devices are different messages.
    expect(versionVector(bob.view)[`${anne.id}.${desk.device}`]).toBeGreaterThan(0)
    expect(versionVector(bob.view)[anne.id]).toBeGreaterThan(0)

    // The desktop can fix a message written on the phone, since it is the same person.
    const phoneMessage = fromAnne[0]
    await computer.session.edit({device: phoneMessage.device, seq: phoneMessage.seq}, 'from my phone, fixed')
    await vi.waitFor(() => expect([...latestEdits(bob.view).values()]).toEqual(['from my phone, fixed']))

    // And the phone, back again, gets what the desktop wrote while it was away.
    const again = await join(network, chat, anne, phone.store)
    await vi.waitFor(() => expect(texts(again.view)).toEqual(['from my phone', 'from my desk']))
    await again.session.sendText('phone again')
    await vi.waitFor(() => expect(texts(computer.view)).toEqual(['from my phone', 'from my desk', 'phone again']))
    expect(again.view.findLast(m => m.content.type === 'text')!.device).toBe('')
  })

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
    await bob.store.deleteChat(chat.id, bobIdentity)
    expect(await bob.store.listMessages(chat.id)).toEqual([])

    // Invited back: the chat is saved again, and Bob writes before sync has returned his old messages.
    const rejoined = await bob.store.saveChat({...chat})
    const again = await join(makeNetwork(), rejoined, bobIdentity, bob.store)
    await again.session.sendText('written straight after rejoining')
    await again.session.close()
    const back = await join(network, rejoined, bobIdentity, bob.store)

    // Waits for the outcome, not a fixed time: a busy machine can take a while to sync.
    await vi.waitFor(() => {
      expect(texts(anne.view)).toEqual(['before leaving', 'written straight after rejoining'])
      expect(texts(back.view)).toEqual(['before leaving', 'written straight after rejoining'])
    })
  })

  it('keeps quiet about a failed connection attempt if someone connects soon after', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    await settle()
    anne.statuses.length = 0

    network.fail(anne.identity.id)
    await join(network, chat, createIdentity('Bob'))
    await new Promise(resolve => setTimeout(resolve, 120))

    expect(anne.errors).toEqual([])
    expect(anne.statuses.at(-1)).toBe('idle')
  })

  it('reports a failed connection attempt if nobody connects', async () => {
    const network = makeNetwork()
    const anne = await join(network, makeChat(), createIdentity('Anne'))
    await settle()

    network.fail(anne.identity.id)
    expect(anne.errors).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 120))

    expect(anne.errors).toEqual(['could not connect'])
  })

  it('shares a membership certificate through the chat like any other message', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()

    await anne.session.postCert(new Uint8Array([9, 9, 9]))
    await settle()

    const received = bob.view.find(m => m.content.type === 'member-cert')!
    expect(received.author).toBe(anne.identity.id)
    expect(received.content).toEqual({type: 'member-cert', cert: new Uint8Array([9, 9, 9])})
  })

  it('reads messages it once stored as an unknown kind, now that it understands them', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    await anne.session.sendText('a newer kind of message')
    const [, genuine] = await anne.store.listMessages(chat.id)

    // As an older app version would have kept it.
    const bobStore = await openStore(`session-${counter++}`)
    await bobStore.addMessage({...genuine, content: {type: 'unknown', kind: 'text'}})
    const bob = await join(makeNetwork(), chat, createIdentity('Bob'), bobStore)

    expect(texts(bob.view)).toEqual(['a newer kind of message'])
    expect(texts(await bobStore.listMessages(chat.id))).toEqual(['a newer kind of message'])
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

    const wire = network.connect('mallory')({}, {onEnvelope() {}, onSync() {}, onAck() {}, onPeersChange() {}, onError() {}, onFileWanted() {}, onFile() {}, expectsFile: () => false})
    await settle()
    network.sent.length = 0
    for (const junk of [null, 'everything', [], {'not-an-id': 0}, {[anne.identity.id]: -1}, {[anne.identity.id]: 1.5}]) {
      await wire.sendSync(junk as never)
    }
    await settle()

    expect(network.sent.filter(entry => entry.to === 'mallory')).toHaveLength(0)
    expect(bob.view.length).toBeGreaterThan(0)
  })

  it('refuses messages from someone who holds the chat secret but was never invited', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    // Eve has a copy of the chat's secret and nothing else. This network has no connection check, so
    // what she sends arrives the way a relay would deliver it.
    const eve = await join(network, chat, createIdentity('Eve'), undefined, {...chat, chain: []})
    await settle()

    await eve.session.sendText('let me in')
    await anne.session.sendText('members only')
    await settle()

    expect(texts(anne.view)).toEqual(['members only'])
    expect(names(anne.view)).not.toContain('Eve')
    expect((await anne.store.listMessages(chat.id)).some(m => m.author === eve.identity.id)).toBe(false)

    // Nor does Anne pass Eve's messages on to a member who arrives later.
    await eve.session.close()
    network.sent.length = 0
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    expect(texts(bob.view)).toEqual(['members only'])
    expect(bob.view.some(m => m.author === eve.identity.id)).toBe(false)
  })

  it('refuses someone who certifies themselves', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const eveIdentity = createIdentity('Eve')
    const selfMade = {...chat, chain: [issueCert(chat.id, eveIdentity, eveIdentity, 0)]}
    const eve = await join(network, chat, eveIdentity, undefined, selfMade)
    await settle()

    await eve.session.sendText('I vouch for myself')
    await settle()

    expect(anne.view.some(m => m.author === eveIdentity.id)).toBe(false)
  })

  it('accepts a member admitted by another member, not only by the founder', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bobIdentity = createIdentity('Bob')
    const bobChat = admitted(chat, bobIdentity)
    const carolIdentity = createIdentity('Carol')
    const carolChat = {...chat, chain: [...bobChat.chain, issueCert(chat.id, bobIdentity, carolIdentity, 0)]}
    // Bob is not in the room: Carol's own "joined" message has to carry the whole chain.
    const carol = await join(network, chat, carolIdentity, undefined, carolChat)
    await settle()

    await carol.session.sendText('bob sent me')
    await settle()

    expect(texts(anne.view)).toEqual(['bob sent me'])
    expect(names(anne.view)).toContain('Carol')
  })

  it('holds a message that arrives before its author is known, and shows it once they are', async () => {
    const chat = makeChat()
    const elsewhere = makeNetwork()
    const carol = await join(elsewhere, chat, createIdentity('Carol'))
    await carol.session.sendText('early')
    const [joined, early] = elsewhere.sent.map(entry => entry.envelope)

    const network = makeNetwork()
    const anne = await join(network, chat, createIdentity('Anne'))
    await settle()
    network.inject(anne.identity.id, early)
    await settle()
    expect(texts(anne.view)).toEqual([])
    expect(await anne.store.listMessages(chat.id)).toHaveLength(1)

    network.inject(anne.identity.id, joined)
    await settle()
    expect(texts(anne.view)).toEqual(['early'])
    expect(names(anne.view)).toContain('Carol')
  })

  it('posts its joined message again, with certificates, if an older version posted it without', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const bobIdentity = createIdentity('Bob')
    const bobChat = admitted(chat, bobIdentity)

    // As the previous version of the app left it: a profile with no certificates.
    const bobStore = await openStore(`session-${counter++}`)
    const context = {chatId: chat.id, msgKey: await importMsgKey(chatKeys(chat).msgKey)}
    const old = {seq: 1, lamport: 1, sentAt: 1, content: {type: 'profile', name: 'Bob', dh: bobIdentity.dhPublic}} as const
    const envelope = await sealEnvelope(context, bobIdentity, old)
    await bobStore.addMessage({...old, author: bobIdentity.id, device: '', chatId: chat.id, receivedAt: 1, envelope})

    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, bobIdentity, bobStore, bobChat)
    await settle()
    await bob.session.sendText('still here')
    await settle()

    expect(texts(anne.view)).toEqual(['still here'])
    expect(bob.view.filter(m => m.author === bobIdentity.id && m.content.type === 'profile')).toHaveLength(2)

    // Once is enough: reopening does not post a third.
    await bob.session.close()
    const again = await join(makeNetwork(), chat, bobIdentity, bobStore, bobChat)
    expect(again.view.filter(m => m.author === bobIdentity.id && m.content.type === 'profile')).toHaveLength(2)
  })

  it('puts a message from a device that was out of touch at the end, not back where its view stopped', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bobIdentity = createIdentity('Bob')
    const bobChat = admitted(chat, bobIdentity)
    const bobStore = await openStore(`session-${counter++}`)
    // Bob is cut off while Anne writes; he has seen none of it when he writes his own.
    const alone = await join(makeNetwork(), chat, bobIdentity, bobStore, bobChat)
    for (const text of ['one', 'two', 'three']) await anne.session.sendText(text)
    await new Promise(resolve => setTimeout(resolve, 5))
    await alone.session.sendText('late')
    await alone.session.close()

    const bob = await join(network, chat, bobIdentity, bobStore, bobChat)
    await settle()

    expect(texts(anne.view)).toEqual(['one', 'two', 'three', 'late'])
    expect(texts(bob.view)).toEqual(['one', 'two', 'three', 'late'])
  })

  it('shows a message that another session of the same chat stored behind its back', async () => {
    const chat = makeChat()
    const elsewhere = makeNetwork()
    const anne = await join(elsewhere, chat, createIdentity('Anne'))
    await anne.session.sendText('did you get this?')

    const network = makeNetwork()
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    // As a background sync or another tab would: straight into storage, not through Bob's open session.
    for (const stored of await anne.store.listMessages(chat.id)) await bob.store.addMessage(stored)
    expect(texts(bob.view)).toEqual([])

    for (const {envelope} of elsewhere.sent) network.inject(bob.identity.id, envelope)
    await settle()

    expect(texts(bob.view)).toEqual(['did you get this?'])
    expect(texts(bob.view)).toHaveLength(1)
  })

  /** A stand-in for the relay that keeps messages: one shelf per topic, shared by whoever is given it. */
  function makeShelf() {
    const kept = new Map<string, Uint8Array[]>()
    /** For each message left, the tag that asks the relay to notify, if it had one. */
    const notified: (string | null)[] = []
    const listeners = new Map<string, Set<(envelope: Uint8Array) => void>>()
    let up = true
    const open: OpenMailbox = (topic, _collectedAt, handlers) => {
      if (!listeners.has(topic)) listeners.set(topic, new Set())
      listeners.get(topic)!.add(handlers.onEnvelope)
      queueMicrotask(() => {
        for (const envelope of kept.get(topic) ?? []) handlers.onEnvelope(envelope)
        handlers.onCaughtUp?.(Date.now())
      })
      return {
        post: async (envelope, _sentAt, notify) => {
          if (!up) return false
          notified.push(notify ?? null)
          kept.set(topic, [...(kept.get(topic) ?? []), envelope])
          listeners.get(topic)!.forEach(listener => listener !== handlers.onEnvelope && listener(envelope))
          return true
        },
        close: () => void listeners.get(topic)!.delete(handlers.onEnvelope)
      }
    }
    return {open, kept, notified, setUp: (next: boolean) => (up = next)}
  }

  it("asks the relay to notify the other members of a message just written, and of nothing else", async () => {
    const shelf = makeShelf()
    const chat = makeChat()
    const anne = createIdentity('Anne')
    const first = await join(makeNetwork(), chat, anne, undefined, undefined, shelf.open)
    // Opening the chat leaves her profile there, which is housekeeping.
    await vi.waitFor(() => expect(shelf.notified.length).toBeGreaterThan(0))
    expect(shelf.notified.every(tag => tag === null)).toBe(true)
    const before = shelf.notified.length
    await first.session.sendText('news')
    await vi.waitFor(() => expect(shelf.notified).toHaveLength(before + 1))
    // Tagged as hers in this chat, the same on any of her devices, so none of them is woken by it.
    expect(shelf.notified.at(-1)).toBe(pushTag(chat, anne))
    expect(pushTag(chat, {...anne, device: '0123456789abcdef'} as Identity)).toBe(pushTag(chat, anne))
    expect(pushTag(chat, createIdentity('Bob'))).not.toBe(pushTag(chat, anne))
    expect(pushTag(makeChat(), anne)).not.toBe(pushTag(chat, anne))
    await first.session.close()
  })

  it('treats an old message being caught up on as no news', () => {
    const now = 1_800_000_000_000
    expect(worthNotifying({content: {type: 'text', text: 'hi'}, sentAt: now - 1000}, now)).toBe(true)
    expect(worthNotifying({content: {type: 'text', text: 'hi'}, sentAt: now - 3600_000}, now)).toBe(false)
    expect(worthNotifying({content: {type: 'rename', name: 'x'}, sentAt: now}, now)).toBe(false)
  })

  it('leaves messages with the relay for someone who is never online at the same time', async () => {
    const shelf = makeShelf()
    const chat = makeChat()
    // They meet once, as people do when one invites the other, which is how each learns the other's key.
    const meeting = makeNetwork()
    const [annes, bobs] = [await openStore(`session-shelf-${counter++}`), await openStore(`session-shelf-${counter++}`)]
    const [first, met] = [await join(meeting, chat, createIdentity('Anne'), annes), await join(meeting, chat, createIdentity('Bob'), bobs)]
    await settle()
    await first.session.close()
    await met.session.close()

    // From here on each is alone on their own network: they never connect to each other again.
    const anne = await join(makeNetwork(), chat, first.identity, annes, undefined, shelf.open)
    await anne.session.sendText('are you there?')
    await anne.session.sendText('I am going out')
    await vi.waitFor(() => expect([...shelf.kept.values()].flat().length).toBeGreaterThanOrEqual(3))
    await anne.session.close()

    const bob = await join(makeNetwork(), chat, met.identity, bobs, undefined, shelf.open)
    // Locking and unlocking take a moment each, so these wait rather than assume.
    await vi.waitFor(() => expect(texts(bob.view)).toEqual(['are you there?', 'I am going out']))
    const before = [...shelf.kept.values()].flat().length
    await bob.session.sendText('here now')
    await vi.waitFor(() => expect([...shelf.kept.values()].flat().length).toBeGreaterThan(before))
    await bob.session.close()

    const anneAgain = await join(makeNetwork(), chat, anne.identity, anne.store, undefined, shelf.open)
    await vi.waitFor(() => expect(texts(anneAgain.view)).toEqual(['are you there?', 'I am going out', 'here now']))
  })

  it('locks what it leaves with the relay to the members, so a copy of the chat secret is not enough to read it', async () => {
    const shelf = makeShelf()
    const chat = makeChat()
    const network = makeNetwork()
    const anne = await join(network, chat, createIdentity('Anne'), undefined, undefined, shelf.open)
    const bob = await join(network, chat, createIdentity('Bob'), undefined, undefined, shelf.open)
    await settle()
    await anne.session.sendText('for members')
    const context = {chatId: chat.id, msgKey: await importMsgKey(chatKeys(chat).msgKey)}
    // Bob can open what was left, once it is there.
    await vi.waitFor(async () => {
      const opened = await Promise.all([...shelf.kept.values()].flat().map(item => openAsMember(chat.id, item, bob.identity)))
      const read = await Promise.all(opened.filter(item => item !== null).map(item => openEnvelope(context, item!)))
      expect(read.some(message => message.content.type === 'text' && message.content.text === 'for members')).toBe(true)
    })
    await anne.session.close()
    await bob.session.close()

    // Mallory holds the chat's secret, so she knows where to look and has the key the messages are sealed
    // with. What she finds there is locked to Anne and Bob.
    const mallory = createIdentity('Mallory')
    const stored = [...shelf.kept.values()].flat()
    expect(stored.length).toBeGreaterThan(0)
    for (const item of stored) {
      await expect(openEnvelope(context, item)).rejects.toThrow()
      expect(await openAsMember(chat.id, item, mallory)).toBeNull()
    }
  })

  it('leaves what was written while the relay was unreachable the next time the chat opens, and not twice', async () => {
    const shelf = makeShelf()
    const chat = makeChat()
    const store = await openStore(`session-shelf-${counter++}`)
    const anne = createIdentity('Anne')
    const held = admitted(chat, anne)
    await store.saveChat(held)
    shelf.setUp(false)
    const first = await join(makeNetwork(), chat, anne, store, held, shelf.open)
    await first.session.sendText('written with no network')
    await settle()
    await first.session.close()
    expect(shelf.kept.size).toBe(0)

    shelf.setUp(true)
    const second = await join(makeNetwork(), chat, anne, store, (await store.getChat(held.id))!, shelf.open)
    await vi.waitFor(async () => expect((await store.getChat(held.id))!.storedSeq).toBe(2))
    await second.session.close()
    const count = [...shelf.kept.values()][0].length
    // Her "joined" message and the text; and it is remembered that they are there.
    expect(count).toBe(2)
    expect((await store.getChat(held.id))!.storedSeq).toBe(2)
    const third = await join(makeNetwork(), chat, anne, store, (await store.getChat(held.id))!, shelf.open)
    await settle()
    await third.session.close()
    expect([...shelf.kept.values()][0].length).toBe(count)
  })

  it('tries again by itself to leave what the relay did not take, while the chat stays open', async () => {
    const shelf = makeShelf()
    const chat = makeChat()
    const store = await openStore(`session-shelf-${counter++}`)
    const anne = createIdentity('Anne')
    const held = admitted(chat, anne)
    await store.saveChat(held)
    shelf.setUp(false)
    const open = await join(makeNetwork(), chat, anne, store, held, shelf.open)
    await open.session.sendText('the relay was not answering')
    await settle()
    expect(shelf.kept.size).toBe(0)
    // The relay comes back; nobody reopens the chat.
    shelf.setUp(true)
    await vi.waitFor(async () => expect((await store.getChat(held.id))!.storedSeq).toBe(2), {timeout: 10_000, interval: 200})
    await open.session.close()
  }, 15_000)

  it('lets any member rename a group, for everyone, including someone who was away', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const bob = await join(network, chat, createIdentity('Bob'))
    await bob.session.rename('Picnic')
    await settle()
    expect(anne.names).toEqual(['Picnic'])
    await anne.session.rename('Picnic on Sunday')
    await settle()
    expect(bob.names).toEqual(['Picnic', 'Picnic on Sunday'])
    const carol = await join(network, chat, createIdentity('Carol'))
    await settle()
    expect(carol.names.at(-1)).toBe('Picnic on Sunday')
  })

  it('carries what a reply is answering, in words and with a picture', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const [anne, bob] = [await join(network, chat, createIdentity('Anne')), await join(network, chat, createIdentity('Bob'))]
    await anne.session.sendText('shall we go?')
    await settle()
    const replyTo = {author: anne.identity.id, device: '', seq: anne.view.find(m => m.content.type === 'text')!.seq}
    await bob.session.sendText('yes, at six', replyTo)
    await settle()
    expect(anne.view.at(-1)!.content).toEqual({type: 'text', text: 'yes, at six', replyTo})
    // An ordinary message says nothing about replying.
    await bob.session.sendText('bring a coat')
    await settle()
    expect(anne.view.at(-1)!.content).toEqual({type: 'text', text: 'bring a coat'})
  })

  it('shares reactions like any other message, including with someone who was away', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const [anne, bob] = [await join(network, chat, createIdentity('Anne')), await join(network, chat, createIdentity('Bob'))]
    await anne.session.sendText('shall we go?')
    await settle()
    const target = {author: anne.identity.id, device: '', seq: anne.view.find(m => m.content.type === 'text')!.seq}
    const key = `${target.author}:${target.seq}`

    await bob.session.react(target, '👍')
    await settle()
    expect(tallyReactions(anne.view).get(key)).toEqual([{emoji: '👍', by: [bob.identity.id]}])

    // Bob changes his mind, then Anne agrees with him.
    await bob.session.react(target, '🎉')
    // One after the other; in the same instant, which comes first would be a toss-up.
    await settle()
    await anne.session.react(target, '🎉')
    await settle()
    for (const person of [anne, bob]) {
      expect(tallyReactions(person.view).get(key)).toEqual([{emoji: '🎉', by: [bob.identity.id, anne.identity.id]}])
    }

    // Cindy joins later and sees the same thing; then Bob takes his away.
    const cindy = await join(network, chat, createIdentity('Cindy'))
    await settle()
    expect(tallyReactions(cindy.view).get(key)).toEqual([{emoji: '🎉', by: [bob.identity.id, anne.identity.id]}])
    await bob.session.react(target, '')
    await settle()
    expect(tallyReactions(cindy.view).get(key)).toEqual([{emoji: '🎉', by: [anne.identity.id]}])
    expect(texts(cindy.view)).toEqual(['shall we go?'])
  })

  /** A picture ready to send: the message that describes it, and its encrypted file. */
  async function picture(bytes: number[], caption?: string): Promise<{image: ImageContent; file: Uint8Array}> {
    const sealed = await sealFile(new Uint8Array(bytes))
    const image: ImageContent = {type: 'image', hash: sealed.hash, key: sealed.key, size: sealed.data.length, width: 4, height: 3, preview: new Uint8Array([9])}
    return {image: caption ? {...image, caption} : image, file: sealed.data}
  }

  it('shows a profile card in a chat, once, with its photo fetched by the others, and takes it back', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const [anne, bob] = [await join(network, chat, createIdentity('Anne')), await join(network, chat, createIdentity('Bob'))]
    await settle()
    const {image, file} = await picture([1, 2, 3, 4])
    const {hash, key, size, width, height, preview} = image
    const content = {type: 'card', icon: '🦊', color: '#2f9e5b', photo: {hash, key, size, width, height, preview}} as const
    const cardsFrom = (view: MessageRecord[]) => view.filter(m => m.content.type === 'card').map(m => m.content)

    // Nothing shown and nothing to show: nothing is sent.
    await anne.session.shareCard(null)
    await anne.session.shareCard({content, photoFile: file})
    // Asking again for the same card sends nothing more.
    await anne.session.shareCard({content, photoFile: file})
    await settle()
    expect(cardsFrom(bob.view)).toEqual([content])
    expect(latestCards(bob.view).get(anne.identity.id)).toEqual(content)
    expect(bob.files.has(hash)).toBe(true)

    // Taking it back is an empty card, after which she shows none.
    await anne.session.shareCard(null)
    await settle()
    expect(cardsFrom(bob.view)).toEqual([content, {type: 'card'}])
    expect(latestCards(bob.view).has(anne.identity.id)).toBe(false)
  })

  it('tells the chat again who we are after a change of name', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const store = await openStore(`session-renamed-${counter++}`)
    const anne = createIdentity('Anne')
    const first = await join(network, chat, anne, store)
    const bob = await join(network, chat, createIdentity('Bob'))
    await settle()
    await first.session.close()
    await join(network, chat, {...anne, name: 'Annie'}, store)
    await settle()
    const said = bob.view.flatMap(m => (m.author === anne.id && m.content.type === 'profile' ? [m.content.name] : []))
    expect(said).toEqual(['Anne', 'Annie'])
  })

  it('sends a picture: the message at once, the file fetched by whoever lacks it', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const [anne, bob] = [await join(network, chat, createIdentity('Anne')), await join(network, chat, createIdentity('Bob'))]
    await settle()
    const {image, file} = await picture([1, 2, 3, 4], 'the view')
    await anne.session.postImage(image, file)
    await settle()

    expect(bob.view.find(m => m.content.type === 'image')?.content).toEqual(image)
    expect(bob.files.has(image.hash)).toBe(true)
    expect(await bob.store.getFile(chat.id, image.hash)).toEqual(file)
    expect(anne.files.has(image.hash)).toBe(true)
    // Fetched once, and never asked for again.
    expect(network.files.map(entry => entry.from)).toEqual([anne.identity.id])
    expect(await bob.store.unreadCount((await bob.store.getChat(chat.id)) ?? chat, bob.identity.id)).toBe(1)
  })

  it('gets a picture from another member when its sender has gone', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const [anne, bob] = [await join(network, chat, createIdentity('Anne')), await join(network, chat, createIdentity('Bob'))]
    await settle()
    const {image, file} = await picture([5, 6, 7])
    await anne.session.postImage(image, file)
    await settle()
    await anne.session.close()

    const cindy = await join(network, chat, createIdentity('Cindy'))
    await settle()
    expect(cindy.files.has(image.hash)).toBe(true)
    expect(await cindy.store.getFile(chat.id, image.hash)).toEqual(file)
    expect(network.files.at(-1)).toMatchObject({from: bob.identity.id, to: cindy.identity.id, sent: true})
  })

  it('asks someone else when the first person asked does not have the picture', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const {image, file} = await picture([8, 8, 8])
    await anne.session.postImage(image, file)
    await anne.session.close()

    // Bob knows of the picture but never got the file. Cindy holds both.
    const bobStore = await openStore(`session-${counter++}`)
    const cindyStore = await openStore(`session-${counter++}`)
    for (const store of [bobStore, cindyStore]) for (const message of anne.view) await store.addMessage(message)
    await cindyStore.putFile(chat.id, image.hash, file)
    const bob = await join(network, chat, createIdentity('Bob'), bobStore)
    const dave = await join(network, chat, createIdentity('Dave'))
    await settle()
    expect(dave.files.has(image.hash)).toBe(false)

    const cindy = await join(network, chat, createIdentity('Cindy'), cindyStore)
    await settle()
    await settle()
    for (const person of [bob, dave]) expect(person.files.has(image.hash)).toBe(true)
    expect(network.files.some(entry => !entry.sent)).toBe(true)
    expect(cindy.files.has(image.hash)).toBe(true)
  })

  it('refuses a file that is not what the message described, or that it never asked for', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    const {image, file} = await picture([1, 1, 1, 1])
    await anne.session.postImage(image, file)
    await anne.session.close()

    // Mallory is in the room and answers every request with something else of the right length.
    const forged = new Uint8Array(file.length).fill(7)
    const mallory = network.connect('mallory')(
      {},
      {
        onEnvelope() {},
        onSync() {},
        onAck() {},
        onPeersChange() {},
        onError() {},
        onFile() {},
        expectsFile: () => false,
        onFileWanted: (hash, peerId) => void mallory.sendFile(hash, forged, peerId)
      }
    )
    const bobStore = await openStore(`session-${counter++}`)
    for (const message of anne.view) await bobStore.addMessage(message)
    const bob = await join(network, chat, createIdentity('Bob'), bobStore)
    await settle()
    expect(network.files.some(entry => entry.from === 'mallory' && entry.sent)).toBe(true)
    expect(bob.files.has(image.hash)).toBe(false)
    expect(await bobStore.getFile(chat.id, image.hash)).toBeUndefined()

    // Unasked for: the right file, pushed at Bob by someone he did not ask. It is not even downloaded.
    await mallory.sendFile('f'.repeat(64), file, bob.identity.id)
    await settle()
    expect(await bobStore.listFiles(chat.id)).toEqual([])
  })

  it('learns that a message has reached someone, straight away if they are there and later if not', async () => {
    const network = makeNetwork()
    const chat = makeChat()
    const anne = await join(network, chat, createIdentity('Anne'))
    await settle()

    // Nobody is there: it is stored and waiting, not delivered.
    await anne.session.sendText('anyone?')
    await settle()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(anne.delivered).toEqual([])

    // Bob arrives and syncs: now it has reached someone.
    const bob = await join(network, chat, createIdentity('Bob'))
    await vi.waitFor(() => expect(anne.delivered).toEqual(['anyone?']))

    // With Bob there, the next one is confirmed within a moment, once, however many people hold it.
    const cindy = await join(network, chat, createIdentity('Cindy'))
    // Long enough for the exchange that follows a join to finish, acknowledgements included.
    await new Promise(resolve => setTimeout(resolve, 200))
    network.syncs.length = 0
    network.acks.length = 0
    await anne.session.sendText('hello both')
    await vi.waitFor(() => expect(anne.delivered).toEqual(['anyone?', 'hello both']))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(anne.delivered).toEqual(['anyone?', 'hello both'])
    // Each receiver answers with one short note about Anne's messages only, not a list of everyone's.
    const annesCount = versionVector(anne.view)[anne.identity.id]
    expect(network.acks).toHaveLength(2)
    for (const ack of network.acks) expect(ack).toMatchObject({to: anne.identity.id, have: {[anne.identity.id]: annesCount}})
    expect(network.acks.map(ack => Object.keys(ack.have).length)).toEqual([1, 1])
    expect(network.syncs).toEqual([])
    // Receiving is not delivering: Bob and Cindy sent nothing.
    expect(bob.delivered).toEqual([])
    expect(cindy.delivered).toEqual([])
  })
})
