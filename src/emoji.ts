// Finds emoji in message text so they can be shown a little larger.
const TONE = '[\\u{1F3FB}-\\u{1F3FF}]?'
// Characters shown as emoji by default, or made emoji by a variation selector (so plain © and ™ stay text).
// The flags of England, Scotland and Wales are a black flag followed by invisible tag characters.
const TAGS = '(?:[\\u{E0020}-\\u{E007E}]+\\u{E007F})?'
const START = `(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)${TONE}${TAGS}`
const JOINED = `\\u200D\\p{Extended_Pictographic}\\uFE0F?${TONE}`
const FLAG = '[\\u{1F1E6}-\\u{1F1FF}]{2}'
const KEYCAP = '[#*0-9]\\uFE0F\\u20E3'
const EMOJI = new RegExp(`(?:${FLAG}|${KEYCAP}|${START}(?:${JOINED})*)+`, 'gu')

const MAX_JUMBO_EMOJI = 6

export type Segment = {text: string; emoji: boolean}

export function splitEmoji(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(EMOJI)) {
    if (match.index > last) segments.push({text: text.slice(last, match.index), emoji: false})
    segments.push({text: match[0], emoji: true})
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({text: text.slice(last), emoji: false})
  return segments
}

/** How many emoji a message consists of, if it is nothing but emoji; otherwise 0. */
export function emojiOnlyCount(text: string): number {
  const segments = splitEmoji(text)
  if (segments.length === 0 || segments.some(segment => !segment.emoji && segment.text.trim() !== '')) return 0
  return [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text.replace(/\s/g, ''))].length
}

/** The extra size class for an emoji-only message: one emoji is largest, a few are large, many are normal. */
export function emojiSize(text: string): 'solo' | 'jumbo' | null {
  const count = emojiOnlyCount(text)
  if (count === 1) return 'solo'
  return count > 1 && count <= MAX_JUMBO_EMOJI ? 'jumbo' : null
}

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)].map(part => part.segment)

/** Whether the text is exactly one emoji, as a reaction must be. */
export function isSingleEmoji(text: string): boolean {
  return text.length <= 40 && !/\s/.test(text) && emojiOnlyCount(text) === 1
}

/** The first emoji in what someone typed, if there is one. */
export function firstEmoji(text: string): string | null {
  const found = splitEmoji(text).find(segment => segment.emoji)
  return found ? graphemes(found.text)[0] : null
}
