import {decode, encode} from 'cbor-x'
import {describe, expect, it} from 'vitest'
import {importMsgKey, openEnvelope, sealEnvelope, type ChatContext, type Message} from './envelope'
import {createIdentity} from './identity'
import {deriveChatKeys, generateGroupSecret} from './keys'

async function makeChat(): Promise<ChatContext> {
  const keys = deriveChatKeys(generateGroupSecret())
  return {chatId: keys.roomId, msgKey: await importMsgKey(keys.msgKey)}
}

const hello: Omit<Message, 'author'> = {seq: 1, lamport: 3, sentAt: 1_760_000_000_000, content: {type: 'text', text: 'hello ⛰️'}}

/** Re-encodes an envelope with some of its clear fields replaced. */
function rewrite(envelope: Uint8Array, changes: Record<string, unknown>): Uint8Array {
  return new Uint8Array(encode({...(decode(envelope) as object), ...changes}))
}

describe('envelope', () => {
  it('round-trips text and profile messages', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')

    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, hello))).toEqual({...hello, author: anne.id})

    const profile = {...hello, seq: 2, content: {type: 'profile', name: 'Anne'}} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, profile))).toEqual({...profile, author: anne.id})
  })

  it('hides the content from anyone without the chat key', async () => {
    const chat = await makeChat()
    const envelope = await sealEnvelope(chat, createIdentity('Anne'), {...hello, content: {type: 'text', text: 'PLAINTEXT-MARKER'}})
    expect(new TextDecoder().decode(envelope)).not.toContain('PLAINTEXT-MARKER')
    await expect(openEnvelope(await makeChat(), envelope)).rejects.toThrow(/decrypt/)
  })

  it('rejects a flipped bit anywhere in the envelope', async () => {
    const chat = await makeChat()
    const envelope = await sealEnvelope(chat, createIdentity('Anne'), hello)
    for (let i = 0; i < envelope.length; i++) {
      const tampered = new Uint8Array(envelope)
      tampered[i] ^= 1
      await expect(openEnvelope(chat, tampered), `byte ${i}`).rejects.toThrow()
    }
  })

  it('rejects a changed sequence number or author in the clear part', async () => {
    const chat = await makeChat()
    const envelope = await sealEnvelope(chat, createIdentity('Anne'), hello)
    await expect(openEnvelope(chat, rewrite(envelope, {s: 2}))).rejects.toThrow(/decrypt/)
    await expect(openEnvelope(chat, rewrite(envelope, {a: new Uint8Array(32).fill(1)}))).rejects.toThrow(/decrypt/)
  })

  it('rejects a member forging a message in another member\'s name', async () => {
    // Mallory is a member: she holds the chat key, so encryption alone cannot stop her.
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const mallory = createIdentity('Mallory')

    const forged = await sealEnvelope(chat, {id: anne.id, signSecret: mallory.signSecret, signPublic: mallory.signPublic}, hello)
    await expect(openEnvelope(chat, forged)).rejects.toThrow(/author does not match/)

    const impostorKey = await sealEnvelope(chat, {id: anne.id, signSecret: mallory.signSecret, signPublic: anne.signPublic}, hello)
    await expect(openEnvelope(chat, impostorKey)).rejects.toThrow(/bad signature/)
  })

  it('rejects a message replayed into another chat, even re-encrypted by a member of both', async () => {
    const [chatA, chatB] = [await makeChat(), await makeChat()]
    const anne = createIdentity('Anne')
    const envelope = await sealEnvelope(chatA, anne, hello)
    await expect(openEnvelope(chatB, envelope)).rejects.toThrow(/decrypt/)

    // Sealing "for chat A" but with chat B's key models a shared member moving the signed message across.
    const moved = await sealEnvelope({chatId: chatA.chatId, msgKey: chatB.msgKey}, anne, hello)
    await expect(openEnvelope(chatB, moved)).rejects.toThrow()
  })

  it('rejects unknown versions, bad counters and out-of-range content', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const seal = (message: Omit<Message, 'author'>) => sealEnvelope(chat, anne, message)

    await expect(openEnvelope(chat, rewrite(await seal(hello), {v: 2}))).rejects.toThrow(/version/)
    await expect(openEnvelope(chat, await seal({...hello, seq: 0}))).rejects.toThrow(/sequence/)
    await expect(openEnvelope(chat, await seal({...hello, lamport: -1}))).rejects.toThrow(/clock/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'text', text: ''}}))).rejects.toThrow(/text/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'text', text: 'x'.repeat(4001)}}))).rejects.toThrow(/text/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'profile', name: ''}}))).rejects.toThrow(/profile/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'other'} as never}))).rejects.toThrow()
    await expect(openEnvelope(chat, new Uint8Array(encode('junk')))).rejects.toThrow()
    await expect(openEnvelope(chat, new Uint8Array(40_000))).rejects.toThrow(/too large/)
  })
})
