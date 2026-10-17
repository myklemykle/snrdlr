import {expect, test, type Browser, type Page} from '@playwright/test'

/**
 * A separate browser profile, so each person has their own storage and identity. They have been
 * invited before, as anyone who can start a chat must have been.
 */
async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']})
  await context.addInitScript(() => localStorage.getItem('snrdlr.invited') ?? localStorage.setItem('snrdlr.invited', '1'))
  return context.newPage()
}

/** Someone who has never used the app and has not been invited. */
async function newStranger(browser: Browser): Promise<Page> {
  const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']})
  return context.newPage()
}

async function introduce(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', {name: 'Continue'}).click()
}

/** A chat's row on the home screen. */
/** Opens Settings, where joining someone, adding a device and staying connected are, unless it is open already. */
async function openSettings(page: Page) {
  const sheet = page.getByRole('dialog', {name: 'Settings'})
  if ((await sheet.count()) === 0) await page.getByRole('button', {name: 'Settings'}).click()
  return sheet
}
const closeSettings = (page: Page) => page.getByRole('dialog', {name: 'Settings'}).getByRole('button', {name: 'Done'}).click()

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
  await anne.getByRole('button', {name: 'Start a group'}).click()
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
  await page.getByRole('button', {name: 'Start a group'}).click()
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
    await page.getByRole('button', {name: 'Start a group'}).click()
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

test('a message reaches someone who is never online at the same time as its sender, through the relay that keeps it', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Left with the relay')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await send(bob, 'here for a moment')
  await expect(anne.locator('.theirs', {hasText: 'here for a moment'})).toBeVisible()

  // Bob goes. Anne writes, then goes too, before he is back.
  await bob.goto('about:blank')
  await expect(anne.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})
  await send(anne, 'you just missed me')
  await send(anne, 'back tomorrow')
  await expect(anne.locator('.mine', {hasText: 'back tomorrow'})).toBeVisible()
  // Long enough for the relay to have them.
  await anne.waitForTimeout(500)
  await anne.goto('about:blank')

  // Bob returns to an empty room and still gets both, in order; and nothing twice.
  await bob.goto('/')
  await chatEntry(bob, 'Left with the relay').click()
  await expect(bob.locator('.theirs', {hasText: 'back tomorrow'})).toBeVisible({timeout: 15_000})
  await expect(bob.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})
  await expect(bob.locator('.log li:not(.event)')).toHaveText([/here for a moment/, /you just missed me/, /back tomorrow/])
  await send(bob, 'got them')
  await bob.waitForTimeout(500)
  await bob.goto('about:blank')

  // And the same the other way, with the unread count on the front page before the chat is opened.
  await anne.goto('/')
  await expect(chatEntry(anne, 'Left with the relay')).toContainText('1', {timeout: 30_000})
  await chatEntry(anne, 'Left with the relay').click()
  await expect(anne.locator('.theirs', {hasText: 'got them'})).toBeVisible()
})

test('two people start a direct chat from a "chat with me" code, and it cannot be invited into', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await bob.goto('/')
  await introduce(bob, 'Bob')

  await anne.getByRole('button', {name: 'Chat with one person'}).click()
  await expect(anne.getByRole('img', {name: 'Code to chat with me'})).toBeVisible()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  const code = await anne.evaluate(() => navigator.clipboard.readText())

  // Bob lands straight in a chat named after Anne. Anne's code closes by itself and she is in the chat
  // too, named after Bob.
  await bob.goto(code)
  await expect(bob.getByRole('heading', {name: 'Anne'})).toBeVisible({timeout: 15_000})
  await expect(anne.getByRole('heading', {name: 'Bob'})).toBeVisible({timeout: 15_000})
  await expect(anne.getByRole('img', {name: 'Code to chat with me'})).toHaveCount(0)

  // The code is spent: the same link does nothing for someone else afterwards.
  const late = await newPerson(browser)
  await late.goto(code)
  await introduce(late, 'Late')
  await expect(late.getByText('That invite is no longer active')).toBeVisible({timeout: 15_000})

  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await send(anne, 'just us two')
  await expect(bob.locator('.theirs', {hasText: 'just us two'})).toBeVisible()
  await send(bob, 'yes')
  await expect(anne.locator('.theirs', {hasText: 'yes'})).toBeVisible()

  // The other person's profile opens from the top of a direct chat. Bob shows none yet; when he turns
  // his on here, Anne's view of it fills in.
  await anne.getByRole('button', {name: "Bob's profile"}).click()
  const card = anne.getByRole('dialog', {name: "Bob's profile"})
  await expect(card).toContainText("Bob isn't showing a profile in this chat.")
  await bob.evaluate(() => localStorage.setItem('snrdlr.profile', JSON.stringify({color: '#8a56d6', contact: {kind: 'instagram', value: '@bob.b'}, shareAll: false, chats: []})))
  await bob.reload()
  const own = bob.locator('.mine', {hasText: 'yes'})
  await own.hover()
  await own.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: 'Your profile'}).click()
  // First just his colour; his contact stays back until he chooses to show that too.
  const ownCard = bob.getByRole('dialog', {name: 'Your profile'})
  await ownCard.getByLabel('Colour').check()
  await expect(anne.locator('.theirs', {hasText: 'yes'})).toHaveClass(/tinted/)
  await expect(card.getByRole('link')).toHaveCount(0)
  await ownCard.getByLabel('Contact').check()
  await expect(card.getByRole('link', {name: '@bob.b'})).toHaveAttribute('href', 'https://instagram.com/bob.b')
  await ownCard.getByLabel('Contact').uncheck()
  await expect(card.getByRole('link')).toHaveCount(0)
  await expect(anne.locator('.theirs', {hasText: 'yes'})).toHaveClass(/tinted/)
  await ownCard.getByRole('button', {name: 'Done'}).click()
  await card.getByRole('button', {name: 'Done'}).click()

  // No invite button here; pairing again reopens the same chat instead of making another.
  await expect(anne.getByRole('button', {name: 'Invite', exact: true})).toHaveCount(0)
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await bob.getByRole('button', {name: 'Chat with one person'}).click()
  await bob.getByRole('button', {name: 'Copy link'}).click()
  const bobsCode = await bob.evaluate(() => navigator.clipboard.readText())
  await anne.goto(bobsCode)
  await expect(anne.locator('.theirs', {hasText: 'yes'})).toBeVisible({timeout: 15_000})
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await expect(anne.locator('.chats .open')).toHaveCount(1)
  await expect(chatEntry(anne, 'Bob')).toContainText('direct')
  // Bob, who was showing the code this time, is taken to the same chat.
  await expect(bob.locator('.mine', {hasText: 'yes'})).toBeVisible()
})

