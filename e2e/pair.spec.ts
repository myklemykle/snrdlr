import {expect, test, type Browser, type Page} from '@playwright/test'

/** A separate browser profile, so each person has their own storage and identity. */
async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']})
  return context.newPage()
}

async function introduce(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', {name: 'Continue'}).click()
}

/** A chat's row on the home screen. */
const chatEntry = (page: Page, name: string) => page.locator('.chats .open', {hasText: name})

async function send(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', {name: 'Send'}).click()
}

test('two people pair by invite, chat, and keep their history across reloads', async ({browser}) => {
  const anne = await newPerson(browser)
  const bob = await newPerson(browser)

  await anne.goto('/')
  await introduce(anne, 'Anne')
  await anne.getByLabel('Chat name').fill('Test chat')
  await anne.getByRole('button', {name: 'Start a chat'}).click()
  await expect(anne.getByRole('img', {name: 'Invite code for this chat'})).toBeVisible()

  // Stands in for scanning the QR code, which encodes this same link.
  await anne.getByRole('button', {name: 'Copy invite link'}).click()
  const invite = await anne.evaluate(() => navigator.clipboard.readText())
  expect(invite).toContain('#i=')

  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(bob.getByRole('heading', {name: 'Test chat'})).toBeVisible()

  // Once a chat is stored, its secret must not linger in either address bar.
  expect(anne.url()).not.toContain('#i=')
  expect(bob.url()).not.toContain('#i=')

  // Two profiles on one machine connect without leaving it; the exact label depends on the browser.
  await expect(anne.locator('.status')).toHaveText(/Connected to 1 · (local network|direct)/, {timeout: 30_000})
  await expect(bob.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})

  await send(anne, 'hello from anne')
  await expect(bob.locator('.theirs', {hasText: 'hello from anne'})).toContainText('Anne')
  await send(bob, 'hello from bob')
  await expect(anne.locator('.theirs', {hasText: 'hello from bob'})).toContainText('Bob')
  await expect(anne.getByText('Bob joined')).toBeVisible()

  await anne.reload()
  await bob.reload()
  for (const page of [anne, bob]) {
    await expect(page.getByText('hello from anne')).toBeVisible()
    await expect(page.getByText('hello from bob')).toBeVisible()
  }

  // After a reload both reconnect and carry on in the same log.
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await send(anne, 'still here')
  await expect(bob.locator('.theirs', {hasText: 'still here'})).toBeVisible()
  await expect(bob.locator('.log li:not(.event)')).toHaveText([/^Annehello from anne/, /^hello from bob/, /^Annestill here/])

  // The chat is listed on the home screen and reopens with its history.
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await chatEntry(anne, 'Test chat').click()
  await expect(anne.locator('.mine', {hasText: 'still here'})).toBeVisible()
})

test('messages written while the other person is away arrive when they return', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Catch up')

  // Written before anyone else has joined.
  await send(anne, 'first one here')

  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(bob.locator('.theirs', {hasText: 'first one here'})).toContainText('Anne')

  // Bob leaves the chat; Anne keeps writing; Bob also writes on his own from the chat screen later.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(anne.locator('.status')).toHaveText(/Nobody else is here/, {timeout: 15_000})
  await send(anne, 'while you were out')
  await send(anne, 'and another')

  await chatEntry(bob, 'Catch up').click()
  await expect(bob.locator('.theirs', {hasText: 'while you were out'})).toBeVisible({timeout: 15_000})
  await expect(bob.locator('.theirs', {hasText: 'and another'})).toBeVisible()
  await expect(bob.locator('.log li:not(.event)')).toHaveText([/^Annefirst one here/, /^Annewhile you were out/, /^Anneand another/])
})

/** Starts a chat as a new person and returns the live invite link, which the QR code also encodes. */
async function startChat(page: Page, name: string, chatName: string): Promise<string> {
  await page.goto('/')
  await introduce(page, name)
  await page.getByLabel('Chat name').fill(chatName)
  await page.getByRole('button', {name: 'Start a chat'}).click()
  return copyInvite(page)
}

async function copyInvite(page: Page): Promise<string> {
  await page.getByRole('button', {name: 'Copy invite link'}).click()
  return page.evaluate(() => navigator.clipboard.readText())
}

const STALE = 'That invite is no longer active.'

