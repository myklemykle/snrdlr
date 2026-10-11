import {openDB, type DBSchema, type IDBPDatabase} from 'idb'
import type {Message} from './envelope'
import type {IdentitySecrets} from './identity'

export type ChatRecord = {
  /** The chat's room ID, derived from its secret. */
  id: string
  secret: Uint8Array
  name: string
  createdAt: number
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
    indexes: {order: [chatId: string, lamport: number, author: string, seq: number]}
  }
}

export type Store = ReturnType<typeof wrap>

export async function openStore(name = 'snrdlr') {
  const db = await openDB<Schema>(name, 1, {
    upgrade(db) {
      db.createObjectStore('identity')
      db.createObjectStore('chats', {keyPath: 'id'})
      const messages = db.createObjectStore('messages', {keyPath: ['chatId', 'author', 'seq']})
      messages.createIndex('order', ['chatId', 'lamport', 'author', 'seq'])
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
      const tx = db.transaction('chats', 'readwrite')
      const existing = await tx.store.get(chat.id)
      if (!existing) await tx.store.put(chat)
      await tx.done
      return existing ?? chat
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
