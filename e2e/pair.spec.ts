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
  await expect(bob.locator('.log li:not(.event)')).toHaveText(['Annehello from anne', 'hello from bob', 'Annestill here'])

  // The chat is listed on the home screen and reopens with its history.
  await anne.getByRole('button', {name: 'Back to chats'}).click()
  await anne.getByRole('button', {name: 'Test chat'}).click()
  await expect(anne.locator('.mine', {hasText: 'still here'})).toBeVisible()
})

test('an invalid invite link lands on the home screen with an explanation', async ({browser}) => {
  const page = await newPerson(browser)
  await page.goto('/#i=not-a-real-invite')
  await introduce(page, 'Cindy')
  await expect(page.getByText("That invite link isn't valid.")).toBeVisible()
})
