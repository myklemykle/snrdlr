import {describe, expect, it} from 'vitest'
import {isJumboEmoji, splitEmoji} from './emoji'

const emojiParts = (text: string) => splitEmoji(text).filter(segment => segment.emoji).map(segment => segment.text)

describe('splitEmoji', () => {
  it('separates emoji from the words around them without losing anything', () => {
    const text = 'On my way 🚗 see you at 8 ⛰️!'
    expect(splitEmoji(text)).toEqual([
      {text: 'On my way ', emoji: false},
      {text: '🚗', emoji: true},
      {text: ' see you at 8 ', emoji: false},
      {text: '⛰️', emoji: true},
      {text: '!', emoji: false}
    ])
    expect(splitEmoji(text).map(segment => segment.text).join('')).toBe(text)
  })

  it('keeps multi-part emoji whole', () => {
    expect(emojiParts('a 👍🏽 b')).toEqual(['👍🏽'])
    expect(emojiParts('a 👩‍👩‍👧 b')).toEqual(['👩‍👩‍👧'])
    expect(emojiParts('a 🏳️‍🌈 b')).toEqual(['🏳️‍🌈'])
    expect(emojiParts('a 🇳🇴 b')).toEqual(['🇳🇴'])
    expect(emojiParts('a 1️⃣ b')).toEqual(['1️⃣'])
    expect(emojiParts('🎉🎉🎉')).toEqual(['🎉🎉🎉'])
  })

  it('leaves ordinary text, digits and plain symbols alone', () => {
    for (const text of ['hello', 'call 555 0100 #2 *', '© 2026 ™', 'Hütte, 日本語', '']) {
      expect(emojiParts(text), text).toEqual([])
    }
  })
})

describe('isJumboEmoji', () => {
  it('is true for a few emoji and nothing else', () => {
    expect(isJumboEmoji('🎉')).toBe(true)
    expect(isJumboEmoji('👍🏽 👩‍👩‍👧 🇳🇴')).toBe(true)
  })

  it('is false with any words, with many emoji, or when empty', () => {
    expect(isJumboEmoji('ok 👍')).toBe(false)
    expect(isJumboEmoji('🎉'.repeat(7))).toBe(false)
    expect(isJumboEmoji('')).toBe(false)
    expect(isJumboEmoji('hello')).toBe(false)
  })
})
