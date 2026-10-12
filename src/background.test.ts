import 'fake-indexeddb/auto'
import {describe, expect, it} from 'vitest'
import {claimChat, onBackgroundActivity, sweepChats, unclaimChat} from './background'
import {createIdentity} from './identity'
import {deriveChatKeys, generateGroupSecret, type ChatKeys} from './keys'
import {openSession, type WireHandlers} from './session'
import {openStore, type ChatRecord, type MessageRecord} from './store'
import {makeNetwork} from './test-network'

let counter = 0
const timing = {aloneMs: 80, quietMs: 60, minMs: 60, maxMs: 1_000, pollMs: 10}
const texts = (messages: MessageRecord[]) => messages.flatMap(m => (m.content.type === 'text' ? [m.content.text] : []))
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

function makeChat(name: string): ChatRecord {
  const secret = generateGroupSecret()
  return {id: deriveChatKeys(secret).roomId, secret, name, createdAt: 0}
}

/** Anne, online in a chat with messages waiting for whoever syncs. */
async function anneWaitingIn(chat: ChatRecord, messages: string[]) {
  const network = makeNetwork()
  const anne = createIdentity('Anne')
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

    await sweepChats({store, identity: bob, connect: (keys, handlers) => networks.get(keys.roomId)!.connect(bob.id)(keys, handlers), timing})
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
    const sweep = sweepChats({store, identity: bob, connect, timing: {...timing, minMs: 500, quietMs: 500}})
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
