// Works out what each edited message now says, from the edit messages in the log.
import type {MessageRecord} from './store'

/**
 * For each message that has been edited, by key (see reactions.ts): its words now. Only a message's own
 * author can edit it, and their latest edit is the one that counts. A picture's words are its caption,
 * which may be edited away; a message in words cannot be made empty.
 */
export function latestEdits(messages: MessageRecord[]): Map<string, string> {
  const kinds = new Map<string, string>()
  for (const message of messages) kinds.set(`${message.author}:${message.seq}`, message.content.type)
  // The author's own numbering says which edit is latest, whatever their clock claimed.
  const latest = new Map<string, {seq: number; text: string}>()
  for (const message of messages) {
    if (message.content.type !== 'edit') continue
    const key = `${message.author}:${message.content.target}`
    const kind = kinds.get(key)
    if (kind !== 'image' && !(kind === 'text' && message.content.text !== '')) continue
    const earlier = latest.get(key)
    if (!earlier || message.seq > earlier.seq) latest.set(key, {seq: message.seq, text: message.content.text})
  }
  return new Map([...latest].map(([key, {text}]) => [key, text]))
}
