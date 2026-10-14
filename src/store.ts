import {openDB, type DBSchema, type IDBPDatabase} from 'idb'
import type {Message} from './envelope'
import type {IdentitySecrets} from './identity'

export type ChatRecord = {
  /** The chat's room ID, derived from its secret and context. */
  id: string
  kind: 'group' | 'dm'
  secret: Uint8Array
  /** What anchors the chat: the founder's signing key for a group, both members' keys for a direct chat. */
  context: Uint8Array
  /** Our certificates, from the founder down to us. Empty for the founder and in direct chats. */
  chain: Uint8Array[]
  /** In a direct chat, the other person's keys. */
  peer?: {signPublic: Uint8Array; dhPublic: Uint8Array}
  name: string
  createdAt: number
  /** When this chat was last looked at; messages received after it count as unread. */
  readAt?: number
  /** Set when rejoining a chat that was left: our earlier messages used sequence numbers up to here. */
  ownSeqFloor?: number
  /** Our own messages up to this number are known to be with the relay that keeps them for members who are offline. */
  storedSeq?: number
  /** When we last collected everything that relay held for this chat. */
  collectedAt?: number
}

export type MessageRecord = Message & {
  chatId: string
  receivedAt: number
  /** The envelope exactly as sent, kept so it can be passed on unmodified when sync arrives. */
  envelope: Uint8Array
}

interface Schema extends DBSchema {
  identity: {key: 'self'; value: IdentitySecrets}
  chats: {key: string; value: ChatRecord}
  messages: {
    key: [chatId: string, author: string, device: string, seq: number]
    value: MessageRecord
    indexes: {
      order: [chatId: string, lamport: number, author: string, device: string, seq: number]
      received: [chatId: string, receivedAt: number]
    }
  }
  /** Encrypted files that messages refer to, such as images. */
  files: {key: [chatId: string, hash: string]; value: {chatId: string; hash: string; data: Uint8Array; addedAt: number}}
  /** Chats that were left: just enough to carry on this device's numbering if we are invited back. */
  left: {key: string; value: {ownSeq: number}}
}

export type Store = ReturnType<typeof wrap>

export type StoreHooks = {
  /** Another tab, running an older version of the app, is holding the storage open; we wait for it. */
  onBlocked?: () => void
  /** A newer version of the app in another tab needs the storage; ours has been closed to let it in. */
  onOutdated?: () => void
}

export async function openStore(name = 'snrdlr', hooks: StoreHooks = {}) {
  const db = await openDB<Schema>(name, 6, {
    blocked: () => hooks.onBlocked?.(),
    // Without this, a tab left open on an old version would stop every newer tab from starting.
    blocking(_current, _blocked, event) {
      ;(event.target as IDBDatabase).close()
      hooks.onOutdated?.()
    },
    upgrade(db, oldVersion, _newVersion, upgrade) {
      if (oldVersion < 1) {
        db.createObjectStore('identity')
        db.createObjectStore('chats', {keyPath: 'id'})
      }
      if (oldVersion < 2) db.createObjectStore('left')
      // Version 4 changed how chats are keyed and who may join them. Chats from before cannot be opened,
      // so they are dropped; the identity is kept.
      if (oldVersion > 0 && oldVersion < 4) {
        for (const store of ['chats', 'messages', 'left'] as const) void upgrade.objectStore(store).clear()
      }
      if (oldVersion < 5) db.createObjectStore('files', {keyPath: ['chatId', 'hash']})
      // Version 6 numbers messages per device, so a message is now named by its device as well. Every
      // message stored before then came from a first device, which has no tag.
      if (oldVersion > 0 && oldVersion < 6) {
        const old = upgrade.objectStore('messages')
        void old.getAll().then(records => {
          db.deleteObjectStore('messages')
          const messages = makeMessages(db)
          for (const record of records) void messages.put({...record, device: record.device ?? ''})
        })
      } else if (oldVersion < 6) makeMessages(db)
    }
  })
  return wrap(db)
}

function makeMessages(db: IDBPDatabase<Schema>) {
  const messages = db.createObjectStore('messages', {keyPath: ['chatId', 'author', 'device', 'seq']})
  messages.createIndex('order', ['chatId', 'lamport', 'author', 'device', 'seq'])
  messages.createIndex('received', ['chatId', 'receivedAt'])
  return messages
}

