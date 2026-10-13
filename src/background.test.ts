import 'fake-indexeddb/auto'
import {describe, expect, it} from 'vitest'
import {claimChat, keepChats, onBackgroundActivity, sweepChats, unclaimChat, type KeepStatus} from './background'
import {createIdentity} from './identity'
import {newGroupChat} from './chats'
import type {ChatKeys} from './keys'
import {openSession, type WireHandlers} from './session'
import {openStore, type ChatRecord, type MessageRecord} from './store'
import {makeNetwork} from './test-network'

let counter = 0
// aloneMs is generous: on a busy machine a peer can take a while to appear, and giving up mid-delivery
// stores the message without announcing it.
const timing = {aloneMs: 400, quietMs: 60, minMs: 60, maxMs: 2_000, pollMs: 10}
const texts = (messages: MessageRecord[]) => messages.flatMap(m => (m.content.type === 'text' ? [m.content.text] : []))
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

// Anne founded every chat here, so her messages need no certificate to be accepted.
const anne = createIdentity('Anne')

function makeChat(name: string): ChatRecord {
  return newGroupChat(anne, name, [], 0)
}

/** Anne, online in a chat with messages waiting for whoever syncs. */
async function anneWaitingIn(chat: ChatRecord, messages: string[]) {
  const network = makeNetwork()
  const session = await openSession({
    chat,
    identity: anne,
    store: await openStore(`background-${counter++}`),
    connect: network.connect(anne.id),
    handlers: {onMessages() {}, onStatus() {}, onPeersChange() {}, onError() {}}
  })
  for (const text of messages) await session.sendText(text)
  return network
}

describe('sweepChats', () => {
  it('fetches what arrived in every chat, announces it, and leaves each room again', async () => {
    const bob = createIdentity('Bob')
    const store = await openStore(`background-${counter++}`)
    const [cabin, work, empty] = [makeChat('Cabin'), makeChat('Work'), makeChat('Empty')]
    for (const chat of [cabin, work, empty]) await store.saveChat(chat)
    const networks = new Map([
      [cabin.id, await anneWaitingIn(cabin, ['bring the stove'])],
      [work.id, await anneWaitingIn(work, ['standup moved', 'to ten'])],
      [empty.id, makeNetwork()]
    ])
    const active: string[] = []
    const stop = onBackgroundActivity(chatId => active.push(chatId))

    await sweepChats({store, identity: bob, connectFor: () => (keys, handlers) => networks.get(keys.roomId)!.connect(bob.id)(keys, handlers), timing})
    stop()

    expect(texts(await store.listMessages(cabin.id))).toEqual(['bring the stove'])
    expect(texts(await store.listMessages(work.id))).toEqual(['standup moved', 'to ten'])
    expect(new Set(active)).toEqual(new Set([cabin.id, work.id]))
    expect(await store.unreadCount((await store.getChat(work.id))!, bob.id)).toBe(2)
    // Bob is gone from every room afterwards.
    for (const network of networks.values()) expect(network.present()).not.toContain(bob.id)
  })

  it('leaves the chat on screen alone, and stops syncing a chat the moment it is opened', async () => {
    const bob = createIdentity('Bob')
    const store = await openStore(`background-${counter++}`)
    const [open, other] = [makeChat('Open'), makeChat('Other')]
    for (const chat of [open, other]) await store.saveChat(chat)
    const networks = new Map([
      [open.id, await anneWaitingIn(open, ['hello'])],
      [other.id, await anneWaitingIn(other, ['hello'])]
    ])
    const connect = (keys: ChatKeys, handlers: WireHandlers) => networks.get(keys.roomId)!.connect(bob.id)(keys, handlers)

    await claimChat(open.id)
    const sweep = sweepChats({store, identity: bob, connectFor: () => connect, timing: {...timing, minMs: 500, quietMs: 500}})
    await settle()
    expect(networks.get(open.id)!.present()).not.toContain(bob.id)
    expect(networks.get(other.id)!.present()).toContain(bob.id)

    // Opening the other chat takes it over from the sweep straight away.
    await claimChat(other.id)
    expect(networks.get(other.id)!.present()).not.toContain(bob.id)
    await sweep
    unclaimChat(open.id)
    unclaimChat(other.id)
  })
})

