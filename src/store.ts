import {openDB, type DBSchema, type IDBPDatabase} from 'idb'
import type {Message} from './envelope'
import type {IdentitySecrets} from './identity'

export type ChatRecord = {
  /** The chat's room ID, derived from its secret. */
  id: string
  secret: Uint8Array
  name: string
  createdAt: number
  /** When this chat was last looked at; messages received after it count as unread. */
  readAt?: number
  /** Set when rejoining a chat that was left: our earlier messages used sequence numbers up to here. */
  ownSeqFloor?: number
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
    key: [chatId: string, author: string, seq: number]
    value: MessageRecord
    indexes: {
      order: [chatId: string, lamport: number, author: string, seq: number]
      received: [chatId: string, receivedAt: number]
    }
  }
  /** Chats that were left: just enough to carry on our numbering if we are invited back. */
  left: {key: string; value: {ownSeq: number}}
}

export type Store = ReturnType<typeof wrap>

export async function openStore(name = 'snrdlr') {
  const db = await openDB<Schema>(name, 3, {
    upgrade(db, oldVersion, _newVersion, upgrade) {
      if (oldVersion < 1) {
        db.createObjectStore('identity')
        db.createObjectStore('chats', {keyPath: 'id'})
        const messages = db.createObjectStore('messages', {keyPath: ['chatId', 'author', 'seq']})
        messages.createIndex('order', ['chatId', 'lamport', 'author', 'seq'])
      }
      if (oldVersion < 2) db.createObjectStore('left')
      if (oldVersion < 3) upgrade.objectStore('messages').createIndex('received', ['chatId', 'receivedAt'])
    }
  })
  return wrap(db)
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
     * Forgets a chat and its history on this device. Remembers only how far our own numbering got, since
     * other members still hold our messages and a rejoin must not reuse their sequence numbers.
     */
    async deleteChat(id: string, selfId: string): Promise<void> {
      const tx = db.transaction(['chats', 'messages', 'left'], 'readwrite')
      const chat = await tx.objectStore('chats').get(id)
      const ownKeys = await tx.objectStore('messages').getAllKeys(IDBKeyRange.bound([id, selfId, 0], [id, selfId, Infinity]))
      const ownSeq = Math.max(chat?.ownSeqFloor ?? 0, ...ownKeys.map(([, , seq]) => seq))
      if (ownSeq > 0) await tx.objectStore('left').put({ownSeq}, id)
      await tx.objectStore('messages').delete(IDBKeyRange.bound([id], [id, []]))
      await tx.objectStore('chats').delete(id)
      await tx.done
    },

    /** Records that the chat has been looked at up to `at`. */
    async markRead(id: string, at: number): Promise<void> {
      const tx = db.transaction('chats', 'readwrite')
      const chat = await tx.store.get(id)
      if (chat && (chat.readAt ?? 0) < at) await tx.store.put({...chat, readAt: at})
      await tx.done
    },
    /** How many text messages from other people have arrived since the chat was last looked at. */
    async unreadCount(chat: ChatRecord, selfId: string): Promise<number> {
      const since = IDBKeyRange.bound([chat.id, chat.readAt ?? chat.createdAt], [chat.id, Infinity], true)
      const arrived = await db.getAllFromIndex('messages', 'received', since)
      return arrived.filter(message => message.author !== selfId && message.content.type === 'text').length
    },

    /** A chat's messages in display order: by logical clock, then author. */
    listMessages: (chatId: string) =>
      // An array sorts after any number, so [chatId, []] is past every clock value.
      db.getAllFromIndex('messages', 'order', IDBKeyRange.bound([chatId], [chatId, []])),

    /** Stores a message; false if this (author, seq) is already held. */
    async addMessage(message: MessageRecord): Promise<boolean> {
      const tx = db.transaction('messages', 'readwrite')
      const isNew = (await tx.store.getKey([message.chatId, message.author, message.seq])) === undefined
      if (isNew) await tx.store.add(message)
      await tx.done
      return isNew
    },

    close: () => db.close()
  }
}
