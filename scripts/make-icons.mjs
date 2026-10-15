// Draws the app's icons from scripts/icon-source.png (a square picture on a flat background), at the
// sizes phones and browsers ask for. Run with `node scripts/make-icons.mjs` after changing the picture;
// the results are committed.
import {readFileSync, writeFileSync} from 'node:fs'
import {chromium} from '@playwright/test'

const source = `data:image/png;base64,${readFileSync(new URL('./icon-source.png', import.meta.url)).toString('base64')}`
// The picture's own background, used to fill around it where it is drawn smaller.
const BACKGROUND = '#c5d300'

// Browsers show the plain icons as they are, so they get rounded corners. "Maskable" icons are cropped
// to whatever shape the phone uses, so the picture sits well inside a full square of the background.
// Apple rounds the corners itself, so its icon is square too. A new picture gets new file names, so that
// installed apps notice it: Chrome compares the manifest's icon addresses when it checks for updates.
const icons = [
  ['favicon.png', 64, {rounded: true}],
  ['bird-192.png', 192, {rounded: true}],
  ['bird-512.png', 512, {rounded: true}],
  ['bird-maskable-512.png', 512, {scale: 0.75}],
  ['apple-touch-icon.png', 180, {}]
]

const browser = await chromium.launch()
const page = await browser.newPage()
for (const [name, size, {rounded = false, scale = 1}] of icons) {
  await page.setViewportSize({width: size, height: size})
  const inset = (size * (1 - scale)) / 2
  await page.setContent(`
    <body style="margin:0">
      <div style="width:${size}px;height:${size}px;overflow:hidden;background:${BACKGROUND};border-radius:${rounded ? (size * 112) / 512 : 0}px">
        <img src="${source}" style="display:block;margin:${inset}px;width:${size * scale}px;height:${size * scale}px">
      </div>
    </body>`)
  await page.locator('img').evaluate(image => image.decode())
  writeFileSync(new URL(`../public/${name}`, import.meta.url), await page.screenshot({omitBackground: true}))
}
await browser.close()