test('several people can join through one code while it is showing', async ({browser}) => {
  const [anne, bob, cindy] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Group')

  await Promise.all([bob.goto(invite), cindy.goto(invite)])
  await Promise.all([introduce(bob, 'Bob'), introduce(cindy, 'Cindy')])

  await expect(anne.locator('.status')).toHaveText(/Connected to 2/, {timeout: 30_000})
  await expect(anne.getByRole('img', {name: 'Invite code for this chat'})).toBeVisible()
  await send(cindy, 'hi all')
  await expect(anne.locator('.theirs', {hasText: 'hi all'})).toContainText('Cindy')
  await expect(bob.locator('.theirs', {hasText: 'hi all'})).toContainText('Cindy')

  // Everyone can see who started the chat and who let each person in.
  await expect(anne.getByText('Bob joined · invited by you')).toBeVisible()
  await expect(cindy.getByText('Bob joined · invited by Anne')).toBeVisible()
  await expect(bob.getByText('Anne started this chat')).toBeVisible()
})

test('someone holding a copy of the chat secret, but never invited, is kept out', async ({browser}) => {
  const [anne, bob, mallory] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Members only')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await anne.getByRole('button', {name: 'Stop inviting'}).click()
  await send(anne, 'for members')
  await expect(bob.locator('.theirs', {hasText: 'for members'})).toBeVisible()

  // Mallory has her own identity, and a copy of everything Bob's device stores about the chat:
  // its secret, its founder, and Bob's certificates.
  await mallory.goto('/')
  await introduce(mallory, 'Mallory')
  const stolen = await bob.evaluate(
    () =>
      new Promise<unknown[]>(resolve => {
        const open = indexedDB.open('snrdlr')
        open.onsuccess = () => {
          const all = open.result.transaction('chats').objectStore('chats').getAll()
          all.onsuccess = () =>
            resolve(
              all.result.map(chat => ({...chat, secret: [...chat.secret], context: [...chat.context], chain: chat.chain.map((cert: Uint8Array) => [...cert])}))
            )
        }
      })
  )
  await mallory.evaluate(
    chats =>
      new Promise<void>(resolve => {
        const open = indexedDB.open('snrdlr')
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite')
          for (const chat of chats as {secret: number[]; context: number[]; chain: number[][]}[]) {
            tx.objectStore('chats').put({
              ...chat,
              secret: new Uint8Array(chat.secret),
              context: new Uint8Array(chat.context),
              chain: chat.chain.map(cert => new Uint8Array(cert))
            })
          }
          tx.oncomplete = () => resolve()
        }
      }),
    stolen
  )
  await mallory.reload()
  await chatEntry(mallory, 'Members only').click()
  await expect(mallory.getByRole('heading', {name: 'Members only'})).toBeVisible()

  // She reaches the room and can tell the members are genuine, but neither of them accepts her:
  // they do not count her as connected, and send her neither the history nor anything new.
  await send(anne, 'still just us')
  await expect(bob.locator('.theirs', {hasText: 'still just us'})).toBeVisible()
  await mallory.waitForTimeout(12_000)
  await expect(mallory.locator('.theirs')).toHaveCount(0)
  await expect(mallory.locator('.log .event:not(.day)')).toHaveCount(0)
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1 /)
  await expect(bob.locator('.status.on')).toHaveText(/Connected to 1 /)
  // And nothing she writes gets in.
  await send(mallory, 'let me in')
  await mallory.waitForTimeout(2_000)
  await expect(anne.getByText('let me in')).toHaveCount(0)
})

test('a code stops working once the inviter closes it, and a new showing gets a new code', async ({browser}) => {
  const [anne, bob, dave] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]
  const firstInvite = await startChat(anne, 'Anne', 'Private')

  await anne.getByRole('button', {name: 'Stop inviting'}).click()
  await expect(anne.getByRole('img', {name: 'Invite code for this chat'})).toBeHidden()

  await dave.goto(firstInvite)
  await introduce(dave, 'Dave')
  await expect(dave.getByText(STALE)).toBeVisible({timeout: 15_000})
  await expect(chatEntry(dave, 'Private')).toHaveCount(0)
  expect(dave.url()).not.toContain('#i=')

  await anne.getByRole('button', {name: 'Invite', exact: true}).click()
  const secondInvite = await copyInvite(anne)
  expect(secondInvite).not.toBe(firstInvite)

  // The old code stays dead even though the inviter is inviting again.
  await dave.goto(firstInvite)
  await expect(dave.getByText(STALE)).toBeVisible({timeout: 15_000})

  await bob.goto(secondInvite)
  await introduce(bob, 'Bob')
  await expect(bob.getByRole('heading', {name: 'Private'})).toBeVisible()
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
})

