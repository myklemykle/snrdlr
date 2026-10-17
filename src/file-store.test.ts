import {describe, expect, it} from 'vitest'
import {memoryStore, Relay} from '../worker-relay/src/relay'
import {fetchFile, fileTopic, leaveFile} from './file-store'
import {fileHash, sealFile} from './files'
import {relayMailboxes} from './mailbox'

/** Our real relay's rules, reached through stand-in sockets. */
function relaySockets() {
  const relay = new Relay(Date.now, memoryStore())
  let serial = 0
  return () => {
    const id = `socket-${serial++}`
    const socket = {
      readyState: 0,
      onopen: null as null | (() => void),
      onmessage: null as null | ((event: {data: string}) => void),
      onclose: null as null | (() => void),
      onerror: null as null | (() => void),
      send: (text: string) => void relay.receive(id, text),
      close() {
        socket.readyState = 3
        relay.remove(id)
      }
    }
    queueMicrotask(() => {
      relay.add({send: text => queueMicrotask(() => socket.readyState === 1 && socket.onmessage?.({data: text})), save: () => {}}, {id, from: id, subs: {}})
      socket.readyState = 1
      socket.onopen?.()
    })
    return socket as unknown as WebSocket
  }
}

const TOPIC = 'cd'.repeat(32)

describe('files left with the relay', () => {
  it('are kept in pieces under a topic of their own, and come back whole', async () => {
    const open = relayMailboxes('wss://relay', relaySockets())
    const plain = new Uint8Array(150_000)
    for (let at = 0; at < plain.length; at += 65_536) crypto.getRandomValues(plain.subarray(at, at + 65_536))
    const {data, hash} = await sealFile(plain)
    expect(await leaveFile(open, TOPIC, hash, data)).toBe(true)
    expect(fileTopic(TOPIC, hash)).not.toBe(TOPIC)
    const back = await fetchFile(open, TOPIC, hash, data.length)
    expect(back && (await fileHash(back))).toBe(hash)
  })

  it('come back as nothing when the relay does not have them, or has something else', async () => {
    const open = relayMailboxes('wss://relay', relaySockets())
    const {data, hash} = await sealFile(new Uint8Array(1000).fill(7))
    expect(await fetchFile(open, TOPIC, hash, data.length)).toBeNull()
    await leaveFile(open, TOPIC, hash, data)
    // The size from the signed message does not match: not the file it names.
    expect(await fetchFile(open, TOPIC, hash, data.length + 1)).toBeNull()
  })
})
