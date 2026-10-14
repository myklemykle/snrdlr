// What the relay is told about notifications, kept apart from push.ts so a chat session can use it
// without pulling in the browser's push machinery.
import {sha256} from '@noble/hashes/sha2.js'
import {concatBytes, toHex, utf8} from './bytes'
import type {Identity} from './identity'
import type {ChatRecord, MessageRecord} from './store'

/** A message older than this is being caught up on, not news; leaving it with the relay wakes nobody. */
const NEWS_MS = 15 * 60_000

/**
 * The tag a person's messages in a chat carry, and that their devices register for that chat, so the
 * relay wakes everyone but the author. Worked out from the chat's secret, it means nothing to the relay
 * beyond telling one member's messages from another's within that chat.
 */
export const pushTag = (chat: Pick<ChatRecord, 'secret'>, identity: Pick<Identity, 'signPublic'>) =>
  toHex(sha256(concatBytes(utf8('snrdlr/v1/push-tag'), chat.secret, identity.signPublic)).slice(0, 16))

/** Whether a message is something a person would want to be woken for: words or a picture, just written. */
export const worthNotifying = (record: Pick<MessageRecord, 'content' | 'sentAt'>, now = Date.now()) =>
  (record.content.type === 'text' || record.content.type === 'image') && now - record.sentAt < NEWS_MS