test('"add someone" in a direct chat starts a new group with both people, and a third joins by code', async ({browser}) => {
  const [anne, bob, cindy] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await bob.goto('/')
  await introduce(bob, 'Bob')
  await anne.getByRole('button', {name: 'Chat with one person'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  await bob.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await expect(bob.getByRole('heading', {name: 'Anne'})).toBeVisible({timeout: 15_000})
  await expect(anne.getByRole('heading', {name: 'Bob'})).toBeVisible({timeout: 15_000})
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await send(anne, 'private note')
  await expect(bob.locator('.theirs', {hasText: 'private note'})).toBeVisible()

  // Anne adds someone: she lands in a new, empty group with its code showing for the newcomer.
  await anne.getByRole('button', {name: 'Add someone'}).click()
  await expect(anne.getByRole('heading', {name: 'Group with Bob'})).toBeVisible()
  await expect(anne.getByRole('img', {name: 'Invite code for this chat'})).toBeVisible()
  const groupCode = await copyInvite(anne)

  // Bob is let in through the direct chat, without scanning anything.
  await bob.getByRole('button', {name: 'Open'}).click()
  await expect(bob.getByRole('heading', {name: 'Group with Bob'})).toBeVisible()
  await cindy.goto(groupCode)
  await introduce(cindy, 'Cindy')
  await expect(cindy.getByRole('heading', {name: 'Group with Bob'})).toBeVisible()
  await expect(anne.locator('.status.on')).toHaveText(/Connected to 2/, {timeout: 30_000})

  await send(cindy, 'hello both')
  await expect(anne.locator('.theirs', {hasText: 'hello both'})).toBeVisible()
  await expect(bob.locator('.theirs', {hasText: 'hello both'})).toBeVisible()
  // Bob was let in through the direct chat, so nothing in the group's log records it except his own
  // "joined" message. Cindy accepts him as a member from the certificate that message carries.
  await send(bob, 'hello cindy')
  await expect(cindy.locator('.theirs', {hasText: 'hello cindy'})).toBeVisible()
  await expect(cindy.getByText('Bob joined · invited by Anne')).toBeVisible()
  // The group starts empty: the direct chat's history stays where it was.
  await expect(cindy.getByText('private note')).toHaveCount(0)
  await expect(bob.getByText('private note')).toHaveCount(0)
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(bob.locator('.chats .open')).toHaveCount(2)
})

test('a computer set to stay connected passes messages between people who are never online together', async ({browser}) => {
  const [anne, bob, kay] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Relay')
  await Promise.all([bob.goto(invite), kay.goto(invite)])
  await Promise.all([introduce(bob, 'Bob'), introduce(kay, 'Kay')])
  await expect(anne.locator('.status')).toHaveText(/Connected to 2/, {timeout: 30_000})

  // Kay's computer is the one that stays on. She is not even looking at the chat.
  await kay.getByRole('button', {name: 'Back to chats'}).click()
  const keeping = kay.locator('.keeping')
  await expect(keeping).toHaveCount(0)
  await openSettings(kay)
  await kay.getByLabel('Keep every chat connected').check()
  await expect(keeping).toHaveText(/Keeping 1 chat connected, with 2 devices online/, {timeout: 30_000})

  // Bob goes offline. Anne writes, then goes offline too.
  await bob.goto('about:blank')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await send(anne, 'for bob, whenever he is back')
  await expect(chatEntry(kay, 'Relay').getByLabel('1 unread')).toBeVisible({timeout: 15_000})
  await anne.goto('about:blank')
  await expect(keeping).toHaveText('Keeping 1 chat connected. Nobody else is online right now.', {timeout: 30_000})

  // Bob returns with Anne gone, and gets her message from Kay's computer.
  await bob.goto('/')
  await chatEntry(bob, 'Relay').click()
  await expect(bob.locator('.theirs', {hasText: 'for bob, whenever he is back'})).toContainText('Anne', {timeout: 30_000})

  // Opening the chat on Kay's computer and leaving it again keeps it connected throughout.
  await closeSettings(kay)
  await chatEntry(kay, 'Relay').click()
  await expect(kay.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await kay.getByRole('button', {name: 'Back to chats'}).click()
  await openSettings(kay)
  await expect(keeping).toHaveText(/Keeping 1 chat connected, with 1 device online/, {timeout: 30_000})

  // A second tab in the same browser takes over, and the first steps aside, holding nothing.
  const second = await kay.context().newPage()
  await second.goto('/')
  await expect(kay.getByText('snrdlr is open in another tab')).toBeVisible({timeout: 15_000})
  await openSettings(second)
  await expect(second.getByLabel('Keep every chat connected')).toBeChecked()
  await expect(second.locator('.keeping')).toHaveText(/Keeping 1 chat connected, with 1 device online/, {timeout: 30_000})
  // The first can take over again, and then the second steps aside.
  await kay.getByRole('button', {name: 'Use it here'}).click()
  await expect(second.getByText('snrdlr is open in another tab')).toBeVisible({timeout: 15_000})
  await expect(kay.locator('.greeting')).toBeVisible()
  await second.getByRole('button', {name: 'Use it here'}).click()
  // The first reloads to step aside; closing it in the middle of that can hang.
  await expect(kay.getByText('snrdlr is open in another tab')).toBeVisible({timeout: 15_000})
  await kay.close()
  await openSettings(second)
  await expect(second.locator('.keeping')).toHaveText(/Keeping 1 chat connected, with 1 device online/, {timeout: 30_000})

  await second.getByLabel('Keep every chat connected').uncheck()
  await expect(second.locator('.keeping')).toHaveCount(0)
  await expect(bob.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})
})

test('people react to a message with an emoji, change it, and take it away', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Reactions')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await send(anne, 'shall we go?')
  const atAnne = anne.locator('.mine', {hasText: 'shall we go?'})
  const atBob = bob.locator('.theirs', {hasText: 'shall we go?'})
  const openMenu = async (bubble: typeof atBob) => {
    await bubble.hover()
    await bubble.getByRole('button', {name: 'React or copy'}).click()
  }

  // Bob picks one of the quick ones; both see it on the message.
  await openMenu(atBob)
  await bob.getByRole('button', {name: 'React 👍'}).click()
  await expect(bob.locator('.menu')).toHaveCount(0)
  await expect(atAnne.getByRole('button', {name: '👍 from Bob'})).toBeVisible()
  await expect(atBob.locator('.reactions .own')).toHaveText('👍')

  // Anne agrees by tapping it, and it shows a count.
  await atAnne.locator('.reactions button').click()
  await expect(atBob.locator('.reactions button')).toHaveText(['👍2'])
  await expect(atBob.getByRole('button', {name: '👍 from you, Anne'})).toBeVisible()

  // Bob changes his to one that is not in the quick row. He has one reaction, not two.
  await openMenu(atBob)
  await expect(bob.locator('.menu .who')).toHaveText('👍 you, Anne')
  await bob.getByRole('button', {name: 'Another emoji'}).click()
  const picker = bob.getByRole('dialog', {name: 'Choose an emoji'})
  await expect(picker.getByRole('button', {name: 'grinning face', exact: true})).toBeVisible()
  // With a keyboard, the search box is ready to type in.
  await expect(picker.getByLabel('Search emoji')).toBeFocused()
  await bob.keyboard.type('party pop')
  await picker.getByRole('button', {name: 'party popper'}).click()
  await expect(picker).toHaveCount(0)
  await expect(atAnne.locator('.reactions button')).toHaveText(['👍', '🎉'])
  await expect(atAnne.locator('.reactions .own')).toHaveText('👍')

  // Tapping his own takes it away.
  await atBob.getByRole('button', {name: '🎉 from you'}).click()
  await expect(atAnne.locator('.reactions button')).toHaveText(['👍'])
  await expect(atBob.locator('.reactions button')).toHaveText(['👍'])

  // A reaction is not a message: no new line, nothing unread, and it survives a reload.
  await expect(bob.locator('.log li:not(.event)')).toHaveCount(1)
  await bob.reload()
  await expect(bob.locator('.theirs', {hasText: 'shall we go?'}).getByRole('button', {name: '👍 from Anne'})).toBeVisible()
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(chatEntry(bob, 'Reactions')).toBeVisible()
  await expect(bob.locator('.unread')).toHaveCount(0)

  // The picker again: jumping to a group, what was used last time, something pasted in, and closing.
  await chatEntry(bob, 'Reactions').click()
  await openMenu(atBob)
  await bob.getByRole('button', {name: 'Another emoji'}).click()
  await expect(picker.getByRole('region', {name: 'Recently used'}).getByRole('button')).toHaveText(['🎉'])
  await picker.getByRole('navigation').getByRole('button', {name: 'Flags'}).click()
  await expect(picker.getByRole('button', {name: 'chequered flag'})).toBeInViewport()
  await picker.getByLabel('Search emoji').fill('zzzz')
  await expect(picker.getByText('No emoji found for "zzzz".')).toBeVisible()
  await picker.getByLabel('Search emoji').fill('🦄')
  await expect(picker.locator('.cells button')).toHaveText(['🦄'])
  await bob.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(atBob.locator('.reactions button')).toHaveText(['👍'])

  // Choosing in the picker what Anne already has leaves it alone, where tapping it on the message removes it.
  await openMenu(atAnne)
  await anne.getByRole('button', {name: 'Another emoji'}).click()
  await anne.getByLabel('Search emoji').fill('thumbs up')
  await anne.getByRole('dialog').getByRole('button', {name: 'thumbs up', exact: true}).click()
  await expect(anne.getByRole('dialog')).toHaveCount(0)
  await expect(atAnne.locator('.reactions .own')).toHaveText('👍')

  // The same menu copies the message's text, and closes when clicked away from.
  await openMenu(atAnne)
  await anne.getByRole('button', {name: 'Copy “shall we go?”'}).click()
  expect(await anne.evaluate(() => navigator.clipboard.readText())).toBe('shall we go?')

  // A long message shows as much as fits, and all of it is copied.
  const long = 'This is the message text, and it goes on for rather longer than any menu could ever be expected to show in full'
  await send(bob, long)
  const longAtAnne = anne.locator('.theirs', {hasText: long})
  await openMenu(longAtAnne)
  const copy = anne.locator('.menu .copy')
  await expect(copy).toHaveText(`Copy “${long}”`)
  await expect(copy).toHaveAccessibleName(`Copy “${long}”`)
  const [menuBox, copyBox, snippet] = [(await anne.locator('.menu').boundingBox())!, (await copy.boundingBox())!, anne.locator('.menu .snippet')]
  expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width)
  expect(await snippet.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await copy.click()
  expect(await anne.evaluate(() => navigator.clipboard.readText())).toBe(long)
  await openMenu(atAnne)
  await anne.waitForTimeout(500)
  await anne.mouse.click(20, 20)
  await expect(anne.locator('.menu')).toHaveCount(0)
})

test('people reply to a message: it is quoted above the answer, and tapping the quote goes to it', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Replies')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await send(anne, 'shall we go?')
  // Enough in between that the first message scrolls out of sight.
  for (let line = 1; line <= 25; line++) await send(anne, `filler ${line}.`)
  const question = bob.locator('.theirs', {hasText: 'shall we go?'})
  await expect(bob.locator('.theirs', {hasText: 'filler 25.'})).toBeVisible()
  await expect(question).not.toBeInViewport()

  // Bob chooses Reply on the first message. It shows above the message box, which is ready for typing.
  await question.scrollIntoViewIfNeeded()
  await question.hover()
  await question.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: 'Reply', exact: true}).click()
  await expect(bob.locator('.menu')).toHaveCount(0)
  await expect(bob.locator('.replying')).toContainText('Replying to Anne')
  await expect(bob.locator('.replying')).toContainText('shall we go?')
  await expect(bob.getByLabel('Message')).toBeFocused()
  await send(bob, 'yes, at six')
  await expect(bob.locator('.replying')).toHaveCount(0)

  // Both see the answer with the question quoted in it.
  const atAnne = anne.locator('.theirs', {hasText: 'yes, at six'})
  const atBob = bob.locator('.mine', {hasText: 'yes, at six'})
  await expect(atAnne.getByRole('button', {name: 'In reply to You: shall we go?'})).toBeVisible()
  await expect(atBob.getByRole('button', {name: 'In reply to Anne: shall we go?'})).toBeVisible()

  // The quote leads back to the message it quotes, and marks it for a moment.
  const original = anne.locator('.mine', {hasText: 'shall we go?'}).first()
  await expect(original).not.toBeInViewport()
  await atAnne.locator('.quote').click()
  await expect(original).toBeInViewport()
  await expect(original).toHaveClass(/marked/)
  await expect(original).not.toHaveClass(/marked/, {timeout: 5000})

  // A reply that is dismissed is an ordinary message, and so is the one after a reply.
  const lastFiller = bob.locator('.theirs', {hasText: 'filler 25.'})
  await lastFiller.hover()
  await lastFiller.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: 'Reply', exact: true}).click()
  await bob.getByRole('button', {name: 'Cancel reply'}).click()
  await expect(bob.locator('.replying')).toHaveCount(0)
  await send(bob, 'never mind')
  await expect(anne.locator('.theirs', {hasText: 'never mind'})).toBeVisible()
  await expect(anne.locator('.theirs', {hasText: 'never mind'}).locator('.quote')).toHaveCount(0)

  // A picture can be a reply too, and a reply can answer a picture.
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  const answer = anne.locator('.theirs', {hasText: 'yes, at six'})
  await answer.hover()
  await answer.getByRole('button', {name: 'React or copy'}).click()
  await anne.getByRole('button', {name: 'Reply', exact: true}).click()
  await anne.getByLabel('Pictures to add').setInputFiles(photoFile(await makePhoto(anne, 400, 300)))
  await expect(anne.getByRole('img', {name: 'Picture 1 to send'})).toBeVisible()
  await anne.getByRole('button', {name: 'Send'}).click()
  const picture = bob.locator('.theirs.image')
  await expect(picture.getByRole('button', {name: 'In reply to You: yes, at six'})).toBeVisible()
  await expect(picture.locator('.quote .thumb')).toHaveCount(0)
  await picture.hover()
  await picture.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: 'Reply', exact: true}).click()
  await send(bob, 'lovely')
  await expect(anne.locator('.theirs', {hasText: 'lovely'}).getByRole('button', {name: 'In reply to You: Picture'})).toBeVisible()
  // Where a picture is quoted, a small copy of it shows beside the words.
  await expect(bob.locator('.replying')).toHaveCount(0)
  for (const quote of [anne.locator('.theirs', {hasText: 'lovely'}).locator('.quote'), bob.locator('.mine', {hasText: 'lovely'}).locator('.quote')]) {
    await expect(quote.locator('.thumb img:not(.blur)')).toBeVisible({timeout: 20_000})
    expect(await quote.locator('.thumb img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(400)
  }

  // Replies are part of the history.
  await bob.reload()
  await expect(bob.locator('.mine', {hasText: 'yes, at six'}).getByRole('button', {name: 'In reply to Anne: shall we go?'})).toBeVisible()
})

test('people edit what they said: the new words replace the old for everyone, marked as edited', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Edits')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await send(anne, 'see you at fve')
  await expect(bob.locator('.theirs', {hasText: 'see you at fve'})).toBeVisible()
  const box = anne.getByLabel('Message')
  const menuOn = async (bubble: ReturnType<Page['locator']>) => {
    await bubble.hover()
    await bubble.getByRole('button', {name: 'React or copy'}).click()
  }

  // Anne is half way through something else when she spots the mistake.
  await box.fill('half typed')
  await menuOn(anne.locator('.mine', {hasText: 'see you at fve'}))
  await anne.getByRole('button', {name: 'Edit', exact: true}).click()
  await expect(anne.locator('.replying')).toContainText('Editing your message')
  await expect(box).toHaveValue('see you at fve')
  await expect(box).toBeFocused()
  await expect(anne.locator('.mine.marked')).toHaveText(/see you at fve/)
  await expect(anne.getByRole('button', {name: 'Send'})).toHaveCount(0)
  await box.fill('see you at five')
  await anne.getByRole('button', {name: 'Save'}).click()

  // The message changes in place for both, says it was edited, and what she was typing comes back.
  await expect(anne.locator('.replying')).toHaveCount(0)
  await expect(box).toHaveValue('half typed')
  for (const page of [anne, bob]) {
    const bubble = page.locator('.mine, .theirs').filter({hasText: 'see you at five'})
    await expect(bubble).toHaveCount(1)
    await expect(bubble.locator('.time')).toContainText('edited')
    await expect(page.locator('.mine, .theirs')).toHaveCount(1)
    await expect(page.getByText('see you at fve')).toHaveCount(0)
  }

  // Only the person who said it can change it.
  await menuOn(bob.locator('.theirs', {hasText: 'see you at five'}))
  await expect(bob.getByRole('button', {name: 'Reply', exact: true})).toBeVisible()
  await expect(bob.getByRole('button', {name: 'Edit', exact: true})).toHaveCount(0)
  await bob.keyboard.press('Escape')
  await expect(bob.locator('.menu')).toHaveCount(0)

  // The up arrow in an empty box edits the last thing said; Escape backs out; saving it unchanged sends nothing.
  await box.fill('')
  await box.press('ArrowUp')
  await expect(box).toHaveValue('see you at five')
  await box.press('Escape')
  await expect(box).toHaveValue('')
  await expect(anne.locator('.replying')).toHaveCount(0)
  await box.press('ArrowUp')
  await box.fill('see you at five, by the gate')
  await box.press('Enter')
  await expect(bob.locator('.theirs', {hasText: 'see you at five, by the gate'})).toBeVisible()

  // A reply quotes the words as they are now, and an edit is still there after a reload.
  await menuOn(bob.locator('.theirs', {hasText: 'by the gate'}))
  await bob.getByRole('button', {name: 'Reply', exact: true}).click()
  await send(bob, 'ok')
  await expect(anne.getByRole('button', {name: 'In reply to You: see you at five, by the gate'})).toBeVisible()
  await bob.reload()
  await expect(bob.locator('.theirs', {hasText: 'see you at five, by the gate'}).locator('.time')).toContainText('edited')

  // A picture's caption can be added, changed and taken away.
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await anne.getByLabel('Pictures to add').setInputFiles(photoFile(await makePhoto(anne, 400, 300)))
  await anne.getByRole('button', {name: 'Send'}).click()
  await expect(bob.locator('.theirs.image')).toBeVisible()
  await menuOn(anne.locator('.mine.image'))
  await anne.getByRole('button', {name: 'Add a caption'}).click()
  await expect(anne.getByLabel('Add a picture')).toBeDisabled()
  await box.fill('the gate')
  await box.press('Enter')
  await expect(bob.locator('.theirs.image .caption')).toHaveText('the gate')
  await menuOn(anne.locator('.mine.image'))
  await anne.getByRole('button', {name: 'Edit caption'}).click()
  await box.fill('')
  await anne.getByRole('button', {name: 'Save'}).click()
  await expect(bob.locator('.theirs.image .caption')).toHaveCount(0)
  await expect(bob.locator('.theirs.image .time')).toContainText('edited')
})

