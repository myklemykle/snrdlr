// Writes src/emoji-data.json, the list the emoji picker shows, from the unicode-emoji-json package, with
// everyday search words from Unicode's CLDR annotations (via emojibase-data).
// Run after upgrading either package: node scripts/build-emoji-data.mjs
import {readFileSync, writeFileSync} from 'node:fs'

const read = path => JSON.parse(readFileSync(new URL(`../node_modules/${path}`, import.meta.url), 'utf8'))
const groups = read('unicode-emoji-json/data-by-group.json')
// The two packages differ on where a variation selector goes, so emoji are matched without one.
const bare = emoji => emoji.replace(/\uFE0F/g, '')
const tags = new Map(read('emojibase-data/en/data.json').map(entry => [bare(entry.emoji), entry.tags ?? []]))
// Each emoji as [emoji, name, the Emoji version that introduced it, search words], so the picker can
// leave out those the device cannot draw, and find 😂 by "haha" as well as by its name. Words already
// in the name are left out.
const wordsFor = (emoji, name) => {
  const named = name.toLowerCase()
  return [...new Set((tags.get(bare(emoji)) ?? []).map(tag => tag.toLowerCase()))].filter(tag => !named.includes(tag)).join(' ')
}
const data = groups.map(group => [
  group.name,
  group.emojis.map(entry => [entry.emoji, entry.name, Number(entry.emoji_version), wordsFor(entry.emoji, entry.name)])
])
writeFileSync(new URL('../src/emoji-data.json', import.meta.url), JSON.stringify(data) + '\n')
console.log(`${data.reduce((sum, [, emojis]) => sum + emojis.length, 0)} emoji in ${data.length} groups`)
