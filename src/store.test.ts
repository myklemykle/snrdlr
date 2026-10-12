import 'fake-indexeddb/auto'
import {describe, expect, it} from 'vitest'
import {createIdentity, loadIdentity} from './identity'
import {openStore, type MessageRecord} from './store'

let counter = 0
const freshName = () => `test-${counter++}`

const message = (overrides: Partial<MessageRecord>): MessageRecord => ({
  chatId: 'chat-a',
  author: 'aa',
  seq: 1,
  lamport: 1,
  sentAt: 0,
  receivedAt: 0,
  content: {type: 'text', text: 'hi'},
  envelope: new Uint8Array([1, 2, 3]),
  ...overrides
})

describe('store', () => {
  it('keeps the identity across a close and reopen', async () => {
    const name = freshName()
    const anne = createIdentity('Anne')
    const first = await openStore(name)
    expect(await first.getIdentity()).toBeUndefined()
    await first.saveIdentity({name: anne.name, signSecret: anne.signSecret, dhSecret: anne.dhSecret})
    first.close()

    const second = await openStore(name)
    expect(loadIdentity((await second.getIdentity())!).id).toBe(anne.id)
  })

  it('saves chats once and lists the newest first', async () => {
    const store = await openStore(freshName())
    await store.saveChat({id: 'old', secret: new Uint8Array(32), name: 'Old', createdAt: 1})
    await store.saveChat({id: 'new', secret: new Uint8Array(32), name: 'New', createdAt: 2})
    const kept = await store.saveChat({id: 'old', secret: new Uint8Array(32).fill(9), name: 'Renamed', createdAt: 3})

    expect(kept.name).toBe('Old')
    expect((await store.listChats()).map(chat => chat.name)).toEqual(['New', 'Old'])
    expect((await store.getChat('old'))!.secret[0]).toBe(0)
  })

  it('returns messages in logical-clock order, whatever order they arrived in', async () => {
    const store = await openStore(freshName())
    await store.addMessage(message({author: 'bb', seq: 1, lamport: 2, content: {type: 'text', text: 'third'}}))
    await store.addMessage(message({author: 'aa', seq: 2, lamport: 2, content: {type: 'text', text: 'second'}}))
    await store.addMessage(message({author: 'aa', seq: 1, lamport: 1, content: {type: 'text', text: 'first'}}))
    await store.addMessage(message({chatId: 'chat-b', content: {type: 'text', text: 'elsewhere'}}))

    const texts = (await store.listMessages('chat-a')).map(m => (m.content.type === 'text' ? m.content.text : ''))
    expect(texts).toEqual(['first', 'second', 'third'])
    expect(await store.listMessages('chat-b')).toHaveLength(1)
    expect(await store.listMessages('chat-none')).toEqual([])
  })

  it('forgets a left chat and its history, but not how far our own numbering got', async () => {
    const store = await openStore(freshName())
    const chat = {id: 'chat-a', secret: new Uint8Array(32), name: 'A', createdAt: 1}
    await store.saveChat(chat)
    await store.saveChat({id: 'chat-b', secret: new Uint8Array(32), name: 'B', createdAt: 2})
    await store.addMessage(message({author: 'me', seq: 1}))
    await store.addMessage(message({author: 'me', seq: 2, lamport: 2}))
    await store.addMessage(message({author: 'them', seq: 7, lamport: 3}))
    await store.addMessage(message({chatId: 'chat-b', author: 'me', seq: 1}))

    await store.deleteChat('chat-a', 'me')

    expect((await store.listChats()).map(c => c.name)).toEqual(['B'])
    expect(await store.listMessages('chat-a')).toEqual([])
    expect(await store.listMessages('chat-b')).toHaveLength(1)

    // Rejoining picks the numbering back up, once; leaving again without writing keeps it.
    expect((await store.saveChat(chat)).ownSeqFloor).toBe(2)
    await store.deleteChat('chat-a', 'me')
    expect((await store.saveChat(chat)).ownSeqFloor).toBe(2)
    expect((await store.getChat('chat-a'))!.ownSeqFloor).toBe(2)
  })

  it('refuses a second message with the same author and sequence number', async () => {
    const store = await openStore(freshName())
    expect(await store.addMessage(message({content: {type: 'text', text: 'original'}}))).toBe(true)
    expect(await store.addMessage(message({content: {type: 'text', text: 'replacement'}}))).toBe(false)

    const [kept] = await store.listMessages('chat-a')
    expect(kept.content).toEqual({type: 'text', text: 'original'})
    expect([...kept.envelope]).toEqual([1, 2, 3])
  })
})