test('any member renames a group: everyone gets the new name, and the chat says who changed it', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Outing')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(bob.getByRole('heading', {name: 'Outing'})).toBeVisible()
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})

  // Bob, who did not start the chat, renames it.
  await bob.getByRole('button', {name: 'Rename chat'}).click()
  const box = bob.getByLabel('New name for this chat')
  await expect(box).toHaveValue('Outing')
  await expect(box).toBeFocused()
  await box.fill('  Picnic on Sunday  ')
  await bob.getByRole('button', {name: 'Save'}).click()
  await expect(bob.getByRole('heading', {name: 'Picnic on Sunday'})).toBeVisible()
  await expect(anne.getByRole('heading', {name: 'Picnic on Sunday'})).toBeVisible()
  await expect(bob.locator('.event', {hasText: 'changed the name'})).toHaveText('You changed the name to “Picnic on Sunday”')
  await expect(anne.locator('.event', {hasText: 'changed the name'})).toHaveText('Bob changed the name to “Picnic on Sunday”')
  await expect(anne).toHaveTitle('Picnic on Sunday · snrdlr')

  // Backing out, or saving the same name, changes nothing.
  await anne.getByRole('button', {name: 'Rename chat'}).click()
  await anne.getByLabel('New name for this chat').fill('Never mind')
  await anne.getByLabel('New name for this chat').press('Escape')
  await anne.getByRole('button', {name: 'Rename chat'}).click()
  await anne.getByLabel('New name for this chat').press('Enter')
  await expect(anne.getByRole('heading', {name: 'Picnic on Sunday'})).toBeVisible()
  await send(anne, 'after')
  await expect(bob.locator('.theirs', {hasText: 'after'})).toBeVisible()
  await expect(bob.locator('.event', {hasText: 'changed the name'})).toHaveCount(1)

  // The list of chats has the new name too, with nothing marked unread for it.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await expect(chatEntry(bob, 'Picnic on Sunday')).toBeVisible()
  await expect(chatEntry(bob, 'Outing')).toHaveCount(0)

  // The line saying who renamed it is part of the history.
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await bob.reload()
  await chatEntry(bob, 'Picnic on Sunday').click()
  await expect(bob.locator('.event', {hasText: 'changed the name'})).toHaveText('You changed the name to “Picnic on Sunday”')
})

test('on a touch screen, a long press on a message opens its reactions', async ({browser}) => {
  const anne = await newPerson(browser)
  const context = await browser.newContext({hasTouch: true, isMobile: true, viewport: {width: 375, height: 667}})
  const phone = await context.newPage()
  const invite = await startChat(anne, 'Anne', 'Touch')
  await phone.goto(invite)
  await introduce(phone, 'Phone')
  await send(anne, 'press me')
  const bubble = phone.locator('.theirs', {hasText: 'press me'})
  await expect(bubble).toBeVisible()

  const touch = await context.newCDPSession(phone)
  const press = async (ms: number) => {
    const box = (await bubble.boundingBox())!
    const point = {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)}
    await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]})
    await phone.waitForTimeout(ms)
    await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []})
  }

  // There is no hover on a phone, so no button beside the message; and a tap does nothing.
  await expect(bubble.getByRole('button', {name: 'React or copy'})).toBeHidden()
  await press(100)
  await expect(phone.locator('.menu')).toHaveCount(0)

  await press(700)
  const menu = phone.locator('.menu')
  await expect(menu).toBeVisible()
  // Lifting the finger must not close it, and it has to fit on a narrow screen.
  await phone.waitForTimeout(300)
  const box = (await menu.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)

  await phone.getByRole('button', {name: 'React ❤️'}).tap()
  await expect(anne.locator('.mine', {hasText: 'press me'}).getByRole('button', {name: '❤️ from Phone'})).toBeVisible()
  await expect(bubble.locator('.reactions .own')).toHaveText('❤️')

  // The full picker fills the bottom of the screen, and does not raise the keyboard until asked.
  await press(700)
  await phone.getByRole('button', {name: 'Another emoji'}).tap()
  const picker = phone.getByRole('dialog', {name: 'Choose an emoji'})
  await expect(picker.getByRole('button', {name: 'grinning face', exact: true})).toBeVisible()
  await expect(picker.getByLabel('Search emoji')).not.toBeFocused()
  const pickerBox = (await picker.boundingBox())!
  expect(pickerBox.x).toBeGreaterThanOrEqual(0)
  expect(pickerBox.width).toBeLessThanOrEqual(375)
  expect(Math.round(pickerBox.y + pickerBox.height)).toBe(667)
  await picker.getByRole('button', {name: 'winking face', exact: true}).tap()
  await expect(bubble.locator('.reactions .own')).toHaveText('😉')
  await expect(anne.locator('.mine', {hasText: 'press me'}).getByRole('button', {name: '😉 from Phone'})).toBeVisible()
  await press(700)
  await phone.getByRole('button', {name: 'React ❤️'}).tap()
  await expect(bubble.locator('.reactions .own')).toHaveText('❤️')

  // Open again and tap elsewhere: it closes without changing anything.
  await press(700)
  await expect(menu).toBeVisible()
  await phone.waitForTimeout(500)
  await phone.touchscreen.tap(180, 20)
  await expect(menu).toHaveCount(0)
  await expect(bubble.locator('.reactions button')).toHaveText(['❤️'])
})

/** A JPEG made in the page, optionally with a camera-style metadata block holding `secret`. */
async function makePhoto(page: Page, width: number, height: number, secret?: string) {
  const base64 = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const context = canvas.getContext('2d')!
      const gradient = context.createLinearGradient(0, 0, w, h)
      gradient.addColorStop(0, '#f80')
      gradient.addColorStop(1, '#08f')
      context.fillStyle = gradient
      context.fillRect(0, 0, w, h)
      context.fillStyle = '#fff'
      context.fillRect(w / 4, h / 4, w / 8, h / 8)
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
    },
    [width, height]
  )
  const jpeg = Buffer.from(base64, 'base64')
  if (!secret) return jpeg
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(secret)])
  const block = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload])
  return Buffer.concat([jpeg.subarray(0, 2), block, jpeg.subarray(2)])
}

const photoFile = (buffer: Buffer, name = 'photo.jpg') => ({name, mimeType: 'image/jpeg', buffer})

test('people send pictures: shrunk, stripped of camera details, with a caption, a reaction and a full-screen view', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Pictures')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})

  const photo = await makePhoto(anne, 3000, 2000, 'SECRET-GPS-POSITION')
  expect(photo.includes('SECRET-GPS-POSITION')).toBe(true)
  await anne.getByLabel('Pictures to add').setInputFiles(photoFile(photo))
  await expect(anne.getByRole('img', {name: 'Picture 1 to send'})).toBeVisible()
  await expect(anne.getByLabel('Message')).toHaveAttribute('placeholder', 'Add a caption (optional)')
  await anne.getByLabel('Message').fill('the view from the top')
  await anne.getByRole('button', {name: 'Send'}).click()
  await expect(anne.getByRole('list', {name: 'Pictures to send'})).toHaveCount(0)

  // Bob gets the message, then the picture itself: 1600 pixels on its longest side, as a plain JPEG.
  const atBob = bob.locator('.theirs.image')
  await expect(atBob).toContainText('the view from the top')
  const full = atBob.locator('img.full')
  await expect(full).toBeVisible({timeout: 20_000})
  await expect.poll(() => full.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1600, 1067])
  const received = await full.evaluate(async (img: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer())
    return {size: bytes.length, start: [bytes[0], bytes[1]], text: new TextDecoder('latin1').decode(bytes)}
  })
  expect(received.start).toEqual([0xff, 0xd8])
  expect(received.size).toBeLessThan(600 * 1024)
  expect(received.text).not.toContain('SECRET-GPS-POSITION')
  // The sender sees the same shrunken picture.
  await expect(anne.locator('.mine.image img.full')).toBeVisible()

  // It opens full screen and closes again.
  await atBob.getByRole('button', {name: 'Picture from Anne. Open'}).click()
  const viewer = bob.getByRole('dialog', {name: 'Picture'})
  await expect(viewer.locator('img')).toBeVisible()
  await expect(viewer.getByRole('button', {name: 'Save'})).toBeVisible()
  await bob.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // Reactions work on pictures, and the menu offers the caption to copy.
  await atBob.hover()
  await atBob.getByRole('button', {name: 'React or copy'}).click()
  await expect(bob.getByRole('button', {name: 'Copy “the view from the top”'})).toBeVisible()
  await bob.getByRole('button', {name: 'React ❤️'}).click()
  await expect(anne.locator('.mine.image').getByRole('button', {name: '❤️ from Bob'})).toBeVisible()

  // The picture is stored: it is still there after a reload, and counts as one message.
  await bob.reload()
  await expect(bob.locator('.theirs.image img.full')).toBeVisible({timeout: 20_000})
  await expect(bob.locator('.log li:not(.event)')).toHaveCount(1)
})

test('several pictures at once, by choosing, pasting and dropping; and a file that is not a picture', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Album')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  const wide = (await makePhoto(anne, 800, 400)).toString('base64')
  const tall = (await makePhoto(anne, 300, 900)).toString('base64')

  // Two chosen together.
  await anne.getByLabel('Pictures to add').setInputFiles([photoFile(Buffer.from(wide, 'base64'), 'a.jpg'), photoFile(Buffer.from(tall, 'base64'), 'b.jpg')])
  const waiting = anne.getByRole('list', {name: 'Pictures to send'}).getByRole('img')
  await expect(waiting).toHaveCount(2)

  // One pasted into the message box, one dropped on the chat.
  const hand = (event: 'paste' | 'drop', selector: string) =>
    anne.evaluate(
      ([kind, target, data]) => {
        const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0))
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'handed.jpg', {type: 'image/jpeg'}))
        const made =
          kind === 'paste'
            ? new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true})
            : new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true})
        document.querySelector(target)!.dispatchEvent(made)
      },
      [event, selector, wide] as const
    )
  await hand('paste', '[aria-label="Message"]')
  await expect(waiting).toHaveCount(3)
  await hand('drop', '.log')
  await expect(waiting).toHaveCount(4)

  // Something that only claims to be a picture is refused, and one can be taken back out.
  await anne.getByLabel('Pictures to add').setInputFiles(photoFile(Buffer.from('not a picture at all'), 'notes.jpg'))
  await expect(anne.locator('.error')).toContainText('"notes.jpg" isn\'t a picture this browser can open.')
  await anne.getByRole('button', {name: 'Remove picture 4'}).click()
  await expect(waiting).toHaveCount(3)

  // Sent with nothing typed: three pictures, three messages, in order, each its own shape.
  await anne.getByRole('button', {name: 'Send'}).click()
  const got = bob.locator('.theirs.image img.full')
  await expect(got).toHaveCount(3, {timeout: 30_000})
  await expect
    .poll(() => got.evaluateAll((images: HTMLImageElement[]) => images.map(img => `${img.naturalWidth}x${img.naturalHeight}`)))
    .toEqual(['800x400', '300x900', '800x400'])
  await expect(bob.locator('.theirs.image .caption')).toHaveCount(0)
})

test('a picture reaches someone who was away, through a third person, after its sender has gone', async ({browser}) => {
  const [anne, bob, kay] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Relayed')
  await Promise.all([bob.goto(invite), kay.goto(invite)])
  await Promise.all([introduce(bob, 'Bob'), introduce(kay, 'Kay')])
  await expect(anne.locator('.status')).toHaveText(/Connected to 2/, {timeout: 30_000})

  // Bob goes away. Anne sends a picture, which Kay receives; then Anne leaves too.
  await bob.goto('about:blank')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await anne.getByLabel('Pictures to add').setInputFiles(photoFile(await makePhoto(anne, 640, 480)))
  await expect(anne.getByRole('img', {name: 'Picture 1 to send'})).toBeVisible()
  await anne.getByRole('button', {name: 'Send'}).click()
  await expect(kay.locator('.theirs.image img.full')).toBeVisible({timeout: 20_000})
  await anne.goto('about:blank')
  await expect(kay.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})

  // Bob comes back with only Kay there, and still gets the picture.
  await bob.goto('/')
  await chatEntry(bob, 'Relayed').click()
  await expect(bob.locator('.theirs.image img.full')).toBeVisible({timeout: 30_000})
  await expect(bob.locator('.theirs.image .author')).toHaveText('Anne')
})

