// One open chat: joins its room, and keeps the stored log and the network in step.
import {importMsgKey, openEnvelope, sealEnvelope, type ChatContext, type Content} from './envelope'
import type {Identity} from './identity'
import {deriveChatKeys, type ChatKeys} from './keys'
import type {Route} from './route'
import type {ChatRecord, MessageRecord, Store} from './store'

export type WireHandlers = {
  onEnvelope: (envelope: Uint8Array, peerId: string) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
}

export type Wire = {
  /** Sends to everyone connected, or to one peer. */
  send: (envelope: Uint8Array, peerId?: string) => Promise<void>
  routes: () => Promise<Route[]>
  leave: () => Promise<void>
}

export type SessionHandlers = {
  onMessages: (messages: MessageRecord[]) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
}

export type Session = {
  sendText: (text: string) => Promise<void>
  routes: () => Promise<Route[]>
  close: () => Promise<void>
}

const compare = (a: MessageRecord, b: MessageRecord) =>
  a.lamport - b.lamport || a.author.localeCompare(b.author) || a.seq - b.seq

const MAX_SEQ_RETRIES = 5

export async function openSession(options: {
  chat: ChatRecord
  identity: Identity
  store: Store
  connect: (keys: ChatKeys, handlers: WireHandlers) => Wire
  handlers: SessionHandlers
}): Promise<Session> {
  const {chat, identity, store, handlers} = options
  const keys = deriveChatKeys(chat.secret)
  const context: ChatContext = {chatId: chat.id, msgKey: await importMsgKey(keys.msgKey)}

  let messages = await store.listMessages(chat.id)
  let knownPeers = new Set<string>()
  let closed = false
  const publish = () => handlers.onMessages(messages)

  const insert = (record: MessageRecord) => {
    messages = [...messages, record].sort(compare)
    publish()
  }
  const lamportNow = () => messages.reduce((max, message) => Math.max(max, message.lamport), 0)
  const ownSeq = () => messages.reduce((max, message) => (message.author === identity.id ? Math.max(max, message.seq) : max), 0)

  /** Signs, stores, then sends a message of our own. */
  async function post(content: Content): Promise<MessageRecord> {
    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      const message = {seq: ownSeq() + 1, lamport: lamportNow() + 1, sentAt: Date.now(), content}
      const envelope = await sealEnvelope(context, identity, message)
      const record: MessageRecord = {...message, author: identity.id, chatId: chat.id, receivedAt: message.sentAt, envelope}
      if (await store.addMessage(record)) {
        insert(record)
        return record
      }
      // Another tab on this device used that sequence number first; pick up its messages and retry.
      messages = await store.listMessages(chat.id)
      publish()
    }
    throw new Error('could not allocate a sequence number')
  }

  async function receive(envelope: Uint8Array) {
    try {
      const message = await openEnvelope(context, envelope)
      const record: MessageRecord = {...message, chatId: chat.id, receivedAt: Date.now(), envelope}
      if ((await store.addMessage(record)) && !closed) insert(record)
    } catch (error) {
      console.warn('dropped a message:', error instanceof Error ? error.message : error)
    }
  }

  const ownProfile = () => messages.findLast(message => message.author === identity.id && message.content.type === 'profile')

  const wire = options.connect(keys, {
    onEnvelope: envelope => void receive(envelope),
    onPeersChange: peerIds => {
      // Until full sync exists, introduce ourselves to each newcomer so they can show our name.
      const profile = ownProfile()
      for (const peerId of peerIds) {
        if (!knownPeers.has(peerId) && profile) void wire.send(profile.envelope, peerId).catch(() => {})
      }
      knownPeers = new Set(peerIds)
      handlers.onPeersChange(peerIds)
    },
    onError: handlers.onError
  })

  publish()
  if (!ownProfile()) {
    const profile = await post({type: 'profile', name: identity.name})
    // Peers may have connected while it was being signed, before there was a profile to hand them.
    void wire.send(profile.envelope).catch(() => {})
  }

  return {
    async sendText(text) {
      const record = await post({type: 'text', text})
      await wire.send(record.envelope)
    },
    routes: wire.routes,
    close() {
      closed = true
      return wire.leave()
    }
  }
}
