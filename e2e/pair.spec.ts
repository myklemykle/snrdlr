import {expect, test} from '@playwright/test'

test('two browsers pair through the invite link and exchange messages', async ({browser}) => {
  const anne = await (await browser.newContext()).newPage()
  const bob = await (await browser.newContext()).newPage()

  await anne.goto('/')
  await anne.getByLabel('Chat name').fill('Test chat')
  await anne.getByRole('button', {name: 'Start a chat'}).click()
  await expect(anne.getByRole('img', {name: 'Invite code for this chat'})).toBeVisible()

  // Stands in for scanning the QR code, which encodes this same URL.
  await bob.goto(anne.url())
  await expect(bob.getByRole('heading', {name: 'Test chat'})).toBeVisible()

  await expect(anne.getByText('Connected to 1')).toBeVisible({timeout: 60_000})
  await expect(bob.getByText('Connected to 1')).toBeVisible({timeout: 60_000})

  await anne.getByLabel('Message').fill('hello from anne')
  await anne.getByRole('button', {name: 'Send'}).click()
  await expect(bob.locator('.theirs', {hasText: 'hello from anne'})).toBeVisible()

  await bob.getByLabel('Message').fill('hello from bob')
  await bob.getByRole('button', {name: 'Send'}).click()
  await expect(anne.locator('.theirs', {hasText: 'hello from bob'})).toBeVisible()
})