test('a tab left open on an old version does not leave newer tabs blank, and steps aside for a newer one', async ({browser}) => {
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('snrdlr.invited', '1'))
  // An old tab: holds the storage open at an earlier version and, like old versions, never lets go.
  const old = await context.newPage()
  await old.goto('/')
  const stylesheet = await old.locator('link[rel="stylesheet"]').getAttribute('href')
  await context.clearCookies()
  await old.goto(new URL(stylesheet!, old.url()).href)
  await old.evaluate(async () => {
    for (const {name} of await indexedDB.databases()) await new Promise(done => (indexedDB.deleteDatabase(name!).onsuccess = done))
    await new Promise(done => {
      const request = indexedDB.open('snrdlr', 4)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('identity')
        db.createObjectStore('chats', {keyPath: 'id'})
        db.createObjectStore('messages', {keyPath: ['chatId', 'author', 'seq']}).createIndex('order', ['chatId', 'lamport', 'author', 'seq'])
        db.createObjectStore('left')
        request.transaction!.objectStore('messages').createIndex('received', ['chatId', 'receivedAt'])
      }
      request.onsuccess = () => {
        ;(window as unknown as {held: IDBDatabase}).held = request.result
        done(null)
      }
    })
  })

  // A new tab says what is wrong instead of staying blank, and starts by itself once the old one goes.
  const current = await context.newPage()
  await current.goto('/')
  await expect(current.getByText('another tab in this browser is still running the old version')).toBeVisible()
  await old.close()
  await expect(current.getByLabel('Your name')).toBeVisible()
  await introduce(current, 'Anne')

  // Now this tab is the old one. When a newer version asks for the storage, it lets go and reloads.
  const reloaded = current.waitForEvent('load')
  const newer = await context.newPage()
  await newer.goto(new URL(stylesheet!, current.url()).href)
  const upgraded = await newer.evaluate(
    () =>
      new Promise(done => {
        const request = indexedDB.open('snrdlr', 99)
        request.onsuccess = () => {
          request.result.close()
          done('opened')
        }
        request.onblocked = () => setTimeout(() => done('blocked'), 3000)
      })
  )
  expect(upgraded).toBe('opened')
  await reloaded
})

test('a sound plays when a message is sent or arrives, and can be turned off in settings', async ({browser}) => {
  // Counts sounds as they start, in place of listening for them.
  const listener = async () => {
    const page = await newPerson(browser)
    await page.addInitScript(() => {
      const counter = window as unknown as {played: number}
      counter.played = 0
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args) {
        counter.played++
        return start.apply(this, args)
      }
      // The volume each sound is played at.
      const levels = window as unknown as {volumes: number[]}
      levels.volumes = []
      const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown
      AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
        if (this instanceof GainNode) levels.volumes.push(this.gain.value)
        return connect.apply(this, args)
      } as typeof AudioNode.prototype.connect
    })
    return page
  }
  const played = (page: Page) => page.evaluate(() => (window as unknown as {played: number}).played)
  const [anne, bob] = [await listener(), await listener()]
  const invite = await startChat(anne, 'Anne', 'Sounds')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  // Joining and catching up on history is silent.
  expect(await played(bob)).toBe(0)

  // One for sending, as it is sent, and one for receiving.
  await send(anne, 'hello')
  await expect(bob.locator('.theirs', {hasText: 'hello'})).toBeVisible()
  await expect.poll(() => played(anne)).toBe(1)
  await expect.poll(() => played(bob)).toBe(1)

  // A reaction is not a message, so it is silent.
  await bob.waitForTimeout(500)
  const atBob = bob.locator('.theirs', {hasText: 'hello'})
  await atBob.hover()
  await atBob.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: 'React 👍'}).click()
  await expect(anne.locator('.mine .reactions button')).toHaveText(['👍'])
  await anne.waitForTimeout(300)
  expect(await played(anne)).toBe(1)

  // A message in a chat that is not on screen is heard too, on a computer that stays connected.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await openSettings(bob)
  await bob.getByLabel('Keep every chat connected').check()
  await expect(bob.locator('.keeping')).toHaveText(/with 1 device online/, {timeout: 30_000})
  await closeSettings(bob)
  await send(anne, 'are you there?')
  await expect(chatEntry(bob, 'Sounds').getByLabel('1 unread')).toBeVisible({timeout: 15_000})
  await expect.poll(() => played(bob)).toBe(2)

  // The gear beside the greeting opens settings. The app's own sounds are chosen to begin with.
  await bob.getByRole('button', {name: 'Settings'}).click()
  const settings = bob.getByRole('dialog', {name: 'Settings'})
  await expect(settings.getByRole('radio')).toHaveCount(4)
  await expect(settings.getByRole('group', {name: 'Sounds'}).locator('label')).toHaveText(['snrdl', 'plink', 'groovy', 'shhhhh'])
  await expect(settings.getByRole('radio', {name: 'snrdl'})).toBeChecked()

  // Choosing another set plays one of its sounds, so it can be heard.
  await bob.waitForTimeout(500)
  await settings.getByRole('radio', {name: 'plink'}).check()
  await expect.poll(() => played(bob)).toBe(3)

  // Each set has its own volume. Moving the slider plays a sound at the new level.
  const volumes = () => bob.evaluate(() => (window as unknown as {volumes: number[]}).volumes)
  expect((await volumes()).at(-1)).toBe(0.5)
  await expect(settings.getByText('Volume of plink: 50%')).toBeVisible()
  await settings.getByRole('slider', {name: 'Volume of plink'}).fill('40')
  await expect(settings.getByText('Volume of plink: 40%')).toBeVisible()
  await expect.poll(() => played(bob)).toBe(4)
  expect((await volumes()).at(-1)).toBeCloseTo(0.4)
  await settings.getByRole('radio', {name: 'snrdl'}).check()
  await expect(settings.getByText('Volume of snrdl: 10%')).toBeVisible()
  expect((await volumes()).at(-1)).toBeCloseTo(0.1)
  await settings.getByRole('slider', {name: 'Volume of snrdl'}).fill('150')
  await expect.poll(() => played(bob)).toBe(6)
  expect((await volumes()).at(-1)).toBeCloseTo(1.5)
  await settings.getByRole('radio', {name: 'plink'}).check()
  await expect(settings.getByText('Volume of plink: 40%')).toBeVisible()
  await expect.poll(() => played(bob)).toBe(7)

  // "shhhhh" is silence: choosing it plays nothing, there is no volume to set, and messages are silent.
  await bob.waitForTimeout(500)
  await settings.getByRole('radio', {name: 'shhhhh'}).check()
  await expect(settings.getByRole('slider')).toHaveCount(0)
  await settings.getByRole('button', {name: 'Done'}).click()
  await expect(settings).toHaveCount(0)
  await send(anne, 'hello again')
  await expect(chatEntry(bob, 'Sounds').getByLabel('2 unread')).toBeVisible({timeout: 15_000})
  await bob.waitForTimeout(300)
  expect(await played(bob)).toBe(7)

  // The choices are remembered across a reload.
  await bob.reload()
  await bob.getByRole('button', {name: 'Settings'}).click()
  await expect(settings.getByRole('radio', {name: 'shhhhh'})).toBeChecked()
  await settings.getByRole('radio', {name: 'snrdl'}).check()
  await expect.poll(() => played(bob)).toBe(1)
  await expect(settings.getByText('Volume of snrdl: 150%')).toBeVisible()
  expect((await volumes()).at(-1)).toBeCloseTo(1.5)
  await bob.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // Sending to nobody sounds the same, at once, and nothing more is heard when it reaches someone later.
  await expect.poll(() => played(anne)).toBe(3)
  await bob.goto('about:blank')
  await expect(anne.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})
  await send(anne, 'left for later')
  await expect.poll(() => played(anne)).toBe(4)
  await bob.goto('/')
  await expect(chatEntry(bob, 'Sounds').locator('.unread')).toBeVisible({timeout: 20_000})
  await anne.waitForTimeout(800)
  expect(await played(anne)).toBe(4)
})

test('each sound set plays its own files, and every file in every set can be decoded', async ({browser}) => {
  const page = await newPerson(browser)
  const fetched: string[] = []
  page.on('response', response => /\.(mp3|wav)$/.test(response.url()) && fetched.push(response.url().split('/').pop()!))
  await page.goto('/')
  await introduce(page, 'Anne')
  // The first tap fetches the chosen set, and only that one.
  await expect.poll(() => fetched.length).toBe(27)
  expect(fetched.every(name => name.startsWith('snrdle-'))).toBe(true)

  await page.getByRole('button', {name: 'Settings'}).click()
  await page.getByRole('radio', {name: 'plink'}).check()
  await expect.poll(() => fetched.filter(name => name.startsWith('plink-')).length).toBe(3)
  await page.getByRole('radio', {name: 'groovy'}).check()
  await expect.poll(() => fetched.filter(name => name.startsWith('groovy-')).length).toBe(16)
  expect(await page.getByText('Volume of groovy: 10%').count()).toBe(1)
  const broken = await page.evaluate(async names => {
    const audio = new AudioContext()
    const failures: string[] = []
    for (const name of names) {
      try {
        const buffer = await audio.decodeAudioData(await (await fetch(`assets/${name}`)).arrayBuffer())
        if (buffer.duration < 0.1 || buffer.duration > 2) failures.push(`${name}: ${buffer.duration}s`)
      } catch {
        failures.push(name)
      }
    }
    return failures
  }, fetched)
  expect(broken).toEqual([])
})

test('developer mode: a standing link lets someone join later, with the inviter gone', async ({browser}) => {
  const [anne, bob, cindy] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]

  // Not offered unless developer mode has been turned on.
  const invite = await startChat(anne, 'Anne', 'Plain')
  await expect(anne.getByRole('button', {name: 'Copy standing link (testing)'})).toHaveCount(0)
  expect(invite).toContain('#i=')

  // Turned on from the address, which is then tidied; the home screen says so.
  await anne.goto('/?dev=1')
  await openSettings(anne)
  await expect(anne.locator('.build')).toContainText('developer mode')
  await closeSettings(anne)
  expect(anne.url()).not.toContain('dev=')
  await anne.getByLabel('Chat name').fill('Demo')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  // Cindy joins the ordinary way, while the code is showing.
  await cindy.goto(await copyInvite(anne))
  await introduce(cindy, 'Cindy')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await send(anne, 'welcome to the demo')
  await expect(cindy.locator('.theirs', {hasText: 'welcome to the demo'})).toBeVisible()

  await anne.getByRole('button', {name: 'Copy standing link (testing)'}).click()
  const standing = await anne.evaluate(() => navigator.clipboard.readText())
  expect(standing).toContain('#s=')
  await anne.getByRole('button', {name: 'Stop inviting'}).click()

  // Anne closes the app altogether. Bob opens the link later and is let in by Cindy's device alone.
  await anne.goto('about:blank')
  await expect(cindy.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})
  await bob.goto(standing)
  await introduce(bob, 'Bob')
  await expect(bob.getByRole('heading', {name: 'Demo'})).toBeVisible()
  expect(bob.url()).not.toContain('#s=')
  await expect(bob.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await expect(bob.locator('.theirs', {hasText: 'welcome to the demo'})).toContainText('Anne')
  await send(bob, 'hello from far away')
  await expect(cindy.locator('.theirs', {hasText: 'hello from far away'})).toContainText('Bob')
  await expect(cindy.getByText('Bob joined · by a standing link from Anne')).toBeVisible()

  // Anne comes back and accepts him too. Bob is not offered the button: his copy is not in developer mode.
  await anne.goto('/')
  await chatEntry(anne, 'Demo').click()
  await expect(anne.locator('.theirs', {hasText: 'hello from far away'})).toContainText('Bob', {timeout: 30_000})
  await expect(anne.getByText('Bob joined · by a standing link from you')).toBeVisible()
  await bob.getByRole('button', {name: 'Invite', exact: true}).click()
  await expect(bob.getByRole('button', {name: 'Copy invite link'})).toBeVisible()
  await expect(bob.getByRole('button', {name: 'Copy standing link (testing)'})).toHaveCount(0)

  // The link keeps working, and opening it again changes nothing for someone already in.
  await bob.goto(standing)
  await expect(bob.getByRole('heading', {name: 'Demo'})).toBeVisible()
  await expect(bob.locator('.mine', {hasText: 'hello from far away'})).toBeVisible()

  // Developer mode is turned off the same way.
  await anne.goto('/?dev=0')
  await openSettings(anne)
  await expect(anne.locator('.build')).not.toContainText('developer mode')
})

