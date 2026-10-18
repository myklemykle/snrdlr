import {describe, expect, it} from 'vitest'
import {isSingleEmoji} from './emoji'
import data from './emoji-data.json'

describe('the emoji picker list', () => {
  it('holds only emoji that are accepted as a reaction', () => {
    const all = (data as [string, [string, string, number, string][]][]).flatMap(([, emojis]) => emojis)
    expect(all.length).toBeGreaterThan(1800)
    expect(all.filter(([emoji]) => !isSingleEmoji(emoji)).map(([emoji, name]) => `${emoji} ${name}`)).toEqual([])
  })

  it('carries everyday search words, so 😂 is found by "haha" and 💯 by "100"', () => {
    const all = (data as [string, [string, string, number, string][]][]).flatMap(([, emojis]) => emojis)
    const wordsOf = (emoji: string) => all.find(([each]) => each === emoji)?.[3].split(' ')
    expect(wordsOf('😂')).toContain('haha')
    expect(wordsOf('💯')).toContain('100')
  })
})
