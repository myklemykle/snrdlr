import {describe, expect, it} from 'vitest'
import {tallyReactions} from './reactions'
import type {MessageRecord} from './store'

const [anne, bob, cindy] = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
let lamport = 0

const text = (author: string, seq: number) => ({author, seq, lamport: ++lamport, content: {type: 'text', text: 'hi'}}) as MessageRecord
const reaction = (author: string, seq: number, target: [string, number], emoji: string) =>
  ({author, seq, lamport: ++lamport, content: {type: 'reaction', target: {author: target[0], seq: target[1]}, emoji}}) as MessageRecord

describe('tallyReactions', () => {
  it('groups people by the emoji they chose, in the order the emoji first appeared', () => {
    const log = [text(anne, 1), reaction(bob, 1, [anne, 1], '👍'), reaction(cindy, 1, [anne, 1], '❤️'), reaction(anne, 2, [anne, 1], '👍')]
    expect(tallyReactions(log).get(`${anne}:1`)).toEqual([
      {emoji: '👍', by: [bob, anne]},
      {emoji: '❤️', by: [cindy]}
    ])
  })

  it("counts only each person's latest reaction to a message", () => {
    const log = [text(anne, 1), reaction(bob, 1, [anne, 1], '👍'), reaction(bob, 2, [anne, 1], '😂')]
    expect(tallyReactions(log).get(`${anne}:1`)).toEqual([{emoji: '😂', by: [bob]}])
  })

  it('goes by the order the person sent them, whatever order they are held in', () => {
    // A device with a wrong clock can file its later message earlier in the log.
    const log = [text(anne, 1), reaction(bob, 2, [anne, 1], '😂'), reaction(bob, 1, [anne, 1], '👍')]
    expect(tallyReactions(log).get(`${anne}:1`)).toEqual([{emoji: '😂', by: [bob]}])
  })

  it('takes a reaction away when its author sends an empty one', () => {
    const log = [text(anne, 1), reaction(bob, 1, [anne, 1], '👍'), reaction(cindy, 1, [anne, 1], '👍'), reaction(bob, 2, [anne, 1], '')]
    expect(tallyReactions(log).get(`${anne}:1`)).toEqual([{emoji: '👍', by: [cindy]}])
    expect(tallyReactions([...log, reaction(cindy, 2, [anne, 1], '')]).has(`${anne}:1`)).toBe(false)
  })

  it('keeps reactions to different messages apart, and ignores ones aimed at nothing', () => {
    const log = [text(anne, 1), text(anne, 2), reaction(bob, 1, [anne, 2], '👍'), reaction(bob, 2, [anne, 9], '👍'), reaction(bob, 3, [bob, 1], '👍')]
    expect([...tallyReactions(log).keys()]).toEqual([`${anne}:2`])
  })
})