test('the app is invite-only: a stranger cannot set up, and gets in by joining through an invite', async ({browser}) => {
  const anne = await newPerson(browser)
  const stranger = await newStranger(browser)

  // Finding the address is not enough: no name is asked for and nothing can be started.
  await stranger.goto('/')
  await expect(stranger.getByText('snrdlr is invite-only.')).toBeVisible()
  await expect(stranger.getByLabel('Your name')).toHaveCount(0)
  // The only things to press are the two ways of using an invite, and becoming someone who already uses it.
  await expect(stranger.getByRole('button')).toHaveText(['Scan a code', 'Paste a link', 'Add this browser to my snrdlr'])
  await stranger.reload()
  await expect(stranger.getByText('snrdlr is invite-only.')).toBeVisible()

  // An invite that no longer works does not let them in, even if they had started typing a name.
  const invite = await startChat(anne, 'Anne', 'Club')
  await anne.getByRole('button', {name: 'Stop inviting'}).click()
  await stranger.goto(invite)
  await expect(stranger.getByLabel('Your name')).toBeVisible()
  await expect(stranger.getByText('That invite is no longer active')).toBeVisible({timeout: 15_000})
  await expect(stranger.getByText('snrdlr is invite-only.')).toBeVisible()
  await expect(stranger.getByLabel('Your name')).toHaveCount(0)
  await stranger.reload()
  await expect(stranger.getByText('snrdlr is invite-only.')).toBeVisible()

  // A live invite does. From then on they are a user like any other, across reloads.
  await anne.getByRole('button', {name: 'Invite', exact: true}).click()
  await stranger.goto(await copyInvite(anne))
  await introduce(stranger, 'Newcomer')
  await expect(stranger.getByRole('heading', {name: 'Club'})).toBeVisible()
  await expect(anne.getByText('Newcomer joined · invited by you')).toBeVisible({timeout: 30_000})
  await stranger.goto('/')
  await expect(stranger.getByRole('button', {name: 'Start a group'})).toBeVisible()
  await expect(chatEntry(stranger, 'Club')).toBeVisible()

  // Leaving every chat does not put them back outside.
  await stranger.getByRole('button', {name: 'Leave Club'}).click()
  await stranger.getByRole('button', {name: 'Leave chat'}).click()
  await stranger.reload()
  await expect(stranger.getByRole('button', {name: 'Start a group'})).toBeVisible()
})

test('someone invited who closes the app before giving a name is still in when they return', async ({browser}) => {
  const anne = await newPerson(browser)
  const stranger = await newStranger(browser)
  const invite = await startChat(anne, 'Anne', 'Club')
  await stranger.goto(invite)
  await expect(stranger.getByLabel('Your name')).toBeVisible()
  // Joined in the background, before any name was typed.
  await expect.poll(() => stranger.evaluate(() => localStorage.getItem('snrdlr.invited')), {timeout: 15_000}).toBe('1')
  await stranger.goto('about:blank')
  await stranger.goto('/')
  await introduce(stranger, 'Slow')
  await expect(chatEntry(stranger, 'Club')).toBeVisible()
})

test('a "chat with me" code and a standing link both let a stranger in; developer mode skips the gate', async ({browser}) => {
  const anne = await newPerson(browser)
  await anne.goto('/?dev=1')
  await introduce(anne, 'Anne')

  const viaCode = await newStranger(browser)
  await anne.getByRole('button', {name: 'Chat with one person'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  await viaCode.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await introduce(viaCode, 'Coded')
  await expect(viaCode.getByRole('heading', {name: 'Anne'})).toBeVisible({timeout: 15_000})
  await viaCode.goto('/')
  await expect(viaCode.getByRole('button', {name: 'Start a group'})).toBeVisible()

  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await anne.getByLabel('Chat name').fill('Demo')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  await anne.getByRole('button', {name: 'Copy standing link (testing)'}).click()
  const viaLink = await newStranger(browser)
  await viaLink.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await introduce(viaLink, 'Linked')
  await expect(viaLink.getByRole('heading', {name: 'Demo'})).toBeVisible()
  await viaLink.goto('/')
  await expect(viaLink.getByRole('button', {name: 'Start a group'})).toBeVisible()

  // A fresh device with developer mode on is asked its name like before.
  const developer = await newStranger(browser)
  await developer.goto('/?dev=1')
  await introduce(developer, 'Dev')
  await expect(developer.getByRole('button', {name: 'Start a group'})).toBeVisible()
})

test('someone who used the app before it was invite-only is still in', async ({browser}) => {
  // The first visit is made with developer mode on, which leaves no record of an invitation; then that
  // is switched off, as if the gate had arrived with an update.
  const earlier = await newStranger(browser)
  await earlier.goto('/?dev=1')
  await introduce(earlier, 'Early')
  await expect(earlier.getByRole('button', {name: 'Start a group'})).toBeVisible()
  expect(await earlier.evaluate(() => localStorage.getItem('snrdlr.invited'))).toBeNull()
  await earlier.goto('/?dev=0')
  await expect(earlier.getByRole('button', {name: 'Start a group'})).toBeVisible()
  expect(await earlier.evaluate(() => localStorage.getItem('snrdlr.invited'))).toBe('1')
})

test('an open tab moves to a newer version by itself once idle, but not mid-task or when held', async ({browser}) => {
  const page = await newPerson(browser)
  // What the site says the latest build is. To begin with, the one this tab is running.
  let published: string | null = null
  await page.route('**/version.json', async route => {
    if (published === null) return route.continue()
    await route.fulfill({json: {build: published}})
  })
  const loads: number[] = []
  page.on('load', () => loads.push(Date.now()))
  const lookAgain = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

  await page.goto('/?dev=1')
  await introduce(page, 'Anne')
  await openSettings(page)
  await page.getByLabel('Keep every chat connected').check()
  await expect(page.locator('.running')).toHaveText(/^This tab has been running for under a minute, since /)
  await page.waitForTimeout(2500)
  expect(loads).toHaveLength(1)
  await closeSettings(page)

  // A newer build appears while a message is half typed: the tab stays put.
  await page.getByLabel('Chat name').fill('Updates')
  await page.getByRole('button', {name: 'Start a group'}).click()
  await page.getByRole('button', {name: 'Stop inviting'}).click()
  await page.getByLabel('Message').fill('half a thought')
  published = 'a newer build'
  await lookAgain()
  await page.waitForTimeout(3500)
  expect(loads).toHaveLength(1)
  await expect(page.getByLabel('Message')).toHaveValue('half a thought')

  // Held for testing: still put, and the home screen says an update is waiting.
  await page.getByLabel('Message').fill('')
  await page.getByRole('button', {name: 'Back to chats'}).click()
  await openSettings(page)
  await page.getByLabel('Hold updates in this tab').check()
  await expect(page.getByText('A newer version is out; updates are held in this tab.')).toBeVisible()
  await page.waitForTimeout(3500)
  expect(loads).toHaveLength(1)

  // Released and left alone: it reloads by itself, says so, and carries on keeping chats connected.
  await page.getByLabel('Hold updates in this tab').uncheck()
  await expect.poll(() => loads.length, {timeout: 15_000}).toBe(2)
  await openSettings(page)
  await expect(page.locator('.running')).toHaveText(/^This tab updated itself at .* and has been running for under a minute since\.$/)
  await expect(page.locator('.keeping')).toHaveText(/Keeping 1 chat connected/)

  // The files it got were not the newer build after all. It does not reload again and again; it offers a button.
  await page.waitForTimeout(4000)
  expect(loads).toHaveLength(2)
  await expect(page.getByRole('button', {name: 'Reload to update'})).toBeVisible()
})

test('the build publishes its own version, which matches the one on screen', async ({browser}) => {
  const page = await newPerson(browser)
  await page.goto('/?dev=1')
  await introduce(page, 'Anne')
  const {build} = await (await page.request.get('/version.json')).json()
  await openSettings(page)
  await expect(page.locator('.build')).toContainText(`Version ${build}`)
  await expect(page.getByRole('button', {name: 'Reload to update'})).toHaveCount(0)
})

test('people have profiles: shown in every chat or only where turned on, with an icon, colour, contact and photo', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')

  // Anne fills in everything and shows it everywhere.
  await anne.getByRole('button', {name: 'Your profile'}).click()
  const editor = anne.getByRole('dialog', {name: 'Your profile'})
  await editor.getByRole('button', {name: 'Emoji'}).click()
  const picker = anne.getByRole('dialog', {name: 'Choose an emoji'})
  await anne.keyboard.type('fox')
  await picker.getByRole('button', {name: 'fox', exact: true}).click()
  await expect(editor.locator('.avatar.emoji')).toHaveText('🦊')
  await editor.getByRole('button', {name: 'Green'}).click()
  await editor.getByLabel('Kind of contact').selectOption('email')
  await editor.getByLabel('Contact', {exact: true}).fill('anne@example.com')
  await editor.getByLabel('Profile photo').setInputFiles(photoFile(await makePhoto(anne, 1200, 900)))
  await expect(editor.getByRole('img', {name: 'Your profile photo'})).toBeVisible()
  // Her icon, colour and photo go to every chat; her email only where she turns it on.
  for (const part of ['icon', 'colour', 'photo']) await editor.getByLabel(`Show my ${part} in every chat`).check()
  await editor.getByRole('button', {name: 'Save'}).click()
  await expect(editor).toHaveCount(0)

  await anne.getByLabel('Chat name').fill('Profiles')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  const invite = await copyInvite(anne)
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await send(anne, 'hello from anne')
  await send(bob, 'hello from bob')

  // Bob sees her icon and colour on her messages, and the rest in her profile.
  const hers = bob.locator('.theirs', {hasText: 'hello from anne'})
  await expect(hers).toHaveClass(/tinted/)
  await expect(hers.locator('.author .avatar')).toHaveText('🦊')
  await hers.hover()
  await hers.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: "Anne's profile"}).click()
  const card = bob.getByRole('dialog', {name: "Anne's profile"})
  await expect(card.getByRole('heading', {name: 'Anne'})).toBeVisible()
  await expect(card.getByRole('link')).toHaveCount(0)
  const photo = card.getByRole('img', {name: 'Profile photo'})
  await expect(photo).toBeVisible({timeout: 20_000})
  expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800)
  await card.getByRole('button', {name: 'Done'}).click()

  // Bob shows nothing: Anne sees his initial, no tint, and a profile that says so.
  const his = anne.locator('.theirs', {hasText: 'hello from bob'})
  await expect(his.locator('.author .avatar.initial')).toHaveAttribute('data-initial', 'B')
  await expect(his).not.toHaveClass(/tinted/)
  await his.hover()
  await his.getByRole('button', {name: 'React or copy'}).click()
  await anne.getByRole('button', {name: "Bob's profile"}).click()
  await expect(anne.getByRole('dialog', {name: "Bob's profile"})).toContainText("Bob isn't showing a profile in this chat.")
  await anne.keyboard.press('Escape')

  // Bob picks a colour and a tiny photo, kept to chats where he turns it on. This chat still shows nothing.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await bob.getByRole('button', {name: 'Your profile'}).click()
  const bobEditor = bob.getByRole('dialog', {name: 'Your profile'})
  await bobEditor.getByRole('button', {name: 'Purple'}).click()
  await bobEditor.getByLabel('Tiny photo for your icon').setInputFiles(photoFile(await makePhoto(bob, 600, 400)))
  await expect(bobEditor.locator('img.avatar')).toBeVisible()
  for (const part of ['icon', 'colour']) await expect(bobEditor.getByLabel(`Show my ${part} in every chat`)).not.toBeChecked()
  await bobEditor.getByLabel('Name').fill('Bobby')
  await bobEditor.getByRole('button', {name: 'Save'}).click()
  await expect(bob.locator('.greeting')).toContainText('Hello, Bobby.')
  await chatEntry(bob, 'Profiles').click()
  await expect(anne.locator('.theirs', {hasText: 'hello from bob'}).locator('.author')).toContainText('Bobby')
  await expect(his).not.toHaveClass(/tinted/)

  // He turns it on here, from his own profile in the chat; then off again.
  const own = bob.locator('.mine', {hasText: 'hello from bob'})
  await own.hover()
  await own.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: 'Your profile'}).click()
  const ownCard = bob.getByRole('dialog', {name: 'Your profile'})
  await ownCard.getByLabel('Colour').check()
  await expect(his).toHaveClass(/tinted/)
  await expect(his.locator('.author .avatar.initial')).toHaveAttribute('data-initial', 'B')
  // His own messages are in his colour too, on his screen (purple is dark enough for white words as it is).
  await expect(own).toHaveCSS('background-color', 'rgb(138, 86, 214)')
  await ownCard.getByLabel('Icon').check()
  await expect(his.locator('.author img.avatar')).toBeVisible()
  expect(await his.locator('.author img.avatar').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([96, 96])
  if (process.env.SHOTS) {
    await anne.setViewportSize({width: 390, height: 700})
    await anne.screenshot({path: process.env.SHOTS + '/p-chat.png'})
    await bob.setViewportSize({width: 390, height: 700})
    await bob.screenshot({path: process.env.SHOTS + '/p-own.png'})
  }
  await ownCard.getByLabel('Colour').uncheck()
  await expect(own).not.toHaveCSS('background-color', 'rgb(138, 86, 214)')
  await ownCard.getByLabel('Icon').uncheck()
  await expect(his).not.toHaveClass(/tinted/)
  await expect(his.locator('.author .avatar.initial')).toHaveAttribute('data-initial', 'B')
  await ownCard.getByRole('button', {name: 'Done'}).click()

  // Anne's own profile here: she can hide in this chat what goes everywhere, and lets this chat have her email.
  const mine = anne.locator('.mine', {hasText: 'hello from anne'})
  await mine.hover()
  await mine.getByRole('button', {name: 'React or copy'}).click()
  await anne.getByRole('button', {name: 'Your profile'}).click()
  const anneCard = anne.getByRole('dialog', {name: 'Your profile'})
  await expect(anneCard.getByLabel('Colour')).toBeChecked()
  await anneCard.getByLabel('Colour').uncheck()
  await expect(anneCard.getByText('shown in every chat but this one')).toBeVisible()
  await expect(hers).not.toHaveClass(/tinted/)
  await anneCard.getByLabel('Colour').check()
  await expect(hers).toHaveClass(/tinted/)
  await expect(anneCard.getByLabel('Contact')).not.toBeChecked()
  await anneCard.getByLabel('Contact').check()
  await anneCard.getByRole('button', {name: 'Done'}).click()
  await hers.hover()
  await hers.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: "Anne's profile"}).click()
  await expect(bob.getByRole('link', {name: 'anne@example.com'})).toHaveAttribute('href', 'mailto:anne@example.com')
  await bob.keyboard.press('Escape')

  // Anne's profile travels to a direct chat too, and opens from its header.
  if (process.env.SHOTS) {
    await bob.locator('.theirs', {hasText: 'hello from anne'}).hover()
    await bob.locator('.theirs', {hasText: 'hello from anne'}).getByRole('button', {name: 'React or copy'}).click()
    await bob.getByRole('button', {name: "Anne's profile"}).click()
    await expect(bob.getByRole('img', {name: 'Profile photo'})).toBeVisible()
    await bob.screenshot({path: process.env.SHOTS + '/p-card.png'})
    await bob.keyboard.press('Escape')
    await anne.getByRole('button', {name: 'Back to chats'}).click()
    await anne.getByRole('button', {name: 'Your profile'}).click()
    await anne.screenshot({path: process.env.SHOTS + '/p-edit.png', fullPage: true})
  }
})

