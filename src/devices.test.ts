import 'fake-indexeddb/auto'
import {describe, expect, it, vi} from 'vitest'
import {directChat, newGroupChat} from './chats'
import {chatFromNote, noteFor, selfChat, startSelfSync} from './devices'
import {createIdentity, type Identity} from './identity'
import {openStore} from './store'
import {makeNetwork} from './test-network'

let counter = 0

/** One person's device: their shared keys, its own tag, its own storage, and the hidden chat kept in step. */
async function device(network: ReturnType<typeof makeNetwork>, identity: Identity) {
  const store = await openStore(`devices-${counter++}`)
  await store.saveIdentity(identity)
  const peerId = identity.device ? `${identity.id}.${identity.device}` : identity.id
  const stop = startSelfSync({store, identity, connectFor: () => network.connect(peerId), pollMs: 40})
  const names = async () => (await store.listChats()).map(chat => chat.name).sort()
  return {store, stop, names}
}

describe('one person on several devices', () => {
  it('works out the same hidden chat on every device, and keeps it out of the chat list', async () => {
    const anne = createIdentity('Anne')
    const desk = {...anne, device: '0123456789abcdef'}
    expect(selfChat(desk).id).toBe(selfChat(anne).id)
    expect(selfChat(createIdentity('Bob')).id).not.toBe(selfChat(anne).id)
    const store = await openStore(`devices-${counter++}`)
    await store.saveChat(selfChat(anne))
    expect(await store.listChats()).toEqual([])
  })

  it('shows a chat joined or started on one device on the others, and lets it go everywhere when left', async () => {
    const network = makeNetwork()
    const anne = createIdentity('Anne')
    const phone = await device(network, anne)
    const picnic = await phone.store.saveChat(newGroupChat(anne, 'Picnic', [], Date.now()))
    const computer = await device(network, {...anne, device: '0123456789abcdef'})
    await vi.waitFor(() => expect(computer.names()).resolves.toEqual(['Picnic']))
    expect((await computer.store.getChat(picnic.id))?.secret).toEqual(picnic.secret)

    // A direct chat started on the computer reaches the phone.
    const bob = createIdentity('Bob')
    await computer.store.saveChat(directChat(anne, bob, 'Bob', Date.now()))
    await vi.waitFor(() => expect(phone.names()).resolves.toEqual(['Bob', 'Picnic']))

    // Leaving on the phone leaves on the computer too.
    await phone.store.deleteChat(picnic.id, anne)
    await vi.waitFor(() => expect(computer.names()).resolves.toEqual(['Bob']))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await phone.names()).toEqual(['Bob'])
    await Promise.all([phone.stop(), computer.stop()])
  })

  it('catches up on what was said while it was away', async () => {
    const network = makeNetwork()
    const anne = createIdentity('Anne')
    const phone = await device(network, anne)
    await phone.store.saveChat(newGroupChat(anne, 'Picnic', [], Date.now()))
    await new Promise(resolve => setTimeout(resolve, 200))
    // The phone goes away; the computer comes along later, while the phone is back.
    await phone.stop()
    const again = startSelfSync({store: phone.store, identity: anne, connectFor: () => network.connect(anne.id), pollMs: 40})
    const computer = await device(network, {...anne, device: '0123456789abcdef'})
    await vi.waitFor(() => expect(computer.names()).resolves.toEqual(['Picnic']))
    await Promise.all([again(), computer.stop()])
  })

  it('shares how far each chat has been read, so what was read on one device is not unread on the others', async () => {
    const network = makeNetwork()
    const anne = createIdentity('Anne')
    const bob = createIdentity('Bob')
    const phone = await device(network, anne)
    const picnic = await phone.store.saveChat(newGroupChat(anne, 'Picnic', [], Date.now()))
    const computer = await device(network, {...anne, device: '0123456789abcdef'})
    await vi.waitFor(() => expect(computer.names()).resolves.toEqual(['Picnic']))
    const unread = async (where: typeof phone) => where.store.unreadCount((await where.store.getChat(picnic.id))!, anne.id)
    // Bob's messages reach both.
    for (const where of [phone, computer]) {
      for (let seq = 1; seq <= 3; seq++) {
        const content = {type: 'text', text: `hi ${seq}`} as const
        await where.store.addMessage({chatId: picnic.id, author: bob.id, device: '', seq, lamport: seq, sentAt: Date.now(), receivedAt: Date.now(), content, envelope: new Uint8Array()})
      }
    }
    expect(await unread(computer)).toBe(3)
    // Read on the phone.
    await phone.store.markRead(picnic.id, Date.now())
    await vi.waitFor(async () => expect(await unread(computer)).toBe(0))
    await Promise.all([phone.stop(), computer.stop()])
  })

  it("takes up only chats this person is really in", () => {
    const anne = createIdentity('Anne')
    const cindy = createIdentity('Cindy')
    // A group someone else founded, with no certificate admitting Anne.
    const theirs = noteFor(newGroupChat(cindy, 'Not yours', [], 0))
    expect(chatFromNote(theirs, anne, [], 0)).toBeNull()
    // A direct chat between two other people.
    const between = noteFor(directChat(cindy, createIdentity('Dan'), 'Dan', 0))
    expect(chatFromNote(between, anne, [], 0)).toBeNull()
    // Her own, under a name that is already taken here.
    const own = chatFromNote(noteFor(newGroupChat(anne, 'Picnic', [], 0)), anne, ['Picnic'], 5)
    expect(own?.name).not.toBe('Picnic')
    expect(own?.createdAt).toBe(5)
  })
})
