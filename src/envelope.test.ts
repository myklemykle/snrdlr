import {ed25519} from '@noble/curves/ed25519.js'
import {decode, encode} from 'cbor-x'
import {describe, expect, it} from 'vitest'
import {concatBytes, fromHex, utf8} from './bytes'
import {importMsgKey, openEnvelope, sealEnvelope, type ChatContext, type Message} from './envelope'
import {createIdentity} from './identity'
import {deriveChatKeys, generateGroupSecret} from './keys'

async function makeChat(): Promise<ChatContext> {
  const keys = deriveChatKeys(generateGroupSecret(), new Uint8Array(32).fill(1))
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

    const profile = {...hello, seq: 2, content: {type: 'profile', name: 'Anne', dh: anne.dhPublic}} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, profile))).toEqual({...profile, author: anne.id})

    const proven = {...profile, content: {...profile.content, chain: [new Uint8Array([1, 2]), new Uint8Array([3])]}}
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, proven))).toEqual({...proven, author: anne.id})

    const cert = {...hello, seq: 3, content: {type: 'member-cert', cert: new Uint8Array([1, 2, 3])}} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, cert))).toEqual({...cert, author: anne.id})

    const groupInvite: Omit<Message, 'author'> = {
      ...hello,
      seq: 4,
      content: {type: 'group-invite', secret: new Uint8Array(32).fill(3), name: 'Group', founder: anne.signPublic, chain: [new Uint8Array([7])]}
    }
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, groupInvite))).toEqual({...groupInvite, author: anne.id})
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

  it('keeps a genuine message of a kind it does not know, instead of dropping it', async () => {
    // What a device on this version sees when a newer version sends, say, a reply.
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const authorBytes = fromHex(anne.id)
    const payload = new Uint8Array(encode(['reply', {to: 4, text: 'yes'}, 9, 1_760_000_000_000]))
    const bound = (label: string) => {
      const seq = new Uint8Array(8)
      seq[7] = 5
      return concatBytes(utf8(`snrdlr/v1/${label}\0`), utf8(chat.chatId), authorBytes, seq)
    }
    const signature = ed25519.sign(concatBytes(bound('msg'), payload), anne.signSecret)
    const inner = new Uint8Array(encode({p: payload, k: anne.signPublic, g: signature}))
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: bound('env')}, chat.msgKey, inner)
    const envelope = new Uint8Array(encode({v: 1, a: authorBytes, s: 5, n: nonce, c: new Uint8Array(ciphertext)}))

    expect(await openEnvelope(chat, envelope)).toEqual({
      author: anne.id,
      seq: 5,
      lamport: 9,
      sentAt: 1_760_000_000_000,
      content: {type: 'unknown', kind: 'reply'}
    })
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
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'profile', name: '', dh: anne.dhPublic}}))).rejects.toThrow(/profile/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'profile', name: 'A', dh: new Uint8Array(5)}}))).rejects.toThrow(/profile/)
    const longChain = Array.from({length: 33}, () => new Uint8Array([1]))
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'profile', name: 'A', dh: anne.dhPublic, chain: longChain}}))).rejects.toThrow(/profile/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'profile', name: 'A', dh: anne.dhPublic, chain: [new Uint8Array(600)]}}))).rejects.toThrow(/profile/)
    await expect(openEnvelope(chat, await seal({...hello, content: {type: 'member-cert', cert: new Uint8Array(600)}}))).rejects.toThrow(/certificate/)
    await expect(seal({...hello, content: {type: 'unknown', kind: 'reply'}})).rejects.toThrow(/unknown/)
    await expect(openEnvelope(chat, new Uint8Array(encode('junk')))).rejects.toThrow()
    await expect(openEnvelope(chat, new Uint8Array(40_000))).rejects.toThrow(/too large/)
  })
})
