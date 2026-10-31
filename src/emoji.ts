// Finds emoji in message text so they can be shown a little larger.
const TONE = '[\\u{1F3FB}-\\u{1F3FF}]?'
// Characters shown as emoji by default, or made emoji by a variation selector (so plain © and ™ stay text).
// The flags of England, Scotland and Wales are a black flag followed by invisible tag characters.
const TAGS = '(?:[\\u{E0020}-\\u{E007E}]+\\u{E007F})?'
const START = `(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)${TONE}${TAGS}`
const JOINED = `\\u200D\\p{Extended_Pictographic}\\uFE0F?${TONE}`
const FLAG = '[\\u{1F1E6}-\\u{1F1FF}]{2}'
const KEYCAP = '[#*0-9]\\uFE0F\\u20E3'

/**
 * The app's own emoji, the snerds: drawings of the snrdlr bird (src/snerds/), written in a message as a
 * code such as ":snerd-nap:". Every copy of the app draws them; one that predates a snerd shows its code,
 * which still reads. They were ":bird-nap:" and so on for their first day, and those are drawn too.
 */
export const SNERDS: [name: string, words: string][] = [
  ['puzzled', 'question confused huh'],
  ['surprised', 'wow shock exclaim'],
  ['foot-up', 'lift leg step stand'],
  ['look-left', 'stare see'],
  ['look-right', 'stare see'],
  ['look-up', 'stare see sky'],
  ['look-down', 'stare see ground'],
  ['look-at-you', 'stare see front face'],
  ['nap', 'sleep tired zzz']
]
const SNERD = `:(?:snerd|bird)-(?:${SNERDS.map(([name]) => name).join('|')}):`
const SNERD_ALONE = new RegExp(`^${SNERD}$`)
// A snerd stands alone, so it can be drawn; other emoji next to each other are found as one run.
const EMOJI = new RegExp(`${SNERD}|(?:${FLAG}|${KEYCAP}|${START}(?:${JOINED})*)+`, 'gu')

/** Whether the text is one of the snerds. */
export const isSnerd = (text: string) => SNERD_ALONE.test(text)

/** Which snerd a code is ("nap" for ":snerd-nap:"), or null for anything else. */
export const snerdName = (text: string) => (isSnerd(text) ? text.slice(text.indexOf('-') + 1, -1) : null)

/** The code a snerd is written with. */
export const snerdCode = (name: string) => `:snerd-${name}:`

/**
 * The start of a snerd's code being typed just before the cursor: a colon, at the start or after a space,
 * then at least one letter ("see you :na"). Null if there is none.
 */
export function typedCode(text: string, cursor: number): {start: number; query: string} | null {
  const found = /(?:^|\s):([a-z][a-z-]*)$/i.exec(text.slice(0, cursor))
  return found ? {start: cursor - found[1].length - 1, query: found[1].toLowerCase()} : null
}

/** The snerds whose name or everyday words have every part of what was typed in them ("na" finds the nap). */
export function snerdsFor(query: string): string[] {
  const parts = query.split('-').filter(Boolean)
  return SNERDS.filter(([name, words]) => {
    const searched = `snerd bird snrdlr ${name.replace(/-/g, ' ')} ${words}`
    return parts.every(part => searched.includes(part))
  }).map(([name]) => snerdCode(name))
}

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
  // A snerd's code is one emoji, however many letters it is written with.
  const counted = text.replace(/\s/g, '').replace(new RegExp(SNERD, 'g'), '🐦')
  return [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(counted)].length
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
  if (!found) return null
  return isSnerd(found.text) ? found.text : graphemes(found.text)[0]
}