test('on a small phone, a home screen longer than the screen scrolls all the way to its top and bottom', async ({browser}) => {
  const context = await browser.newContext({hasTouch: true, isMobile: true, viewport: {width: 375, height: 667}})
  await context.addInitScript(() => localStorage.setItem('snrdlr.invited', '1'))
  const phone = await context.newPage()
  await phone.goto('/')
  await introduce(phone, 'Phone')
  for (let count = 1; count <= 8; count++) {
    await phone.getByLabel('Chat name').fill(`Chat ${count}`)
    await phone.getByRole('button', {name: 'Start a group'}).click()
    await phone.getByRole('button', {name: 'Back to chats'}).click()
  }
  await expect(phone.locator('.chats .open')).toHaveCount(8)
  expect(await phone.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(667)
  await phone.evaluate(() => scrollTo(0, 0))
  const top = (await phone.getByRole('heading', {name: 'snrdlr', exact: true}).boundingBox())!
  expect(top.y).toBeGreaterThanOrEqual(0)
  await expect(phone.getByRole('button', {name: 'Settings'})).toBeInViewport()
  await expect(phone.getByRole('heading', {name: 'Your chats'})).toBeInViewport()
  await phone.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await expect(chatEntry(phone, 'Chat 1')).toBeInViewport()
})

test('someone joins from inside the app, by scanning a code with the camera or pasting a link', async ({browser}) => {
  const anne = await newPerson(browser)
  const invite = await startChat(anne, 'Anne', 'Scanned')
  const code = (await anne.getByRole('img', {name: 'Invite code for this chat'}).screenshot()).toString('base64')

  // A stand-in camera that shows whatever picture the test hands it. The browser's own code reader is
  // taken away, so this goes the way an iPhone does, through the reader the app carries.
  const context = await browser.newContext()
  await context.addInitScript(() => {
    delete (window as {BarcodeDetector?: unknown}).BarcodeDetector
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 600
    const shown = new Image()
    setInterval(() => {
      const picture = (window as {cameraSees?: string}).cameraSees
      if (picture && shown.src !== picture) shown.src = picture
      const pen = canvas.getContext('2d')!
      pen.fillStyle = '#888'
      pen.fillRect(0, 0, 600, 600)
      if (shown.complete && shown.naturalWidth) pen.drawImage(shown, 100, 100, 400, 400)
    }, 50)
    Object.defineProperty(navigator, 'mediaDevices', {value: {getUserMedia: async () => canvas.captureStream(15)}})
  })
  const phone = await context.newPage()
  await phone.goto('/')
  await expect(phone.getByText('snrdlr is invite-only.')).toBeVisible()
  await phone.getByRole('button', {name: 'Scan a code'}).click()
  const scanner = phone.getByRole('dialog', {name: 'Scan a code'})
  await expect(scanner).toContainText('Point the camera at a snrdlr code')

  await phone.evaluate(picture => ((window as {cameraSees?: string}).cameraSees = picture), `data:image/png;base64,${code}`)
  await introduce(phone, 'Phone')
  await expect(phone.getByRole('heading', {name: 'Scanned'})).toBeVisible({timeout: 15_000})
  await expect(scanner).toHaveCount(0)
  await expect(anne.getByText('Phone joined · invited by you')).toBeVisible()

  // Someone else pastes the link they were sent. Text that is no invite is refused.
  const paster = await newStranger(browser)
  await paster.goto('/')
  await paster.getByRole('button', {name: 'Paste a link'}).click()
  await paster.getByLabel('Invite link').fill('https://example.com/nothing')
  await paster.getByRole('button', {name: 'Join'}).click()
  await expect(paster.getByText("That isn't a snrdlr invite link.")).toBeVisible()
  await paster.getByLabel('Invite link').fill(invite)
  await paster.getByRole('button', {name: 'Join'}).click()
  await introduce(paster, 'Paster')
  await expect(paster.getByRole('heading', {name: 'Scanned'})).toBeVisible({timeout: 15_000})

  // The same two ways in are in Settings for someone already using the app.
  await paster.getByRole('button', {name: 'Back to chats'}).click()
  await openSettings(paster)
  await expect(paster.getByRole('button', {name: 'Scan a code'})).toBeVisible()
  await expect(paster.getByRole('button', {name: 'Paste a link'})).toBeVisible()
})

/** Anne, with a group that Bob is in and a little history. */
async function anneAndBob(browser: Browser) {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await anne.getByLabel('Chat name').fill('Picnic')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  await bob.goto(await copyInvite(anne))
  await introduce(bob, 'Bob')
  await send(anne, 'from the phone')
  await expect(bob.locator('.theirs', {hasText: 'from the phone'})).toBeVisible()
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  return {anne, bob}
}

/** After being added: the new device is Anne, with her chat and its history, and writes as her. */
async function isAnne(device: Page, anne: Page, bob: Page) {
  await expect(device.locator('.greeting')).toContainText('Hello, Anne.', {timeout: 30_000})
  await chatEntry(device, 'Picnic').click({timeout: 30_000})
  await expect(device.locator('.mine', {hasText: 'from the phone'})).toBeVisible({timeout: 30_000})
  await send(device, 'from the computer')
  await expect(bob.locator('.theirs', {hasText: 'from the computer'})).toBeVisible({timeout: 30_000})
  await expect(bob.locator('.theirs .author')).toHaveText(['Anne', 'Anne'])
  await expect(bob.locator('.event', {hasText: 'joined'})).toHaveCount(0)
  // On her phone it is one of her own.
  await chatEntry(anne, 'Picnic').click()
  await expect(anne.locator('.mine', {hasText: 'from the computer'})).toBeVisible({timeout: 30_000})
}

test('a computer with no camera shows its code, and the phone adds it: same person, same chats', async ({browser}) => {
  const {anne, bob} = await anneAndBob(browser)
  // A browser that has never been anyone shows a code; the phone opens it (standing in for scanning it).
  const computer = await newStranger(browser)
  await computer.goto('/')
  await computer.getByRole('button', {name: 'Add this browser to my snrdlr'}).click()
  await expect(computer.getByRole('img', {name: 'Code to add this browser'})).toBeVisible()
  await computer.getByRole('button', {name: 'Copy link'}).click()
  const link = await computer.evaluate(() => navigator.clipboard.readText())
  expect(link).toContain('#device1.n.')
  await anne.goto(link)
  // Both show the same number, and nothing happens until the person says so.
  await expect(computer.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  const check = (await computer.locator('.check').textContent())!
  await expect(anne.locator('.check')).toHaveText(check, {timeout: 30_000})
  await anne.getByRole('button', {name: 'Add it'}).click()
  await expect(anne.getByText('Added.')).toBeVisible()
  await anne.getByRole('button', {name: 'Close'}).click()
  await isAnne(computer, anne, bob)

  // A chat started on the computer shows up on the phone too.
  await computer.getByRole('button', {name: 'Back to chats'}).click()
  await computer.getByLabel('Chat name').fill('Dinner')
  await computer.getByRole('button', {name: 'Start a group'}).click()
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await expect(chatEntry(anne, 'Dinner')).toBeVisible({timeout: 30_000})
})

test('the phone shows its code, and a new device that opens it is added once the numbers match', async ({browser}) => {
  const {anne, bob} = await anneAndBob(browser)
  await openSettings(anne)
  await anne.getByRole('button', {name: 'Add a device'}).click()
  await expect(anne.getByRole('img', {name: 'Code to add a device'})).toBeVisible()
  await expect(anne.getByText('Waiting for the other device')).toBeVisible()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  const link = await anne.evaluate(() => navigator.clipboard.readText())
  expect(link).toContain('#device1.e.')

  const computer = await newStranger(browser)
  await computer.goto(link)
  await expect(computer.getByText('will show a number')).toBeVisible()
  await expect(computer.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  const check = (await computer.locator('.check').textContent())!
  await expect(anne.locator('.check')).toHaveText(check, {timeout: 30_000})
  await anne.getByRole('button', {name: 'Add it'}).click()
  await anne.locator('.device-code').getByRole('button', {name: 'Done'}).click()
  await closeSettings(anne)
  await isAnne(computer, anne, bob)

  // The phone let it in, so the phone has nothing to warn about. A device the phone did not let in, it
  // tells her about: here a tablet that the computer adds.
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await expect(anne.locator('.device-news')).toHaveCount(0)
  await computer.getByRole('button', {name: 'Back to chats'}).click()
  await openSettings(computer)
  await computer.getByRole('button', {name: 'Add a device'}).click()
  await computer.getByRole('button', {name: 'Copy link'}).click()
  const tablet = await newStranger(browser)
  await tablet.goto(await computer.evaluate(() => navigator.clipboard.readText()))
  await expect(tablet.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  await computer.getByRole('button', {name: 'Add it'}).click()
  await expect(tablet.locator('.greeting')).toContainText('Hello, Anne.', {timeout: 30_000})
  await expect(anne.locator('.device-news')).toContainText('Another device was added to your snrdlr', {timeout: 30_000})
  await expect(computer.locator('.device-news')).toHaveCount(0)
  await anne.locator('.device-news').getByRole('button', {name: 'OK'}).click()
  await expect(anne.locator('.device-news')).toHaveCount(0)
  await anne.reload()
  await expect(anne.locator('.greeting')).toBeVisible()
  await expect(anne.locator('.device-news')).toHaveCount(0)

  // Opened somewhere that already has chats of its own, the code changes nothing there.
  await anne.goto(link)
  await expect(anne.getByText('This browser already has chats of its own')).toBeVisible()
})

test('the app can be installed, and opens with no network once it has been opened before', async ({browser}) => {
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('snrdlr.invited', '1'))
  const page = await context.newPage()
  await page.goto('/')
  await introduce(page, 'Anne')
  await page.getByLabel('Chat name').fill('Kept')
  await page.getByRole('button', {name: 'Start a group'}).click()
  await send(page, 'written before the network went')

  // What a browser needs before it offers to install: a manifest that names the app, its icons, and a
  // service worker in charge of the page.
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href)).json())
  expect(manifest).toMatchObject({name: 'snrdlr', display: 'standalone', start_url: './'})
  for (const icon of manifest.icons) expect((await page.request.get(new URL(icon.src, page.url()).href)).ok()).toBe(true)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

  // A visit with the worker in charge is what fills its shelves; after that the network can go.
  await page.reload()
  await expect(page.getByRole('heading', {name: 'Kept'})).toBeVisible()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', {name: 'Kept'})).toBeVisible()
  await expect(page.locator('.mine', {hasText: 'written before the network went'})).toBeVisible()
  await page.goto('/')
  await expect(chatEntry(page, 'Kept')).toBeVisible()
  await context.setOffline(false)
})

test('settings say which build is running', async ({browser}) => {
  const anne = await newPerson(browser)
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await openSettings(anne)
  await expect(anne.getByText(/^Version \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · [0-9a-f]{7,}$/)).toBeVisible()
})

