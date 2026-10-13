import 'fake-indexeddb/auto'
import {describe, expect, it} from 'vitest'
import {createIdentity, loadIdentity} from './identity'
import {openStore, type ChatRecord, type MessageRecord} from './store'

let counter = 0
const freshName = () => `test-${counter++}`

const chat = (overrides: Partial<ChatRecord>): ChatRecord => ({
  id: 'chat-a',
  kind: 'group',
  secret: new Uint8Array(32),
  context: new Uint8Array(32).fill(1),
  chain: [],
  name: 'A',
  createdAt: 0,
  ...overrides
})

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
    await store.saveChat(chat({id: 'old', name: 'Old', createdAt: 1}))
    await store.saveChat(chat({id: 'new', name: 'New', createdAt: 2}))
    const kept = await store.saveChat(chat({id: 'old', secret: new Uint8Array(32).fill(9), name: 'Renamed', createdAt: 3}))

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
    const chatA = chat({id: 'chat-a', name: 'A', createdAt: 1})
    await store.saveChat(chatA)
    await store.saveChat(chat({id: 'chat-b', name: 'B', createdAt: 2}))
    await store.addMessage(message({author: 'me', seq: 1}))
    await store.addMessage(message({author: 'me', seq: 2, lamport: 2}))
    await store.addMessage(message({author: 'them', seq: 7, lamport: 3}))
    await store.addMessage(message({chatId: 'chat-b', author: 'me', seq: 1}))

    await store.deleteChat('chat-a', 'me')

    expect((await store.listChats()).map(c => c.name)).toEqual(['B'])
    expect(await store.listMessages('chat-a')).toEqual([])
    expect(await store.listMessages('chat-b')).toHaveLength(1)

    // Rejoining picks the numbering back up, once; leaving again without writing keeps it.
    expect((await store.saveChat(chatA)).ownSeqFloor).toBe(2)
    await store.deleteChat('chat-a', 'me')
    expect((await store.saveChat(chatA)).ownSeqFloor).toBe(2)
    expect((await store.getChat('chat-a'))!.ownSeqFloor).toBe(2)
  })

  it('counts unread text from other people since the chat was last looked at', async () => {
    const store = await openStore(freshName())
    const saved = await store.saveChat(chat({id: 'chat-a', name: 'A', createdAt: 100}))
    await store.addMessage(message({author: 'them', seq: 1, receivedAt: 150}))
    await store.addMessage(message({author: 'them', seq: 2, receivedAt: 250}))
    await store.addMessage(message({author: 'them', seq: 3, receivedAt: 260, content: {type: 'profile', name: 'Them', dh: new Uint8Array(32)}}))
    await store.addMessage(message({author: 'me', seq: 1, receivedAt: 270}))
    await store.addMessage(message({chatId: 'chat-b', author: 'them', seq: 1, receivedAt: 280}))

    expect(await store.unreadCount(saved, 'me')).toBe(2)

    await store.markRead('chat-a', 200)
    expect(await store.unreadCount((await store.getChat('chat-a'))!, 'me')).toBe(1)

    // Looking at the chat never moves the mark backwards.
    await store.markRead('chat-a', 120)
    expect((await store.getChat('chat-a'))!.readAt).toBe(200)

    await store.markRead('chat-a', 300)
    expect(await store.unreadCount((await store.getChat('chat-a'))!, 'me')).toBe(0)
  })

  it('refuses a second message with the same author and sequence number', async () => {
    const store = await openStore(freshName())
    expect(await store.addMessage(message({content: {type: 'text', text: 'original'}}))).toBe(true)
    expect(await store.addMessage(message({content: {type: 'text', text: 'replacement'}}))).toBe(false)

    const [kept] = await store.listMessages('chat-a')
    expect(kept.content).toEqual({type: 'text', text: 'original'})
    expect([...kept.envelope]).toEqual([1, 2, 3])
  })

  it('keeps files per chat, and forgets them with the chat', async () => {
    const store = await openStore(`store-files-${Date.now()}`)
    const data = new Uint8Array([1, 2, 3])
    await store.putFile('chat-a', 'aa', data)
    await store.putFile('chat-a', 'bb', data)
    await store.putFile('chat-b', 'aa', new Uint8Array([9]))
    expect((await store.listFiles('chat-a')).sort()).toEqual(['aa', 'bb'])
    expect(await store.getFile('chat-a', 'aa')).toEqual(data)
    expect(await store.getFile('chat-a', 'zz')).toBeUndefined()

    await store.deleteChat('chat-a', 'me')
    expect(await store.listFiles('chat-a')).toEqual([])
    expect(await store.getFile('chat-b', 'aa')).toEqual(new Uint8Array([9]))
  })
})
