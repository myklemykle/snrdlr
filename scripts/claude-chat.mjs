// Lets Claude (or any script) be someone on snrdlr: a real browser, run without a window, with its own
// saved profile, using the live app the way a person does. Its messages go through the same relay and
// wake people's devices the same way.
//
//   node scripts/claude-chat.mjs join '<invite link>'       joins a chat, as "Claude" the first time
//   node scripts/claude-chat.mjs say [--chat <name>] [--picture <file>] <text>
//                                                           writes in a chat (the only one, or by name),
//                                                           with a picture if given (the text is its caption)
//   node scripts/claude-chat.mjs listen [--chat <name>]      stays in a direct chat: prints each new message
//                                                           from the other person as a line of JSON, and
//                                                           sends what `say` hands it meanwhile
//   node scripts/claude-chat.mjs listen --group --chat <name>
//                                                           the same in a group, printing everyone's messages
//                                                           but its own, each with who wrote it
//   node scripts/claude-chat.mjs name <new name>            changes the name it goes by, in every chat
//   node scripts/claude-chat.mjs chats                      lists its chats
//
// `listen` prints {"at", "text", "pictures": [paths], "edited"?, "replyTo"?} for each message, saving
// pictures in .claude-chat/inbox/. It only passes on messages from the other member of a direct chat,
// which nobody else can join: its keys come from the two people's own. While it runs, `say` gives it
// the message to send through .claude-chat/outbox/, since two copies of the browser cannot share one
// profile.
//
// In a group (--group), anyone a member lets in can write, so each line also says who wrote it:
// "from" (the name they go by, which anyone can choose) and "author" (the start of their id, made from
// the key that signs their messages, which nobody else can use). Only "author" tells people apart.
// Run it with its own SNRDLR_PROFILE, as a separate someone, in a session that can change nothing.
//
// The profile is kept in .claude-chat/ (not in git), or SNRDLR_PROFILE. SNRDLR_URL picks another copy of the site.
import {ed25519} from '@noble/curves/ed25519.js'
import {sha256} from '@noble/hashes/sha2.js'
import {chromium} from '@playwright/test'
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const SITE = process.env.SNRDLR_URL ?? 'https://alpha.snrdlr.net/'
const PROFILE = process.env.SNRDLR_PROFILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-chat')
const NAME = process.env.SNRDLR_NAME ?? 'Claude'
const MAX_TEXT_LENGTH = 4000
const OUTBOX = join(PROFILE, 'outbox')
const INBOX = join(PROFILE, 'inbox')
const LISTENING = join(PROFILE, 'listen.json')
// How many rounds (about 1.5 s each) to wait for a picture's file to arrive from another device.
const PICTURE_ROUNDS = 200

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function open() {
  // bypassCSP: the database helper below builds its work from text, which a page's policy may forbid.
  const context = await chromium.launchPersistentContext(PROFILE, {headless: true, bypassCSP: true})
  const page = context.pages()[0] ?? (await context.newPage())
  return {context, page}
}

/** Names of the chats on the front page, once it is showing. */
async function chatNames(page) {
  for (let attempt = 0; ; attempt++) {
    try {
      // The app can navigate by itself as it loads (opening a chat, updating), which interrupts this.
      await page.goto(SITE)
      const greeting = page.locator('.greeting')
      const aside = page.getByRole('button', {name: 'Use it here'})
      await Promise.race([greeting.waitFor({timeout: 30_000}), aside.waitFor({timeout: 30_000})])
      // This browser's tab had stepped aside for another (one-tab.ts); this is the one now.
      if (await aside.isVisible()) {
        await aside.click()
        await greeting.waitFor({timeout: 30_000})
      }
      return await page.locator('.chats .open .name').allTextContents()
    } catch (error) {
      if (attempt >= 2) throw error
      await sleep(2000)
    }
  }
}

/** Which chat is meant: the one named, or the only one. */
function pick(names, wanted) {
  const name = wanted ?? (names.length === 1 ? names[0] : null)
  if (!name || !names.includes(name)) throw new Error(`Say which chat with --chat. Chats: ${names.join(', ') || 'none'}`)
  return name
}

/** Opens a chat from the front page. */
async function openChat(page, name) {
  await page.locator('.chats .open').filter({has: page.locator('.name').getByText(name, {exact: true})}).click()
  await page.getByLabel('Message').waitFor({timeout: 30_000})
}

