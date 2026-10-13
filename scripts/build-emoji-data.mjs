// Writes src/emoji-data.json, the list the emoji picker shows, from the unicode-emoji-json package.
// Run after upgrading that package: node scripts/build-emoji-data.mjs
import {readFileSync, writeFileSync} from 'node:fs'

const groups = JSON.parse(readFileSync(new URL('../node_modules/unicode-emoji-json/data-by-group.json', import.meta.url), 'utf8'))
// Each emoji as [emoji, name, the Emoji version that introduced it], so the picker can leave out
// those the device cannot draw.
const data = groups.map(group => [group.name, group.emojis.map(entry => [entry.emoji, entry.name, Number(entry.emoji_version)])])
writeFileSync(new URL('../src/emoji-data.json', import.meta.url), JSON.stringify(data) + '\n')
console.log(`${data.reduce((sum, [, emojis]) => sum + emojis.length, 0)} emoji in ${data.length} groups`)
