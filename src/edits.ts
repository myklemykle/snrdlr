// Works out what each edited message now says, from the edit messages in the log.
import {writtenAfter} from './envelope'
import {messageKey} from './reactions'
import type {MessageRecord} from './store'

/**
 * For each message that has been edited, by key (see reactions.ts): its words now. Only a message's own
 * author can edit it, from any of their devices, and their latest edit is the one that counts. A picture's words are its caption,
 * which may be edited away; a message in words cannot be made empty.
 */
export function latestEdits(messages: MessageRecord[]): Map<string, string> {
  const kinds = new Map<string, string>()
  for (const message of messages) kinds.set(messageKey(message), message.content.type)
  const latest = new Map<string, {message: MessageRecord; text: string}>()
  for (const message of messages) {
    if (message.content.type !== 'edit') continue
    const key = messageKey({author: message.author, ...message.content.target})
    const kind = kinds.get(key)
    if (kind !== 'image' && !(kind === 'text' && message.content.text !== '')) continue
    const earlier = latest.get(key)
    if (!earlier || writtenAfter(message, earlier.message)) latest.set(key, {message, text: message.content.text})
  }
  return new Map([...latest].map(([key, {text}]) => [key, text]))
}
