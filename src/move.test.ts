import 'fake-indexeddb/auto'
import {describe, expect, it} from 'vitest'
import {newGroupChat} from './chats'
import {createIdentity, loadIdentity} from './identity'
import {applyMove, packMove, unpackMove} from './move'
import {openStore} from './store'

describe('moving to the installed app', () => {
  it('carries the keys and chats across, with the numbering to carry on from, but not the history', async () => {
    const anne = createIdentity('Anne')
    const old = await openStore('move-old')
    const chat = await old.saveChat(newGroupChat(anne, 'Picnic', [], 1000))
    const record = (author: string, seq: number) =>
      ({chatId: chat.id, author, seq, lamport: seq, sentAt: 0, receivedAt: 0, content: {type: 'text', text: 'x'}, envelope: new Uint8Array(1)}) as never
    for (const [author, seq] of [[anne.id, 1], [anne.id, 2], ['ab'.repeat(32), 9]] as const) await old.addMessage(record(author, seq))

    const code = await packMove(old, anne)
    expect(code).toMatch(/^snrdlr-move1\.[\w-]+$/)
    const fresh = await openStore('move-new')
    await applyMove(fresh, unpackMove(`  ${code}\n`))

    expect(loadIdentity((await fresh.getIdentity())!).id).toBe(anne.id)
    const [moved] = await fresh.listChats()
    expect(moved).toMatchObject({id: chat.id, name: 'Picnic', kind: 'group', ownSeqFloor: 2})
    expect(moved.secret).toEqual(chat.secret)
    expect(await fresh.listMessages(chat.id)).toEqual([])
    // A copy that already has chats is somebody; it is not overwritten.
    await expect(applyMove(fresh, unpackMove(code))).rejects.toThrow('already in use')
  })

  it('refuses text that is not a move code, or one that has been cut short', async () => {
    const anne = createIdentity('Anne')
    const store = await openStore('move-bad')
    await store.saveChat(newGroupChat(anne, 'Picnic', [], 1000))
    const code = await packMove(store, anne)
    expect(() => unpackMove('https://alpha.snrdlr.net/#i=abc')).toThrow('not a move code')
    expect(() => unpackMove(code.slice(0, code.length - 40))).toThrow()
    expect(() => unpackMove('snrdlr-move1.AAAA')).toThrow()
  })
})
