// Works out which reactions each message is showing, from the reaction messages in the log.
import type {MessageRecord} from './store'

/** Offered at a tap; any other emoji can be typed. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export type Tally = {emoji: string; by: string[]}

export const messageKey = (message: {author: string; seq: number}) => `${message.author}:${message.seq}`

/**
 * For each message that has reactions: the emoji on it and who chose each, in the order they first
 * appeared. A person's latest reaction to a message is the one that counts.
 */
export function tallyReactions(messages: MessageRecord[]): Map<string, Tally[]> {
  const reactable = new Set(messages.filter(({content}) => content.type === 'text' || content.type === 'image').map(messageKey))
  // Target, then reactor, to that person's latest reaction. Their own numbering says which is latest,
  // whatever their clock claimed.
  const latest = new Map<string, Map<string, {seq: number; emoji: string}>>()
  for (const message of messages) {
    if (message.content.type !== 'reaction') continue
    const target = messageKey(message.content.target)
    if (!reactable.has(target)) continue
    if (!latest.has(target)) latest.set(target, new Map())
    const byReactor = latest.get(target)!
    const earlier = byReactor.get(message.author)
    if (!earlier || message.seq > earlier.seq) {
      // Deleting first keeps the map in the order of each person's current reaction.
      byReactor.delete(message.author)
      byReactor.set(message.author, {seq: message.seq, emoji: message.content.emoji})
    }
  }
  const tallies = new Map<string, Tally[]>()
  for (const [target, byReactor] of latest) {
    const found: Tally[] = []
    for (const [reactor, {emoji}] of byReactor) {
      if (emoji === '') continue
      const tally = found.find(entry => entry.emoji === emoji)
      if (tally) tally.by.push(reactor)
      else found.push({emoji, by: [reactor]})
    }
    if (found.length > 0) tallies.set(target, found)
  }
  return tallies
}
