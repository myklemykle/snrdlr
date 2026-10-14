// Draws the app's icons from public/icon.svg, at the sizes phones and browsers ask for.
// Run with `node scripts/make-icons.mjs` after changing the drawing; the results are committed.
import {readFileSync, writeFileSync} from 'node:fs'
import {chromium} from '@playwright/test'

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8')
// "Maskable" icons are cropped to whatever shape the phone uses, so the drawing sits well inside a
// full square of the background colour. Apple rounds the corners itself, so its icon is square too.
const square = svg.replace(/<rect width="512" height="512" rx="112"/, '<rect width="512" height="512"')
const padded = square.replace(/(<rect width="512" height="512"[^>]*>)([\s\S]*)<\/svg>/, '$1<g transform="translate(64 64) scale(.75)">$2</g></svg>')

const browser = await chromium.launch()
const page = await browser.newPage()
for (const [name, size, drawing] of [
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['icon-maskable-512.png', 512, padded],
  ['apple-touch-icon.png', 180, square]
]) {
  await page.setViewportSize({width: size, height: size})
  await page.setContent(`<body style="margin:0">${drawing.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
  writeFileSync(new URL(`../public/${name}`, import.meta.url), await page.screenshot({omitBackground: true}))
}
await browser.close()