function wrap(db: IDBPDatabase<Schema>) {
  return {
    getIdentity: () => db.get('identity', 'self'),
    saveIdentity: (identity: IdentitySecrets) => db.put('identity', identity, 'self').then(() => undefined),

    listChats: async () => (await db.getAll('chats')).sort((a, b) => b.createdAt - a.createdAt),
    getChat: (id: string) => db.get('chats', id),
    /** Saves a chat unless it is already known; either way returns the stored record. */
    async saveChat(chat: ChatRecord): Promise<ChatRecord> {
      const tx = db.transaction(['chats', 'left'], 'readwrite')
      const existing = await tx.objectStore('chats').get(chat.id)
      if (existing) return existing
      const tombstone = await tx.objectStore('left').get(chat.id)
      const saved = tombstone ? {...chat, ownSeqFloor: tombstone.ownSeq} : chat
      await tx.objectStore('chats').put(saved)
      await tx.objectStore('left').delete(chat.id)
      await tx.done
      return saved
    },
    /**
     * Forgets a chat and its history on this device. Remembers only how far this device's numbering got,
     * since other members still hold its messages and a rejoin must not reuse their sequence numbers.
     */
    async deleteChat(id: string, self: {id: string; device: string}): Promise<void> {
      const tx = db.transaction(['chats', 'messages', 'left', 'files'], 'readwrite')
      const chat = await tx.objectStore('chats').get(id)
      const ownKeys = await tx
        .objectStore('messages')
        .getAllKeys(IDBKeyRange.bound([id, self.id, self.device, 0], [id, self.id, self.device, Infinity]))
      const ownSeq = Math.max(chat?.ownSeqFloor ?? 0, ...ownKeys.map(([, , , seq]) => seq))
      if (ownSeq > 0) await tx.objectStore('left').put({ownSeq}, id)
      await tx.objectStore('messages').delete(IDBKeyRange.bound([id], [id, []]))
      await tx.objectStore('files').delete(IDBKeyRange.bound([id], [id, []]))
      await tx.objectStore('chats').delete(id)
      await tx.done
    },

    async renameChat(id: string, name: string): Promise<void> {
      const tx = db.transaction('chats', 'readwrite')
      const chat = await tx.store.get(id)
      if (chat && chat.name !== name) await tx.store.put({...chat, name})
      await tx.done
    },
    /** Records how far this chat's dealings with the message-keeping relay have got. Only ever moves forward. */
    async noteMailbox(id: string, progress: {storedSeq?: number; collectedAt?: number}): Promise<void> {
      const tx = db.transaction('chats', 'readwrite')
      const chat = await tx.store.get(id)
      if (chat) {
        const storedSeq = Math.max(chat.storedSeq ?? 0, progress.storedSeq ?? 0)
        const collectedAt = Math.max(chat.collectedAt ?? 0, progress.collectedAt ?? 0)
        await tx.store.put({...chat, ...(storedSeq ? {storedSeq} : {}), ...(collectedAt ? {collectedAt} : {})})
      }
      await tx.done
    },
    /** Replaces a stored message's decoded content, once a newer app version can read it. */
    async updateContent(message: MessageRecord): Promise<void> {
      await db.put('messages', message)
    },
    /** Records that the chat has been looked at up to `at`. */
    async markRead(id: string, at: number): Promise<void> {
      const tx = db.transaction('chats', 'readwrite')
      const chat = await tx.store.get(id)
      if (chat && (chat.readAt ?? 0) < at) await tx.store.put({...chat, readAt: at})
      await tx.done
    },
    /** Which of a chat's files are held, by hash. */
    listFiles: async (chatId: string) => (await db.getAllKeys('files', IDBKeyRange.bound([chatId], [chatId, []]))).map(([, hash]) => hash),
    getFile: async (chatId: string, hash: string) => (await db.get('files', [chatId, hash]))?.data,
    putFile: (chatId: string, hash: string, data: Uint8Array) => db.put('files', {chatId, hash, data, addedAt: Date.now()}).then(() => undefined),

    /** How many messages and pictures from other people have arrived since the chat was last looked at. */
    async unreadCount(chat: ChatRecord, selfId: string): Promise<number> {
      const since = IDBKeyRange.bound([chat.id, chat.readAt ?? chat.createdAt], [chat.id, Infinity], true)
      const arrived = await db.getAllFromIndex('messages', 'received', since)
      return arrived.filter(message => message.author !== selfId && (message.content.type === 'text' || message.content.type === 'image')).length
    },

    /** A chat's messages in display order: by logical clock, then author. */
    listMessages: (chatId: string) =>
      // An array sorts after any number, so [chatId, []] is past every clock value.
      db.getAllFromIndex('messages', 'order', IDBKeyRange.bound([chatId], [chatId, []])),

    /** Stores a message; false if this (author, device, seq) is already held. */
    async addMessage(message: MessageRecord): Promise<boolean> {
      const tx = db.transaction('messages', 'readwrite')
      const isNew = (await tx.store.getKey([message.chatId, message.author, message.device, message.seq])) === undefined
      if (isNew) await tx.store.add(message)
      await tx.done
      return isNew
    },

    close: () => db.close()
  }
}