describe('keepChats', () => {
  const quiet = {onMessages() {}, onStatus() {}, onPeersChange() {}, onError() {}}
  const until = async (condition: () => boolean | Promise<boolean>, ms = 2_000) => {
    for (const start = Date.now(); !(await condition()); await settle(10)) {
      if (Date.now() - start > ms) throw new Error('condition not met in time')
    }
  }

  it('stays in every chat and passes messages between members who are never online together', async () => {
    const kay = createIdentity('Kay')
    const store = await openStore(`background-${counter++}`)
    const [cabin, work] = [makeChat('Cabin'), makeChat('Work')]
    for (const chat of [cabin, work]) await store.saveChat(chat)
    const networks = new Map([[cabin.id, makeNetwork()], [work.id, makeNetwork()]])
    const statuses: KeepStatus[] = []
    const stop = keepChats({
      store,
      identity: kay,
      connectFor: () => (keys, handlers) => networks.get(keys.roomId)!.connect(kay.id)(keys, handlers),
      onStatus: status => statuses.push(status),
      timing: {pollMs: 20}
    })
    await until(() => [...networks.values()].every(network => network.present().includes(kay.id)))

    // Anne comes online, writes, and goes away again.
    const annes = await openSession({
      chat: cabin,
      identity: anne,
      store: await openStore(`background-${counter++}`),
      connect: networks.get(cabin.id)!.connect(anne.id),
      handlers: quiet
    })
    await annes.sendText('key is under the mat')
    await until(async () => texts(await store.listMessages(cabin.id)).length === 1)
    expect(statuses.at(-1)).toEqual({chats: 2, connections: 1})
    await annes.close()
    expect(networks.get(cabin.id)!.present()).toEqual([kay.id])

    // Bob turns up later, with Anne long gone, and still gets her message from Kay's computer.
    const bob = createIdentity('Bob')
    const bobStore = await openStore(`background-${counter++}`)
    const bobs = await openSession({chat: cabin, identity: bob, store: bobStore, connect: networks.get(cabin.id)!.connect(bob.id), handlers: quiet})
    await until(async () => texts(await bobStore.listMessages(cabin.id)).includes('key is under the mat'))
    await bobs.close()

    // Still there long after a sweep would have left.
    await settle(100)
    for (const network of networks.values()) expect(network.present()).toContain(kay.id)
    await stop()
    for (const network of networks.values()) expect(network.present()).not.toContain(kay.id)
  })

  it('hands a chat to its screen when opened and takes it back afterwards', async () => {
    const kay = createIdentity('Kay')
    const store = await openStore(`background-${counter++}`)
    const chat = await store.saveChat(makeChat('Cabin'))
    const network = makeNetwork()
    const stop = keepChats({store, identity: kay, connectFor: () => network.connect(kay.id), timing: {pollMs: 5_000}})
    await until(() => network.present().includes(kay.id))

    await claimChat(chat.id)
    expect(network.present()).not.toContain(kay.id)
    // Taken back at once, not at the next poll.
    unclaimChat(chat.id)
    await until(() => network.present().includes(kay.id), 500)
    await stop()
  })

  it('picks up a chat that is added and lets go of one that is left', async () => {
    const kay = createIdentity('Kay')
    const store = await openStore(`background-${counter++}`)
    const networks = new Map<string, ReturnType<typeof makeNetwork>>()
    const networkFor = (roomId: string) => networks.get(roomId) ?? networks.set(roomId, makeNetwork()).get(roomId)!
    const stop = keepChats({
      store,
      identity: kay,
      connectFor: () => (keys, handlers) => networkFor(keys.roomId).connect(kay.id)(keys, handlers),
      timing: {pollMs: 20}
    })
    const chat = await store.saveChat(makeChat('Later'))
    await until(() => networkFor(chat.id).present().includes(kay.id))

    await store.deleteChat(chat.id, kay.id)
    await until(() => !networkFor(chat.id).present().includes(kay.id))
    await stop()
  })

  it('rejoins a room that has been open a long time, so its relay credentials stay fresh', async () => {
    const kay = createIdentity('Kay')
    const store = await openStore(`background-${counter++}`)
    await store.saveChat(makeChat('Cabin'))
    const network = makeNetwork()
    const stop = keepChats({store, identity: kay, connectFor: () => network.connect(kay.id), timing: {pollMs: 20, refreshQuietMs: 100, refreshMaxMs: 10_000}})
    await until(() => network.joins >= 3)
    await stop()
    expect(network.present()).not.toContain(kay.id)
  })
})
