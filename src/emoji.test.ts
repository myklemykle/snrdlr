import {describe, expect, it} from 'vitest'
import {emojiSize, splitEmoji} from './emoji'

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

describe('emojiSize', () => {
  it('singles out one emoji sent alone, however many parts it is made of', () => {
    for (const text of ['🎉', ' 👍🏽 ', '👩‍👩‍👧', '🇳🇴', '🏳️‍🌈']) expect(emojiSize(text), text).toBe('solo')
  })

  it('is jumbo for a few emoji and nothing else', () => {
    expect(emojiSize('🎉🎉')).toBe('jumbo')
    expect(emojiSize('👍🏽 👩‍👩‍👧 🇳🇴')).toBe('jumbo')
    expect(emojiSize('🎉'.repeat(6))).toBe('jumbo')
  })

  it('is nothing special with any words, with many emoji, or when empty', () => {
    for (const text of ['ok 👍', '🎉'.repeat(7), '', 'hello', '   ']) expect(emojiSize(text), text).toBeNull()
  })
})
