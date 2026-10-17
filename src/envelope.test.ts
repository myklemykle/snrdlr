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

const hello: Omit<Message, 'author'> = {device: '', seq: 1, lamport: 3, sentAt: 1_760_000_000_000, content: {type: 'text', text: 'hello ⛰️'}}

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
    const payload = new Uint8Array(encode(['poll', {to: 4, text: 'yes'}, 9, 1_760_000_000_000]))
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
      device: '',
      seq: 5,
      lamport: 9,
      sentAt: 1_760_000_000_000,
      content: {type: 'unknown', kind: 'poll'}
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
    await expect(seal({...hello, content: {type: 'unknown', kind: 'poll'}})).rejects.toThrow(/unknown/)
    await expect(openEnvelope(chat, new Uint8Array(encode('junk')))).rejects.toThrow()
    await expect(openEnvelope(chat, new Uint8Array(40_000))).rejects.toThrow(/too large/)
  })

  it('round-trips a reaction and its removal, and refuses one that is not a single emoji', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const target = {author: 'ab'.repeat(32), device: '', seq: 7}
    for (const emoji of ['👍', '👨‍👩‍👧', '']) {
      const reaction = {...hello, seq: 2, content: {type: 'reaction', target, emoji}} as const
      expect(await openEnvelope(chat, await sealEnvelope(chat, anne, reaction))).toEqual({...reaction, author: anne.id})
    }
    for (const emoji of ['nice', '👍👍', '👍 ']) {
      const reaction = {...hello, seq: 2, content: {type: 'reaction', target, emoji}} as const
      await expect(openEnvelope(chat, await sealEnvelope(chat, anne, reaction))).rejects.toThrow('bad reaction body')
    }
  })

  it('round-trips a reply in words and one that is a picture, and refuses one that points nowhere', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const replyTo = {author: 'ab'.repeat(32), device: '', seq: 7}
    const words = {...hello, seq: 2, content: {type: 'text', text: 'yes, at six', replyTo}} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, words))).toEqual({...words, author: anne.id})
    const image = {type: 'image', hash: 'cd'.repeat(32), key: new Uint8Array(32).fill(5), size: 1000, width: 4, height: 3, preview: new Uint8Array(0), replyTo} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, {...hello, seq: 3, content: image}))).toEqual({...hello, seq: 3, content: image, author: anne.id})
    // An ordinary message still travels exactly as before, so older versions of the app read it.
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, hello))).toEqual({...hello, author: anne.id})
    for (const bad of [{author: 'ab'.repeat(32), device: '', seq: 0}, {author: 'ab'.repeat(8), device: '', seq: 1}, {author: 'ab'.repeat(32), device: 'ab', seq: 1}]) {
      const reply = {...hello, seq: 2, content: {type: 'text', text: 'hm', replyTo: bad}} as const
      await expect(openEnvelope(chat, await sealEnvelope(chat, anne, reply))).rejects.toThrow('bad reference to a message')
    }
  })

  it('round-trips a new name for the chat, and refuses an empty or overlong one', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const rename = {...hello, seq: 2, content: {type: 'rename', name: 'Picnic'}} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, rename))).toEqual({...rename, author: anne.id})
    for (const name of ['', '   ', 'x'.repeat(65)]) {
      const bad = {...hello, seq: 2, content: {type: 'rename', name}} as const
      await expect(openEnvelope(chat, await sealEnvelope(chat, anne, bad))).rejects.toThrow('bad rename body')
    }
  })

  it("round-trips how far one of a person's devices has read a chat, and refuses marks that name no writer", async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const id = 'ab'.repeat(32)
    const seen = {[anne.id]: 4, [`${anne.id}.0123456789abcdef`]: 12}
    const read = {...hello, seq: 2, content: {type: 'chat-read', id, seen}} as const
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, read))).toEqual({...read, author: anne.id})
    for (const bad of [{__proto__x: 1}, {[anne.id]: -1}, {[anne.id]: 1.5}, {[`${anne.id}.12`]: 1}]) {
      const wrong = {...hello, seq: 2, content: {type: 'chat-read', id, seen: bad}} as const
      await expect(openEnvelope(chat, await sealEnvelope(chat, anne, wrong))).rejects.toThrow('bad chat body')
    }
  })

  it('round-trips a voice message, keeps one of a kind it does not know, and refuses one too long', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const audio = {type: 'audio', mime: 'audio/mp4', hash: 'ab'.repeat(32), key: new Uint8Array(32).fill(3), size: 12_345, duration: 4_200} as const
    const voice = {...hello, seq: 2, content: audio}
    expect(await openEnvelope(chat, await sealEnvelope(chat, anne, voice))).toEqual({...voice, author: anne.id})
    const later = {...hello, seq: 3, content: {...audio, mime: 'audio/flac'}} as unknown as typeof voice
    expect((await openEnvelope(chat, await sealEnvelope(chat, anne, later))).content).toEqual({type: 'unknown', kind: 'audio'})
    const long = {...hello, seq: 4, content: {...audio, duration: 5 * 60_000 + 1}}
    await expect(openEnvelope(chat, await sealEnvelope(chat, anne, long))).rejects.toThrow('bad audio body')
  })

  it('round-trips a profile card, full and empty, and refuses one with a part that is not what it should be', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const photo = {hash: 'cd'.repeat(32), key: new Uint8Array(32).fill(5), size: 1000, width: 4, height: 3, preview: new Uint8Array([1])}
    const full = {type: 'card', avatar: new Uint8Array([1, 2, 3]), photo, contact: {kind: 'email', value: 'anne@example.com'}, color: '#2f9e5b'} as const
    for (const content of [full, {type: 'card', icon: '🦊'}, {type: 'card'}] as const) {
      expect(await openEnvelope(chat, await sealEnvelope(chat, anne, {...hello, seq: 2, content}))).toEqual({...hello, seq: 2, content, author: anne.id})
    }
    const bad = [
      {type: 'card', icon: 'fox'},
      {type: 'card', color: 'red'},
      {type: 'card', color: 'url(x)'},
      {type: 'card', avatar: new Uint8Array(9000)},
      {type: 'card', contact: {kind: 'email', value: 'x'.repeat(101)}},
      {type: 'card', contact: {kind: 'fax', value: '1'}},
      {type: 'card', photo: {...photo, size: 0}}
    ]
    for (const content of bad) {
      await expect(openEnvelope(chat, await sealEnvelope(chat, anne, {...hello, seq: 2, content: content as never}))).rejects.toThrow(/bad card body|bad picture/)
    }
  })

  it("carries a device's tag, which cannot be taken off or changed", async () => {
    const chat = await makeChat()
    const anne = {...createIdentity('Anne'), device: '0123456789abcdef'}
    const sealed = await sealEnvelope(chat, anne, hello)
    expect(await openEnvelope(chat, sealed)).toEqual({...hello, author: anne.id, device: anne.device})
    await expect(openEnvelope(chat, rewrite(sealed, {d: undefined}))).rejects.toThrow(/decrypt/)
    await expect(openEnvelope(chat, rewrite(sealed, {d: new Uint8Array(8)}))).rejects.toThrow(/decrypt/)
    await expect(openEnvelope(chat, rewrite(sealed, {d: new Uint8Array(3)}))).rejects.toThrow('bad device tag')
    // An edit or reaction can name a message from any device.
    const target = {author: anne.id, device: anne.device, seq: 4}
    const reaction = {...hello, seq: 2, content: {type: 'reaction', target, emoji: '👍'}} as const
    expect((await openEnvelope(chat, await sealEnvelope(chat, anne, reaction))).content).toEqual(reaction.content)
    const edit = {...hello, seq: 3, content: {type: 'edit', target: {device: anne.device, seq: 4}, text: 'x'}} as const
    expect((await openEnvelope(chat, await sealEnvelope(chat, anne, edit))).content).toEqual(edit.content)
  })

  it('round-trips an edit, and refuses one that names no message', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    for (const text of ['hello there', '']) {
      const edit = {...hello, seq: 2, content: {type: 'edit', target: {device: '', seq: 1}, text}} as const
      expect(await openEnvelope(chat, await sealEnvelope(chat, anne, edit))).toEqual({...edit, author: anne.id})
    }
    const bad = {...hello, seq: 2, content: {type: 'edit', target: {device: '', seq: 0}, text: 'x'}} as const
    await expect(openEnvelope(chat, await sealEnvelope(chat, anne, bad))).rejects.toThrow('bad edit body')
  })

  it('round-trips a picture, and keeps one of a kind it does not know for a later version', async () => {
    const chat = await makeChat()
    const anne = createIdentity('Anne')
    const image = {
      type: 'image',
      hash: 'cd'.repeat(32),
      key: new Uint8Array(32).fill(5),
      size: 123_456,
      width: 1600,
      height: 1200,
      preview: new Uint8Array([1, 2, 3])
    } as const
    for (const content of [image, {...image, caption: 'the view ⛰️'}, {...image, preview: new Uint8Array(0)}]) {
      const message = {...hello, seq: 2, content}
      expect(await openEnvelope(chat, await sealEnvelope(chat, anne, message))).toEqual({...message, author: anne.id})
    }
    for (const broken of [{size: 0}, {size: 3 * 1024 * 1024}, {width: 0}, {height: 20_000}, {preview: new Uint8Array(4000)}, {key: new Uint8Array(5)}]) {
      const message = {...hello, seq: 2, content: {...image, ...broken}}
      await expect(openEnvelope(chat, await sealEnvelope(chat, anne, message))).rejects.toThrow('bad image body')
    }
  })
})