test('chats get distinct names, show in the page title, and can be left', async ({browser}) => {
  const page = await newPerson(browser)
  await page.goto('/')
  await introduce(page, 'Anne')
  await expect(page).toHaveTitle('snrdlr')

  for (const expected of ['Chat', 'Chat 2']) {
    await page.getByRole('button', {name: 'Start a chat'}).click()
    await expect(page.getByRole('heading', {name: expected, exact: true})).toBeVisible()
    await expect(page).toHaveTitle(`${expected} · snrdlr`)
    await page.getByRole('button', {name: 'Back to chats'}).click()
  }
  await expect(page).toHaveTitle('snrdlr')
  await expect(page.locator('.chats .open')).toHaveText(['Chat 2', 'Chat'])

  // Leaving asks first, and cancelling keeps the chat.
  await page.getByRole('button', {name: 'Leave Chat 2'}).click()
  await page.getByRole('button', {name: 'Cancel'}).click()
  await expect(page.locator('.chats .open')).toHaveCount(2)

  await page.getByRole('button', {name: 'Leave Chat 2'}).click()
  await page.getByRole('button', {name: 'Leave chat', exact: true}).click()
  // The confirmation row goes away once the chat has actually been deleted.
  await expect(page.locator('.chats .confirm')).toHaveCount(0)
  await expect(page.locator('.chats .open')).toHaveText(['Chat'])
  await page.reload()
  await expect(page.locator('.chats .open')).toHaveText(['Chat'])
})

test('the header shows connection progress, and emoji are shown larger', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Party')
  await expect(anne.locator('.status.busy')).toHaveText('Looking for others…')

  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1/, {timeout: 30_000})

  await send(anne, '🎉')
  await send(anne, '🏕️🔥')
  await send(anne, 'see you there 👍🏽')
  await expect(bob.locator('.theirs.solo .emoji')).toHaveText('🎉')
  await expect(bob.locator('.theirs.jumbo .emoji')).toHaveText('🏕️🔥')
  const fontSize = (selector: string) => bob.locator(selector).evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  expect(await fontSize('.solo .emoji')).toBeGreaterThan(await fontSize('.jumbo .emoji'))
  const mixed = bob.locator('.theirs:not(.jumbo)', {hasText: 'see you there'})
  await expect(mixed.locator('.emoji')).toHaveText('👍🏽')
  await expect(mixed).toContainText('see you there 👍🏽')

  // Alone again: after a moment of looking, the header settles on saying so.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(anne.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 15_000})
})

test('chats that are not open catch up at launch and show how much is unread', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Updates')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1/, {timeout: 30_000})

  // Bob goes to his chat list, and Anne writes while he is not in the chat.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(anne.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 15_000})
  await send(anne, 'one')
  await send(anne, 'two')

  // Opening the app again syncs the chat in the background, without Bob opening it.
  await bob.reload()
  await expect(chatEntry(bob, 'Updates').getByLabel('2 unread')).toBeVisible({timeout: 20_000})

  await chatEntry(bob, 'Updates').click()
  await expect(bob.locator('.theirs', {hasText: 'two'})).toBeVisible()
  await expect(bob.locator('.log .day')).toHaveText('Today')
  await expect(bob.locator('.theirs', {hasText: 'two'}).locator('time')).toHaveText(/\d{1,2}[:.]\d{2}/)
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1/, {timeout: 30_000})

  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(chatEntry(bob, 'Updates')).toBeVisible()
  await expect(bob.locator('.unread')).toHaveCount(0)
})

test('a malformed or old-format invite link lands on the home screen with an explanation', async ({browser}) => {
  const page = await newPerson(browser)
  await page.goto('/#i=not-a-real-invite')
  await introduce(page, 'Cindy')
  await expect(page.getByText(STALE)).toBeVisible()
})
