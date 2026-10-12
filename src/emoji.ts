// Finds emoji in message text so they can be shown a little larger.
const TONE = '[\\u{1F3FB}-\\u{1F3FF}]?'
// Characters shown as emoji by default, or made emoji by a variation selector (so plain © and ™ stay text).
const START = `(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)${TONE}`
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

/** True for a message that is nothing but a few emoji, which is shown larger still. */
export function isJumboEmoji(text: string): boolean {
  const segments = splitEmoji(text)
  if (segments.length === 0 || segments.some(segment => !segment.emoji && segment.text.trim() !== '')) return false
  const count = [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text.replace(/\s/g, ''))].length
  return count <= MAX_JUMBO_EMOJI
}
