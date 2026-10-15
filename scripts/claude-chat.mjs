// Lets Claude (or any script) be someone on snrdlr: a real browser, run without a window, with its own
// saved profile, using the live app the way a person does. Its messages go through the same relay and
// wake people's devices the same way.
//
//   node scripts/claude-chat.mjs join '<invite link>'      joins a chat, as "Claude" the first time
//   node scripts/claude-chat.mjs say [--chat <name>] <text> writes in a chat (the only one, or by name)
//   node scripts/claude-chat.mjs chats                     lists its chats
//
// The profile is kept in .claude-chat/ (not in git), or SNRDLR_PROFILE. SNRDLR_URL picks another copy of the site.
import {chromium} from '@playwright/test'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const SITE = process.env.SNRDLR_URL ?? 'https://alpha.snrdlr.net/'
const PROFILE = process.env.SNRDLR_PROFILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-chat')
const NAME = process.env.SNRDLR_NAME ?? 'Claude'
const MAX_TEXT_LENGTH = 4000

async function open() {
  const context = await chromium.launchPersistentContext(PROFILE, {headless: true})
  const page = context.pages()[0] ?? (await context.newPage())
  return {context, page}
}

/** Names of the chats on the front page, once it is showing. */
async function chatNames(page) {
  await page.goto(SITE)
  await page.locator('.greeting').waitFor({timeout: 30_000})
  return page.locator('.chats .open .name').allTextContents()
}

/** How far this device's messages in a chat are known to be with the relay. */
const storedSeq = (page, chatName) =>
  page.evaluate(
    name =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('snrdlr')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const all = request.result.transaction('chats').objectStore('chats').getAll()
          all.onsuccess = () => {
            request.result.close()
            resolve(all.result.find(chat => chat.name === name)?.storedSeq ?? 0)
          }
        }
      }),
    chatName
  )

async function joinChat(invite) {
  const {context, page} = await open()
  try {
    await page.goto(invite)
    const named = page.getByLabel('Your name')
    const back = page.getByRole('button', {name: 'Back to chats'})
    await Promise.race([named.waitFor({timeout: 60_000}), back.waitFor({timeout: 60_000})])
    if (await named.isVisible()) {
      await named.fill(NAME)
      await page.getByRole('button', {name: 'Continue'}).click()
    }
    await back.waitFor({timeout: 60_000})
    console.log(`Joined "${(await page.locator('h1').first().textContent())?.trim()}".`)
  } catch (error) {
    const shown = await page.locator('.error').allTextContents().catch(() => [])
    throw new Error(`Could not join. ${shown.join(' ')} ${error.message}`)
  } finally {
    await context.close()
  }
}

async function say(given, wanted) {
  // The app's message box holds one line.
  const text = given.replace(/\s*\n+\s*/g, ' ').trim()
  if (!text.trim()) throw new Error('Nothing to say.')
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`Too long: ${text.length} characters, at most ${MAX_TEXT_LENGTH}.`)
  const {context, page} = await open()
  try {
    const names = await chatNames(page)
    const name = wanted ?? (names.length === 1 ? names[0] : null)
    if (!name || !names.includes(name)) throw new Error(`Say which chat with --chat. Chats: ${names.join(', ') || 'none'}`)
    const before = await storedSeq(page, name)
    await page.locator('.chats .open').filter({has: page.locator('.name').getByText(name, {exact: true})}).click()
    await page.getByLabel('Message').fill(text)
    await page.getByRole('button', {name: 'Send'}).click()
    // Done once the relay holds it, so that whoever is away gets it and is woken for it.
    const deadline = Date.now() + 60_000
    while ((await storedSeq(page, name)) <= before) {
      if (Date.now() > deadline) throw new Error('Sent, but the relay did not confirm keeping it within a minute.')
      await page.waitForTimeout(500)
    }
    console.log(`Said it in "${name}".`)
  } finally {
    await context.close()
  }
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'join' && rest[0]) await joinChat(rest[0])
  else if (command === 'say') {
    const at = rest.indexOf('--chat')
    const chat = at >= 0 ? rest.splice(at, 2)[1] : undefined
    await say(rest.join(' '), chat)
  } else if (command === 'chats') {
    const {context, page} = await open()
    try {
      console.log((await chatNames(page)).join('\n') || '(none)')
    } finally {
      await context.close()
    }
  } else {
    console.error("Usage: claude-chat.mjs join '<invite link>' | say [--chat <name>] <text> | chats")
    process.exitCode = 2
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
