import {describe, expect, it} from 'vitest'
import {isSingleEmoji} from './emoji'
import data from './emoji-data.json'

describe('the emoji picker list', () => {
  it('holds only emoji that are accepted as a reaction', () => {
    const all = (data as [string, [string, string, number][]][]).flatMap(([, emojis]) => emojis)
    expect(all.length).toBeGreaterThan(1800)
    expect(all.filter(([emoji]) => !isSingleEmoji(emoji)).map(([emoji, name]) => `${emoji} ${name}`)).toEqual([])
  })
})
