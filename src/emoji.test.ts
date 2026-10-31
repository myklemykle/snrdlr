import {describe, expect, it} from 'vitest'
import {emojiSize, firstEmoji, isSingleEmoji, isSnerd, snerdCode, snerdName, SNERDS, snerdsFor, splitEmoji, typedCode} from './emoji'

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

describe('isSingleEmoji', () => {
  it('accepts exactly one emoji, however it is built', () => {
    for (const emoji of ['👍', '❤️', '👍🏽', '👨‍👩‍👧', '🇳🇴', '1️⃣']) expect(isSingleEmoji(emoji), emoji).toBe(true)
  })

  it('refuses text, several emoji, padding, and nothing', () => {
    for (const text of ['', 'a', 'ok👍', '👍👍', ' 👍', '👍 ', '©']) expect(isSingleEmoji(text), JSON.stringify(text)).toBe(false)
  })
})

describe('firstEmoji', () => {
  it('finds the first emoji in what was typed', () => {
    expect(firstEmoji('🎉')).toBe('🎉')
    expect(firstEmoji('🎉🔥')).toBe('🎉')
    expect(firstEmoji('ok 👍🏽 then')).toBe('👍🏽')
    expect(firstEmoji('👨‍👩‍👧!')).toBe('👨‍👩‍👧')
    expect(firstEmoji('no emoji')).toBeNull()
  })
})

describe('the snerds', () => {
  it('are found by their codes, each on its own, beside words and other emoji', () => {
    expect(splitEmoji('hi :snerd-nap:🎉:snerd-look-up:!')).toEqual([
      {text: 'hi ', emoji: false},
      {text: ':snerd-nap:', emoji: true},
      {text: '🎉', emoji: true},
      {text: ':snerd-look-up:', emoji: true},
      {text: '!', emoji: false}
    ])
    // A code for a snerd there is no drawing of is only text.
    expect(emojiParts('a :snerd-flying: b :nap:')).toEqual([])
  })

  it('count as one emoji each', () => {
    expect(isSingleEmoji(':snerd-look-at-you:')).toBe(true)
    expect(emojiSize(':snerd-puzzled:')).toBe('solo')
    expect(emojiSize(':snerd-puzzled: :snerd-nap: 👍')).toBe('jumbo')
    expect(firstEmoji('so :snerd-surprised: then')).toBe(':snerd-surprised:')
  })

  it('still know the codes of their first day, when they were birds', () => {
    expect(isSnerd(':bird-nap:')).toBe(true)
    expect(snerdName(':bird-look-at-you:')).toBe('look-at-you')
    expect(snerdName(':snerd-look-at-you:')).toBe('look-at-you')
    expect(snerdName('🎉')).toBeNull()
  })

  it('each have a drawing', async () => {
    const {readdirSync} = await import('node:fs')
    const drawn = readdirSync(new URL('./snerds/', import.meta.url)).map(file => file.replace(/\.svg$/, ''))
    expect(drawn.sort()).toEqual(SNERDS.map(([name]) => name).sort())
    for (const name of drawn) expect(isSnerd(snerdCode(name))).toBe(true)
  })

  it('are offered as their code is typed: a colon after a space or at the start, then a letter or more', () => {
    expect(typedCode('see you :na', 11)).toEqual({start: 8, query: 'na'})
    expect(typedCode(':PUZ', 4)).toEqual({start: 0, query: 'puz'})
    expect(typedCode(':na then', 3)).toEqual({start: 0, query: 'na'})
    for (const [text, cursor] of [['note:na', 7], ['see :', 5], ['ok :)', 5], ['time: 10', 8], [':na ', 4]] as const)
      expect(typedCode(text, cursor), text).toBeNull()
    expect(snerdsFor('na')).toEqual([':snerd-nap:'])
    expect(snerdsFor('sn')).toHaveLength(SNERDS.length)
    expect(snerdsFor('look-up')).toEqual([':snerd-look-up:'])
    expect(snerdsFor('zebra')).toEqual([])
  })
})