/** Runs `work` in the page with the app's database open, and closes it after. */
const withDb = (page, work, arg) =>
  page.evaluate(
    ([source, arg]) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('snrdlr')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const get = (store, query, index) =>
            new Promise((done, fail) => {
              const tx = db.transaction(store).objectStore(store)
              const all = index ? tx.index(index).getAll(query) : query === undefined ? tx.getAll() : tx.get(query)
              all.onsuccess = () => done(all.result)
              all.onerror = () => fail(all.error)
            })
          // eslint-disable-next-line no-new-func
          Promise.resolve(new Function('get', 'arg', `return (${source})(get, arg)`)(get, arg))
            .then(resolve, reject)
            .finally(() => db.close())
        }
      }),
    [work.toString(), arg]
  )

/** How far this device's messages in a chat are known to be with the relay. */
const storedSeq = (page, name) => withDb(page, async (get, name) => (await get('chats')).find(chat => chat.name === name)?.storedSeq ?? 0, name)

/** Splits a long message at paragraph or line breaks, so each part fits in one message. */
function parts(text) {
  const out = []
  let rest = text
  while (rest.length > MAX_TEXT_LENGTH) {
    const window = rest.slice(0, MAX_TEXT_LENGTH)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const at = cut > MAX_TEXT_LENGTH / 2 ? cut : MAX_TEXT_LENGTH
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

/** Writes in the chat open on the page, and waits until the relay holds it. A picture goes with the first part. */
async function send(page, name, text, picture) {
  for (const [index, part] of (parts(text).length ? parts(text) : ['']).entries()) {
    const before = await storedSeq(page, name)
    if (picture && index === 0) {
      await page.getByLabel('Pictures to add').setInputFiles(picture)
      await page.locator('.attached').waitFor({timeout: 30_000})
    }
    await page.getByLabel('Message').fill(part)
    await page.getByRole('button', {name: 'Send'}).click()
    // Done once the relay holds it, so that whoever is away gets it and is woken for it.
    const deadline = Date.now() + 60_000
    while ((await storedSeq(page, name)) <= before) {
      if (Date.now() > deadline) throw new Error('Sent, but the relay did not confirm keeping it within a minute.')
      await sleep(500)
    }
  }
}

/** Changes the name in the profile, from the front page, which leaves the page there. */
async function rename(page, name) {
  if (!name.trim()) throw new Error('No name given.')
  await chatNames(page)
  await page.getByRole('button', {name: 'Your profile'}).click()
  const editor = page.getByRole('dialog', {name: 'Your profile'})
  await editor.getByLabel('Name').fill(name)
  await editor.getByRole('button', {name: 'Save'}).click()
  await page.locator('.greeting').getByText(name, {exact: false}).waitFor({timeout: 30_000})
}

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

/** The process listening, if one is running. */
function listener() {
  try {
    const {pid} = JSON.parse(readFileSync(LISTENING, 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/** Hands work to the listener, which has the profile open, and waits for its answer. */
async function handOver(work) {
  mkdirSync(OUTBOX, {recursive: true})
  const id = `${Date.now()}-${process.pid}`
  writeFileSync(join(OUTBOX, `${id}.tmp`), JSON.stringify(work))
  renameSync(join(OUTBOX, `${id}.tmp`), join(OUTBOX, `${id}.json`))
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    for (const [ending, ok] of [['.sent', true], ['.failed', false]]) {
      const done = join(OUTBOX, id + ending)
      if (!existsSync(done)) continue
      const answer = readFileSync(done, 'utf8')
      rmSync(done)
      if (!ok) throw new Error(answer)
      return console.log(answer)
    }
    await sleep(300)
  }
  throw new Error('The listener did not do it within five minutes.')
}

async function renameAs(name) {
  if (listener()) return handOver({name})
  const {context, page} = await open()
  try {
    await rename(page, name)
    console.log(`Now called "${name}".`)
  } finally {
    await context.close()
  }
}

async function say(text, wanted, picture) {
  if (!text.trim() && !picture) throw new Error('Nothing to say.')
  if (picture && !existsSync(picture)) throw new Error(`No such picture: ${picture}`)
  if (listener()) return handOver({text, chat: wanted, picture})
  const {context, page} = await open()
  try {
    const name = pick(await chatNames(page), wanted)
    await openChat(page, name)
    await send(page, name, text, picture)
    console.log(`Said it in "${name}".`)
  } finally {
    await context.close()
  }
}

/** This profile's own id, as the app makes it from the key that signs its messages. */
async function selfId(page) {
  const secret = await withDb(page, async get => Array.from((await get('identity', 'self')).signSecret))
  return Buffer.from(sha256(ed25519.getPublicKey(Uint8Array.from(secret)))).toString('hex')
}

/**
 * The messages that arrived after `since`, with their pictures' files where held: in a direct chat
 * the other person's, in a group everyone's but our own, with who wrote each.
 */
const newMessages = (page, chatId, since, self) =>
  withDb(
    page,
    async (get, {chatId, since, self}) => {
      const chat = await get('chats', chatId)
      const other = chat.kind === 'dm' ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', chat.peer.signPublic)), byte => byte.toString(16).padStart(2, '0')).join('') : null
      const arrived = await get('messages', IDBKeyRange.bound([chatId, since], [chatId, Infinity], true), 'received')
      const all = arrived.length ? await get('messages', IDBKeyRange.bound([chatId], [chatId, []]), 'order') : []
      const quote = ref => {
        const found = ref && all.find(message => message.author === ref.author && message.device === (ref.device ?? '') && message.seq === ref.seq)
        return found ? (found.content.text ?? found.content.caption ?? '(a picture)') : undefined
      }
      const names = new Map()
      for (const message of all) if (message.content.type === 'profile') names.set(message.author, message.content.name)
      const out = []
      for (const message of arrived) {
        if (other ? message.author !== other : message.author === self) continue
        const {content} = message
        const base = {seq: message.seq, device: message.device, receivedAt: message.receivedAt, at: new Date(message.sentAt).toISOString()}
        if (!other) Object.assign(base, {from: names.get(message.author) ?? '', author: message.author.slice(0, 12)})
        if (content.type === 'text') out.push({...base, text: content.text, replyTo: quote(content.replyTo)})
        else if (content.type === 'edit') {
          const target = all.find(m => m.author === message.author && m.device === content.target.device && m.seq === content.target.seq)
          out.push({...base, text: content.text, edited: target?.content.text ?? target?.content.caption ?? ''})
        } else if (content.type === 'audio') {
          const file = await get('files', [chatId, content.hash])
          let picture = null
          if (file) {
            const key = await crypto.subtle.importKey('raw', content.key, 'AES-GCM', false, ['decrypt'])
            const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: file.data.slice(0, 12)}, key, file.data.slice(12))
            picture = btoa(Array.from(new Uint8Array(plain), byte => String.fromCharCode(byte)).join(''))
          }
          out.push({...base, text: `(a voice message, ${Math.round(content.duration / 1000)} s)`, picture, extension: content.mime === 'audio/mp4' ? 'm4a' : content.mime.split('/')[1], replyTo: quote(content.replyTo)})
        } else if (content.type === 'image') {
          const file = await get('files', [chatId, content.hash])
          let picture = null
          if (file) {
            const key = await crypto.subtle.importKey('raw', content.key, 'AES-GCM', false, ['decrypt'])
            const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: file.data.slice(0, 12)}, key, file.data.slice(12))
            picture = btoa(Array.from(new Uint8Array(plain), byte => String.fromCharCode(byte)).join(''))
          }
          out.push({...base, text: content.caption ?? '', picture, replyTo: quote(content.replyTo)})
        }
      }
      return {messages: out, held: arrived.length ? Math.max(...arrived.map(message => message.receivedAt)) : since}
    },
    {chatId, since, self}
  )

async function listen(wanted, group) {
  if (listener()) throw new Error('Already listening.')
  mkdirSync(OUTBOX, {recursive: true})
  mkdirSync(INBOX, {recursive: true})
  const {context, page} = await open()
  const stop = () => {
    rmSync(LISTENING, {force: true})
    void context.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const name = pick(await chatNames(page), wanted)
    const chat = await withDb(page, async (get, name) => (await get('chats')).find(chat => chat.name === name), name)
    if (chat.kind !== 'dm' && !group) throw new Error(`"${name}" is a group, where anyone a member lets in can write. Listen there only with --group, as its own profile.`)
    if (chat.kind === 'dm' && group) throw new Error(`"${name}" is a direct chat, not a group.`)
    const self = await selfId(page)
    let since = Date.now()
    writeFileSync(LISTENING, JSON.stringify({pid: process.pid, chat: name}))
    await openChat(page, name)
    console.error(`Listening in "${name}".`)
    // A picture whose file has not arrived yet is waited for, a little. What was printed is not again.
    const waiting = new Map()
    const printed = new Set()
    for (;;) {
      try {
        await listenOnce()
      } catch (error) {
        // One bad round (the app reloading under us, a slow network) is not the end of listening.
        console.error(`listen: ${error.message.split('\n')[0]}`)
      }
      await sleep(1500)
    }
    async function listenOnce() {
      // The app may have reloaded itself to update; go back into the chat.
      if (!(await page.getByLabel('Message').isVisible().catch(() => false))) {
        await chatNames(page)
        await openChat(page, name)
      }
      const {messages, held} = await newMessages(page, chat.id, since, self)
      for (const message of messages) {
        const key = `${message.author ?? ''}.${message.device}.${message.seq}`
        if (printed.has(key)) continue
        if (message.picture === null && (waiting.get(key) ?? 0) < PICTURE_ROUNDS) {
          waiting.set(key, (waiting.get(key) ?? 0) + 1)
          continue
        }
        waiting.delete(key)
        printed.add(key)
        const pictures = []
        if (message.picture) {
          const path = join(INBOX, `${message.at.replace(/[:.]/g, '-')}-${message.seq}.${message.extension ?? 'jpg'}`)
          writeFileSync(path, Buffer.from(message.picture, 'base64'))
          pictures.push(path)
        }
        const {at, from, author, text, edited, replyTo} = message
        console.log(JSON.stringify({at, ...(author ? {from, author} : {}), text, pictures, ...(message.picture === null ? {missing: 'a picture that did not arrive'} : {}), ...(edited !== undefined ? {edited} : {}), ...(replyTo ? {replyTo} : {})}))
      }
      // Messages put off until their picture arrives are looked at again from where they started.
      const putOff = messages.filter(message => waiting.has(`${message.author ?? ''}.${message.device}.${message.seq}`)).map(message => message.receivedAt)
      since = putOff.length ? Math.min(...putOff) - 1 : held
      for (const file of readdirSync(OUTBOX).filter(file => file.endsWith('.json')).sort()) {
        const id = file.slice(0, -'.json'.length)
        let reply
        try {
          const {text, chat: other, picture, name: newName} = JSON.parse(readFileSync(join(OUTBOX, file), 'utf8'))
          if (newName !== undefined) {
            // Renaming happens on the front page; the next round goes back into the chat.
            await rename(page, newName)
            reply = [`${id}.sent`, `Now called "${newName}".`]
          } else {
            if (other && other !== name) throw new Error(`Listening in "${name}", not "${other}".`)
            await send(page, name, text, picture)
            reply = [`${id}.sent`, `Said it in "${name}".`]
          }
        } catch (error) {
          reply = [`${id}.failed`, error.message]
        }
        rmSync(join(OUTBOX, file))
        writeFileSync(join(OUTBOX, reply[0]), reply[1])
      }
    }
  } finally {
    rmSync(LISTENING, {force: true})
    await context.close()
  }
}

const [command, ...rest] = process.argv.slice(2)
const option = name => {
  const at = rest.indexOf(name)
  return at >= 0 ? rest.splice(at, 2)[1] : undefined
}
try {
  if (command === 'join' && rest[0]) await joinChat(rest[0])
  else if (command === 'say') {
    const chat = option('--chat')
    const picture = option('--picture')
    await say(rest.join(' '), chat, picture && resolve(picture))
  } else if (command === 'name') await renameAs(rest.join(' '))
  else if (command === 'listen') {
    const group = rest.includes('--group')
    if (group) rest.splice(rest.indexOf('--group'), 1)
    await listen(option('--chat'), group)
  }
  else if (command === 'chats') {
    const {context, page} = await open()
    try {
      console.log((await chatNames(page)).join('\n') || '(none)')
    } finally {
      await context.close()
    }
  } else {
    console.error("Usage: claude-chat.mjs join '<invite link>' | say [--chat <name>] <text> | listen [--group] [--chat <name>] | name <new name> | chats")
    process.exitCode = 2
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
