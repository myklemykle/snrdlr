import {describe, expect, it} from 'vitest'
import {latestEdits} from './edits'
import type {MessageRecord} from './store'

let lamport = 0
const record = (author: string, seq: number, content: MessageRecord['content']) =>
  ({chatId: 'c', author, seq, lamport: ++lamport, sentAt: 0, content, envelope: new Uint8Array(0)}) as unknown as MessageRecord
const image = {type: 'image', hash: 'h', key: new Uint8Array(0), size: 1, width: 1, height: 1, preview: new Uint8Array(0), caption: 'a view'} as const

describe('edits', () => {
  it("takes each author's latest edit of their own message, by their numbering", () => {
    const log = [
      record('anne', 1, {type: 'text', text: 'helo'}),
      record('anne', 3, {type: 'edit', target: 1, text: 'hello there'}),
      record('anne', 2, {type: 'edit', target: 1, text: 'hello'}),
      record('bob', 1, {type: 'text', text: 'hi'})
    ]
    expect([...latestEdits(log)]).toEqual([['anne:1', 'hello there']])
  })

  it("cannot change someone else's message: an edit only ever names the editor's own", () => {
    const log = [record('anne', 1, {type: 'text', text: 'I owe Bob nothing'}), record('bob', 1, {type: 'edit', target: 1, text: 'I owe Bob ten pounds'})]
    expect(latestEdits(log).size).toBe(0)
  })

  it('can take a caption away, but cannot empty a message in words or edit what is not a message', () => {
    const log = [
      record('anne', 1, image),
      record('anne', 2, {type: 'edit', target: 1, text: ''}),
      record('anne', 3, {type: 'text', text: 'words'}),
      record('anne', 4, {type: 'edit', target: 3, text: ''}),
      record('anne', 5, {type: 'reaction', target: {author: 'bob', seq: 1}, emoji: '👍'}),
      record('anne', 6, {type: 'edit', target: 5, text: 'x'}),
      record('anne', 7, {type: 'edit', target: 99, text: 'x'})
    ]
    expect([...latestEdits(log)]).toEqual([['anne:1', '']])
  })
})