test('settings keep their title and close button in view while the rest scrolls', async ({browser}) => {
  const anne = await newPerson(browser)
  await anne.setViewportSize({width: 375, height: 500})
  await anne.goto('/')
  await introduce(anne, 'Anne')
  const sheet = await openSettings(anne)
  await sheet.locator('.sheet-body').evaluate(element => (element.scrollTop = element.scrollHeight))
  await expect(sheet.getByRole('button', {name: 'Done'})).toBeInViewport()
  await expect(sheet.getByRole('heading', {name: 'Settings'})).toBeInViewport()
  const close = sheet.getByRole('button', {name: 'Close'})
  await expect(close).toBeInViewport()
  // Nothing scrolled under it shows through, and it is what gets the tap.
  const box = (await close.boundingBox())!
  expect(await anne.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), [box.x + box.width / 2, box.y + box.height / 2])).toBe('Close')
  await close.click()
  await expect(sheet).toHaveCount(0)
})

test('a malformed or old-format invite link lands on the home screen with an explanation', async ({browser}) => {
  const page = await newPerson(browser)
  await page.goto('/#i=not-a-real-invite')
  await introduce(page, 'Cindy')
  await expect(page.getByText(STALE)).toBeVisible()
})

test('a device link pasted into the app works as well as one opened, and an old one says when it ran out', async ({browser}) => {
  const {anne} = await anneAndBob(browser)
  await openSettings(anne)
  await anne.getByRole('button', {name: 'Add a device'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  const link = await anne.evaluate(() => navigator.clipboard.readText())
  const computer = await newStranger(browser)
  await computer.goto('/')
  await computer.getByRole('button', {name: 'Paste a link'}).click()
  await computer.getByLabel('Invite link').fill(link)
  await computer.getByRole('button', {name: 'Join'}).click()
  await expect(computer.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  await expect(anne.locator('.check')).toHaveText((await computer.locator('.check').textContent())!, {timeout: 30_000})

  // The same link with its time already up.
  const old = link.replace(/\.[0-9a-z]+$/, '.' + Math.floor(Date.now() / 1000 - 3600).toString(36))
  const late = await newStranger(browser)
  await late.goto(old)
  await expect(late.getByText(/This code ran out at .+\. Make a new one/)).toBeVisible()
})

test("a notification tapped in the iPhone's Home Screen app goes on to Safari, or can open there instead", async ({browser}) => {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    viewport: {width: 375, height: 667}
  })
  // The installed app, as an iPhone tells a page so.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', {value: true})
    localStorage.setItem('snrdlr.invited', '1')
  })
  const page = await context.newPage()
  await page.goto('/')
  await introduce(page, 'Anne')
  await page.getByLabel('Chat name').fill('Ping')
  await page.getByRole('button', {name: 'Start a group'}).click()
  await expect(page.getByRole('heading', {name: 'Ping'})).toBeVisible()
  const chat = new URL(page.url()).hash
  expect(chat).toMatch(/^#c=/)

  // Safari's address is not one this browser can follow, so the screen stays put long enough to read.
  await page.goto(`/?safari=${encodeURIComponent(chat)}`)
  await expect(page.getByText('Opening in Safari…')).toBeVisible()
  expect(new URL(page.url()).search).toBe('')
  await page.getByRole('button', {name: 'Open here'}).click()
  await expect(page.getByRole('heading', {name: 'Ping'})).toBeVisible()

  // In Settings, the iPhone app says where notifications are turned on.
  await page.getByRole('button', {name: 'Back to chats'}).click()
  const settings = await openSettings(page)
  await expect(settings.getByRole('heading', {name: 'Notifications'})).toBeVisible()
})

test("what is read on one of a person's devices is no longer unread on the others", async ({browser}) => {
  const {anne, bob} = await anneAndBob(browser)
  await openSettings(anne)
  await anne.getByRole('button', {name: 'Add a device'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  const computer = await newStranger(browser)
  await computer.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await expect(computer.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  await anne.getByRole('button', {name: 'Add it'}).click()
  await anne.locator('.device-code').getByRole('button', {name: 'Done'}).click()
  await closeSettings(anne)
  await expect(computer.locator('.greeting')).toContainText('Hello, Anne.', {timeout: 30_000})
  await expect(chatEntry(computer, 'Picnic')).toBeVisible({timeout: 30_000})

  // Bob writes while both of Anne's devices are on her chat list.
  await send(bob, 'one')
  await send(bob, 'two')
  await computer.reload()
  await expect(chatEntry(computer, 'Picnic').getByLabel('2 unread')).toBeVisible({timeout: 30_000})

  // She reads them on her phone, and the computer stops counting them.
  await chatEntry(anne, 'Picnic').click()
  await expect(anne.locator('.theirs', {hasText: 'two'})).toBeVisible({timeout: 30_000})
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await expect(computer.locator('.unread')).toHaveCount(0, {timeout: 30_000})
  await computer.reload()
  await expect(chatEntry(computer, 'Picnic')).toBeVisible()
  await expect(computer.locator('.unread')).toHaveCount(0)
})

test('a message can have several lines: Shift+Enter on a computer, Enter on a phone', async ({browser}) => {
  const anne = await newPerson(browser)
  const invite = await startChat(anne, 'Anne', 'Lines')
  const context = await browser.newContext({hasTouch: true, isMobile: true, viewport: {width: 375, height: 667}})
  await context.addInitScript(() => localStorage.getItem('snrdlr.invited') ?? localStorage.setItem('snrdlr.invited', '1'))
  const phone = await context.newPage()
  await phone.goto(invite)
  await introduce(phone, 'Bob')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})

  // On a computer, Shift+Enter starts a new line and Enter sends; the box grows, then shrinks back.
  const box = anne.getByLabel('Message')
  const oneLine = (await box.boundingBox())!.height
  await box.pressSequentially('first line')
  await box.press('Shift+Enter')
  await box.pressSequentially('second line')
  expect((await box.boundingBox())!.height).toBeGreaterThan(oneLine)
  await box.press('Enter')
  const arrived = phone.locator('.theirs', {hasText: 'second line'})
  await expect(arrived).toBeVisible()
  expect(await arrived.evaluate(element => element.textContent)).toContain('first line\nsecond line')
  await expect(box).toHaveValue('')
  expect((await box.boundingBox())!.height).toBe(oneLine)

  // On a phone, Enter starts a new line and the Send button sends.
  const phoneBox = phone.getByLabel('Message')
  await phoneBox.pressSequentially('one')
  await phoneBox.press('Enter')
  await phoneBox.pressSequentially('two')
  await expect(phoneBox).toHaveValue('one\ntwo')
  await phone.getByRole('button', {name: 'Send'}).click()
  await expect(anne.locator('.theirs', {hasText: 'two'})).toBeVisible()
  expect(await anne.locator('.theirs', {hasText: 'two'}).evaluate(element => element.textContent)).toContain('one\ntwo')
})

test('a tab whose storage never opens shows snrdlr, reloads itself once, then asks', async ({browser}) => {
  // Stands in for Safari on an iPhone, which sometimes never finishes opening IndexedDB.
  const hang = (always: boolean) => {
    const real = indexedDB.open.bind(indexedDB)
    if (!always && sessionStorage.getItem('test.hung')) return
    sessionStorage.setItem('test.hung', '1')
    indexedDB.open = ((name: string, version?: number) => {
      const request = real(name, version)
      // A real request whose success is never heard of.
      if (name === 'snrdlr') request.addEventListener = ((type: string, ...rest: [EventListener, unknown?]) => type === 'success' || EventTarget.prototype.addEventListener.call(request, type, ...(rest as [EventListener]))) as typeof request.addEventListener
      return request
    }) as typeof indexedDB.open
  }

  const once = await newPerson(browser)
  await once.addInitScript(hang, false)
  await once.goto('/')
  await expect(once.getByRole('heading', {name: 'snrdlr'})).toBeVisible()
  await expect(once.getByLabel('Your name')).toBeVisible({timeout: 15_000})

  const always = await newPerson(browser)
  await always.addInitScript(hang, true)
  await always.goto('/')
  await expect(always.getByText('snrdlr is taking too long to start')).toBeVisible({timeout: 20_000})
  await expect(always.getByRole('button', {name: 'Reload'})).toBeVisible()
})

test('web addresses in a message can be tapped; nothing else becomes a link', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  const invite = await startChat(anne, 'Anne', 'Links')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await send(anne, 'See https://example.com/menu. Or www.snrdlr.net, not javascript:alert(1)')
  const bubble = bob.locator('.theirs', {hasText: 'See'})
  await expect(bubble.getByRole('link')).toHaveCount(2)
  const first = bubble.getByRole('link', {name: 'https://example.com/menu'})
  await expect(first).toHaveAttribute('href', 'https://example.com/menu')
  await expect(first).toHaveAttribute('target', '_blank')
  await expect(first).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(bubble.getByRole('link', {name: 'www.snrdlr.net'})).toHaveAttribute('href', 'https://www.snrdlr.net/')
  // The words around them are unchanged, the sentence's full stop included.
  await expect(bubble).toContainText('See https://example.com/menu. Or www.snrdlr.net, not javascript:alert(1)')
  // The sender's own copy has them too.
  await expect(anne.locator('.mine', {hasText: 'See'}).getByRole('link')).toHaveCount(2)
})

test('one snrdlr tab at a time: the newest takes over, and an old one steps aside until asked', async ({browser}) => {
  const first = await newPerson(browser)
  const invite = await startChat(first, 'Anne', 'Tabs')
  const chat = new URL(first.url()).hash
  const second = await first.context().newPage()
  await second.goto('/')
  await expect(second.locator('.greeting')).toBeVisible()
  await expect(first.getByText('snrdlr is open in another tab')).toBeVisible({timeout: 15_000})
  // Reloaded, or brought back, it stays aside.
  await first.reload()
  await expect(first.getByText('snrdlr is open in another tab')).toBeVisible()
  await expect(second.locator('.greeting')).toBeVisible()
  // A link followed in it means it is wanted again: it takes over, where the link points.
  expect(new URL(first.url()).hash).toBe(chat)
  await first.evaluate(() => (location.hash = ''))
  await expect(first.locator('.greeting')).toBeVisible({timeout: 15_000})
  await expect(second.getByText('snrdlr is open in another tab')).toBeVisible({timeout: 15_000})
  expect(invite).toContain('#i=')
})

