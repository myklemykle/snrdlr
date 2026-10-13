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

test('two people start a direct chat from a "chat with me" code, and it cannot be invited into', async ({browser}) => {
  const [anne, bob] = [await newPerson(browser), await newPerson(browser)]
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await bob.goto('/')
  await introduce(bob, 'Bob')

  await anne.getByRole('button', {name: 'Show my code'}).click()
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

  // No invite button here; pairing again reopens the same chat instead of making another.
  await expect(anne.getByRole('button', {name: 'Invite', exact: true})).toHaveCount(0)
  await bob.getByRole('button', {name: 'Back to chats'}).click()
  await bob.getByRole('button', {name: 'Show my code'}).click()
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
  await anne.getByRole('button', {name: 'Show my code'}).click()
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
  await chatEntry(kay, 'Relay').click()
  await expect(kay.locator('.status')).toHaveText(/Connected to 1/, {timeout: 30_000})
  await kay.getByRole('button', {name: 'Back to chats'}).click()
  await expect(keeping).toHaveText(/Keeping 1 chat connected, with 1 device online/, {timeout: 30_000})

  // A second tab in the same browser leaves the job to the first.
  const second = await kay.context().newPage()
  await second.goto('/')
  await expect(second.getByLabel('Keep every chat connected')).toBeChecked()
  await expect(second.locator('.keeping')).toHaveText('Another snrdlr tab in this browser is already doing this.')
  // When the first tab closes, the second takes over, and the choice has survived the reload.
  await kay.close()
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
  await expect(anne.locator('.error')).toHaveText('"notes.jpg" isn\'t a picture this browser can open.')
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

  // One for receiving, and one for sending once it has arrived.
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
  await bob.getByLabel('Keep every chat connected').check()
  await expect(bob.locator('.keeping')).toHaveText(/with 1 device online/, {timeout: 30_000})
  await send(anne, 'are you there?')
  await expect(chatEntry(bob, 'Sounds').getByLabel('1 unread')).toBeVisible({timeout: 15_000})
  await expect.poll(() => played(bob)).toBe(2)

  // The gear beside the greeting opens settings. The app's own sounds are chosen to begin with.
  await bob.getByRole('button', {name: 'Settings'}).click()
  const settings = bob.getByRole('dialog', {name: 'Settings'})
  await expect(settings.getByRole('radio')).toHaveCount(3)
  await expect(settings.getByRole('group', {name: 'Sounds'}).locator('label')).toHaveText(['snrdl', 'plink', 'shhhhh'])
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

  // Sending to nobody is silent. The sound comes when the message reaches someone.
  await expect.poll(() => played(anne)).toBe(3)
  await bob.goto('about:blank')
  await expect(anne.locator('.status')).toHaveText('Nobody else is here right now', {timeout: 30_000})
  await send(anne, 'left for later')
  await anne.waitForTimeout(800)
  expect(await played(anne)).toBe(3)
  await bob.goto('/')
  await expect(chatEntry(bob, 'Sounds').locator('.unread')).toBeVisible({timeout: 20_000})
  await expect.poll(() => played(anne)).toBe(4)
})

test('each sound set plays its own files, and every file in the app\'s own set can be decoded', async ({browser}) => {
  const page = await newPerson(browser)
  const fetched: string[] = []
  page.on('response', response => /\.(mp3|wav)$/.test(response.url()) && fetched.push(response.url().split('/').pop()!))
  await page.goto('/')
  await introduce(page, 'Anne')
  // The first tap fetches the chosen set, and only that one.
  await expect.poll(() => fetched.length).toBe(27)
  expect(fetched.every(name => name.startsWith('snrdle-'))).toBe(true)
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

  await page.getByRole('button', {name: 'Settings'}).click()
  await page.getByRole('radio', {name: 'plink'}).check()
  await expect.poll(() => fetched.filter(name => name.startsWith('plink-')).length).toBe(3)
})

test('developer mode: a standing link lets someone join later, with the inviter gone', async ({browser}) => {
  const [anne, bob, cindy] = [await newPerson(browser), await newPerson(browser), await newPerson(browser)]

  // Not offered unless developer mode has been turned on.
  const invite = await startChat(anne, 'Anne', 'Plain')
  await expect(anne.getByRole('button', {name: 'Copy standing link (testing)'})).toHaveCount(0)
  expect(invite).toContain('#i=')

  // Turned on from the address, which is then tidied; the home screen says so.
  await anne.goto('/?dev=1')
  await expect(anne.locator('.build')).toContainText('developer mode')
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
  await expect(anne.locator('.build')).not.toContainText('developer mode')
})

test('the home screen says which build is running', async ({browser}) => {
  const anne = await newPerson(browser)
  await anne.goto('/')
  await introduce(anne, 'Anne')
  await expect(anne.getByText(/^Version \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · [0-9a-f]{7,}$/)).toBeVisible()
})

test('a malformed or old-format invite link lands on the home screen with an explanation', async ({browser}) => {
  const page = await newPerson(browser)
  await page.goto('/#i=not-a-real-invite')
  await introduce(page, 'Cindy')
  await expect(page.getByText(STALE)).toBeVisible()
})