test('the chat list shows direct chats first, each with the other person\'s icon and colour', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await bob.goto('/')
  await introduce(bob, 'Bob')
  // Bob shows a colour everywhere.
  await bob.evaluate(() => localStorage.setItem('snrdlr.profile', JSON.stringify({color: '#8a56d6', shareAll: true, chats: []})))
  await bob.reload()
  await anne.getByRole('button', {name: 'Chat with one person'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  await bob.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await expect(anne.getByRole('heading', {name: 'Bob'})).toBeVisible({timeout: 15_000})
  await expect(bob.getByRole('heading', {name: 'Anne'})).toBeVisible({timeout: 15_000})
  // A group started after it would come first by age; direct chats come first anyway.
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await anne.getByLabel('Chat name').fill('Picnic')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await expect(anne.locator('.chats .open .name')).toHaveText(['Bob', 'Picnic'])
  const entry = chatEntry(anne, 'Bob')
  await expect(entry.locator('.avatar.initial')).toHaveAttribute('data-initial', 'B', {timeout: 15_000})
  await expect(entry.locator('.avatar.initial')).toHaveCSS('background-color', 'rgb(138, 86, 214)')
  await expect(entry).toHaveCSS('box-shadow', /rgb\(138, 86, 214\)/)
  await expect(chatEntry(anne, 'Picnic').locator('.avatar')).toHaveCount(0)
})

test('a page naming a script the server no longer has loads itself again, once', async ({browser}) => {
  const page = await newPerson(browser)
  // As after a deploy, when an old copy of the page names the scripts of the version before.
  let missing = 1
  await page.route(/\/assets\/main-[^/]+\.js$/, route => (missing-- > 0 ? route.fulfill({status: 404, body: ''}) : route.continue()))
  await page.goto('/')
  await expect(page.getByLabel('Your name')).toBeVisible({timeout: 15_000})
  expect(missing).toBeLessThan(0)
})

test('what was typed and not sent is still there on coming back, separately for each chat', async ({browser}) => {
  const anne = await newPerson(browser)
  await startChat(anne, 'Anne', 'First')
  await anne.keyboard.press('Escape')
  const box = anne.getByLabel('Message')
  await box.fill('half a bug report\nwith two lines')
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await anne.getByLabel('Chat name').fill('Second')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  await anne.keyboard.press('Escape')
  await expect(box).toHaveValue('')
  await box.fill('something else')
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await chatEntry(anne, 'First').click()
  await expect(box).toHaveValue('half a bug report\nwith two lines')
  // Still there after a reload.
  await anne.reload()
  await expect(box).toHaveValue('half a bug report\nwith two lines')
  // Editing a message meanwhile leaves the draft alone.
  await box.fill('')
  await send(anne, 'sent one')
  await expect(anne.locator('.mine', {hasText: 'sent one'})).toBeVisible()
  await box.press('ArrowUp')
  await expect(box).toHaveValue('sent one')
  await box.press('Escape')
  await expect(box).toHaveValue('')
  await box.fill('kept')
  await box.press('ArrowUp')
  await box.press('Escape')
  await expect(box).toHaveValue('kept')
  // Sending it clears it.
  await anne.getByRole('button', {name: 'Send'}).click()
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await chatEntry(anne, 'First').click()
  await expect(box).toHaveValue('')
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await chatEntry(anne, 'Second').click()
  await expect(box).toHaveValue('something else')
})

test('an added device that changes the name keeps its own tag, so its messages stay apart from the first device\'s', async ({browser}) => {
  const {anne, bob} = await anneAndBob(browser)
  await openSettings(anne)
  await anne.getByRole('button', {name: 'Add a device'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  const computer = await newStranger(browser)
  await computer.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await expect(computer.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  await anne.getByRole('button', {name: 'Add it'}).click()
  await expect(computer.locator('.greeting')).toContainText('Hello, Anne.', {timeout: 30_000})
  const tag = () =>
    computer.evaluate(
      () =>
        new Promise<string | undefined>(resolve => {
          const request = indexedDB.open('snrdlr')
          request.onsuccess = () => {
            const get = request.result.transaction('identity').objectStore('identity').get('self')
            get.onsuccess = () => resolve(get.result?.device)
          }
        })
    )
  const before = await tag()
  expect(before).toMatch(/^[0-9a-f]{16}$/)
  await computer.getByRole('button', {name: 'Your profile'}).click()
  await computer.getByRole('dialog', {name: 'Your profile'}).getByLabel('Name').fill('Annie')
  await computer.getByRole('dialog', {name: 'Your profile'}).getByRole('button', {name: 'Save'}).click()
  await expect(computer.locator('.greeting')).toContainText('Hello, Annie.')
  expect(await tag()).toBe(before)
  await computer.reload()
  expect(await tag()).toBe(before)
  expect(bob).toBeTruthy()
})

test("a person's profile, name and photo included, is the same on all their devices", async ({browser}) => {
  const {anne, bob} = await anneAndBob(browser)
  await openSettings(anne)
  await anne.getByRole('button', {name: 'Add a device'}).click()
  await anne.getByRole('button', {name: 'Copy link'}).click()
  const computer = await newStranger(browser)
  await computer.goto(await anne.evaluate(() => navigator.clipboard.readText()))
  await expect(computer.locator('.check')).toHaveText(/^\d{3} \d{3}$/)
  await anne.getByRole('button', {name: 'Add it'}).click()
  await anne.locator('.device-code').getByRole('button', {name: 'Done'}).click()
  await closeSettings(anne)
  await expect(computer.locator('.greeting')).toContainText('Hello, Anne.', {timeout: 30_000})

  // On the computer: a new name, a colour, and a photo big enough to travel in pieces.
  await computer.getByRole('button', {name: 'Your profile'}).click()
  const editor = computer.getByRole('dialog', {name: 'Your profile'})
  await editor.getByLabel('Name').fill('Annie')
  await editor.getByRole('button', {name: 'Teal'}).click()
  // Noise, which squeezes badly, so the photo is several pieces' worth.
  const noisy = await computer.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    const context = canvas.getContext('2d')!
    const pixels = context.createImageData(800, 600)
    for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256)
    context.putImageData(pixels, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
  })
  await editor.getByLabel('Profile photo').setInputFiles({name: 'noise.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(noisy, 'base64')})
  await expect(editor.getByRole('img', {name: 'Your profile photo'})).toBeVisible()
  await editor.getByRole('button', {name: 'Save'}).click()
  await expect(computer.locator('.greeting')).toContainText('Hello, Annie.')
  const photoBytes = await computer.evaluate(
    () =>
      new Promise<number>(resolve => {
        const request = indexedDB.open('snrdlr')
        request.onsuccess = () => {
          const all = request.result.transaction('files').objectStore('files').getAll()
          all.onsuccess = () => resolve(Math.max(0, ...all.result.filter(file => file.chatId === '~profile').map(file => file.data.length)))
        }
      })
  )
  expect(photoBytes).toBeGreaterThan(32_000 * 2)

  // The phone takes it all up.
  await expect(anne.locator('.greeting')).toContainText('Hello, Annie.', {timeout: 30_000})
  await anne.getByRole('button', {name: 'Your profile'}).click()
  const there = anne.getByRole('dialog', {name: 'Your profile'})
  await expect(there.getByLabel('Name')).toHaveValue('Annie')
  await expect(there.getByRole('button', {name: 'Teal'})).toHaveAttribute('aria-pressed', 'true')
  await expect(there.getByRole('img', {name: 'Your profile photo'})).toBeVisible({timeout: 30_000})
  expect(bob).toBeTruthy()
})

test('in one chat, your profile can show something other than your usual', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await anne.evaluate(() =>
    localStorage.setItem('snrdlr.profile', JSON.stringify({color: '#8a56d6', contact: {kind: 'email', value: 'anne@example.com'}, show: {color: {everywhere: true}}}))
  )
  await anne.reload()
  await anne.getByLabel('Chat name').fill('Elsewhere')
  await anne.getByRole('button', {name: 'Start a group'}).click()
  await bob.goto(await copyInvite(anne))
  await introduce(bob, 'Bob')
  await send(anne, 'hello from anne')
  const hers = bob.locator('.theirs', {hasText: 'hello from anne'})
  await expect(hers).toHaveAttribute('style', /#8a56d6/, {timeout: 15_000})

  const openOwn = async () => {
    const mine = anne.locator('.mine', {hasText: 'hello from anne'})
    await mine.hover()
    await mine.getByRole('button', {name: 'React or copy'}).click()
    await anne.getByRole('button', {name: 'Your profile'}).click()
    return anne.getByRole('dialog', {name: 'Your profile'})
  }
  // Teal in this chat only.
  let own = await openOwn()
  const colour = own.locator('.part', {hasText: 'Colour'})
  await colour.getByRole('button', {name: 'Use something else here'}).click()
  await colour.getByRole('button', {name: 'Teal here'}).click()
  await expect(colour.getByText('just here')).toBeVisible()
  await expect(colour.getByText('Your usual is Purple')).toBeVisible()
  await expect(hers).toHaveAttribute('style', /#1f9aa8/, {timeout: 15_000})
  // A contact just for this chat, shown here, though the usual one is not.
  const contact = own.locator('.part', {hasText: 'Contact'})
  await contact.getByRole('button', {name: 'Use something else here'}).click()
  await contact.getByLabel('Contact here', {exact: true}).fill('anne.elsewhere@example.com')
  await contact.getByRole('button', {name: 'Use here'}).click()
  await expect(contact.getByRole('checkbox')).toBeChecked()
  await own.getByRole('button', {name: 'Done'}).click()
  await hers.hover()
  await hers.getByRole('button', {name: 'React or copy'}).click()
  await bob.getByRole('button', {name: "Anne's profile"}).click()
  await expect(bob.getByRole('link', {name: 'anne.elsewhere@example.com'})).toBeVisible({timeout: 15_000})
  await bob.keyboard.press('Escape')

  // The usual is unchanged; and back to it here.
  expect(await anne.evaluate(() => JSON.parse(localStorage.getItem('snrdlr.profile')!).color)).toBe('#8a56d6')
  own = await openOwn()
  await own.locator('.part', {hasText: 'Colour'}).getByRole('button', {name: 'Back to my usual'}).click()
  await expect(hers).toHaveAttribute('style', /#8a56d6/, {timeout: 15_000})

  // Another name, just here; then the usual again.
  const naming = own.locator('.part', {hasText: 'Name'})
  await naming.getByRole('button', {name: 'Use another name here'}).click()
  await naming.getByLabel('Name here').fill('Annie of the tea room')
  await naming.getByRole('button', {name: 'Use here'}).click()
  await expect(hers.locator('.author')).toContainText('Annie of the tea room', {timeout: 15_000})
  await expect(anne.locator('.greeting')).toHaveCount(0)
  await naming.getByRole('button', {name: 'Back to my usual'}).click()
  await expect(hers.locator('.author')).toHaveText(/^.?Anne$/, {timeout: 15_000})

  // Something her usual profile does not have at all: an icon, for this chat only.
  const icon = own.locator('.part', {hasText: 'Icon'})
  await expect(icon.getByText('None yet')).toBeVisible()
  await expect(icon.getByRole('button', {name: 'Add one for this chat'})).toBeVisible()
})

test('a voice message is recorded, listened to, sent, and played by the other person', async ({browser}) => {
  const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write', 'microphone']})
  await context.addInitScript(() => localStorage.getItem('snrdlr.invited') ?? localStorage.setItem('snrdlr.invited', '1'))
  const anne = await context.newPage()
  const bob = await newPerson(browser)
  const invite = await startChat(anne, 'Anne', 'Voices')
  await bob.goto(invite)
  await introduce(bob, 'Bob')
  await expect(anne.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})

  // With nothing typed, the button records; typing turns it back into Send.
  const mic = anne.getByRole('button', {name: 'Record your voice'})
  await expect(mic).toBeVisible()
  await anne.getByLabel('Message').fill('x')
  await expect(mic).toHaveCount(0)
  await anne.getByLabel('Message').fill('')
  await mic.click()
  await expect(anne.getByRole('status', {name: 'Recording your voice'})).toBeVisible()
  await anne.waitForTimeout(2200)
  await anne.getByRole('button', {name: 'Stop', exact: true}).click()
  // Listened to before sending.
  const review = anne.locator('.review')
  await expect(review.getByRole('button', {name: 'Play'})).toBeEnabled()
  await expect(review.locator('.time')).toHaveText(/^0:0[2-3]$/)
  await review.getByRole('button', {name: 'Send'}).click()
  await expect(review).toHaveCount(0)

  // Bob gets it, and can play it.
  const voice = bob.locator('.theirs .voice')
  await expect(voice).toBeVisible({timeout: 15_000})
  await expect(voice.getByRole('button', {name: 'Play'})).toBeEnabled({timeout: 15_000})
  await voice.getByRole('button', {name: 'Play'}).click()
  await expect(voice.getByRole('button', {name: 'Pause'})).toBeVisible()
  await voice.getByRole('button', {name: 'Speed 1×'}).click()
  await expect(voice.getByRole('button', {name: 'Speed 1.5×'})).toBeVisible()
  // It counts as news, like words.
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await anne.getByRole('button', {name: 'Record your voice'}).click()
  await anne.waitForTimeout(1200)
  await anne.getByRole('button', {name: 'Stop', exact: true}).click()
  await anne.locator('.review').getByRole('button', {name: 'Send'}).click()
  await expect(anne.locator('.mine .voice')).toHaveCount(2)
  // The chat list catches up when the app is opened again.
  await bob.reload()
  await expect(chatEntry(bob, 'Voices').getByLabel('1 unread')).toBeVisible({timeout: 20_000})
})

test('a microphone that is turned off says where to turn it on', async ({browser}) => {
  const anne = await newPerson(browser)
  await anne.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), {name: 'NotAllowedError'}))
  })
  await startChat(anne, 'Anne', 'Quiet')
  await anne.getByRole('button', {name: 'Record your voice'}).click()
  await expect(anne.getByText('The microphone is turned off for snrdlr.')).toBeVisible()
  await expect(anne.getByRole('status', {name: 'Recording your voice'})).toHaveCount(0)
  // Read, and put away.
  await anne.getByRole('button', {name: 'Dismiss'}).click()
  await expect(anne.getByText('The microphone is turned off for snrdlr.')).toHaveCount(0)
})

test("recording tells an iPhone it is recording, which an ambient page cannot do, and goes back after", async ({browser}) => {
  const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write', 'microphone']})
  await context.addInitScript(() => {
    localStorage.setItem('snrdlr.invited', '1')
    // As Safari on an iPhone: an audio session, and no microphone while it is ambient.
    const session = {type: 'auto'}
    Object.defineProperty(navigator, 'audioSession', {value: session})
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = constraints =>
      session.type === 'ambient' ? Promise.reject(Object.assign(new Error('Failed to start the audio device'), {name: 'InvalidStateError'})) : real(constraints)
  })
  const anne = await context.newPage()
  await startChat(anne, 'Anne', 'Session')
  // A tap has set the page up for message sounds.
  await anne.getByLabel('Message').click()
  expect(await anne.evaluate(() => (navigator as unknown as {audioSession: {type: string}}).audioSession.type)).toBe('ambient')
  await anne.getByRole('button', {name: 'Record your voice'}).click()
  await expect(anne.getByRole('status', {name: 'Recording your voice'})).toBeVisible()
  expect(await anne.evaluate(() => (navigator as unknown as {audioSession: {type: string}}).audioSession.type)).toBe('play-and-record')
  await anne.waitForTimeout(1200)
  await anne.getByRole('button', {name: 'Stop', exact: true}).click()
  await expect(anne.locator('.review')).toBeVisible()
  expect(await anne.evaluate(() => (navigator as unknown as {audioSession: {type: string}}).audioSession.type)).toBe('ambient')
})
