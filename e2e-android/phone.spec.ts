import {expect, test, type Browser, type Page} from '@playwright/test'
import {away, connectPhone, copiedBy, openChrome, resetApp, setWifi, sleep, type Phone} from './phone'

// The phone is "Moto"; a desktop browser on this machine is "Desk".
let phone: Phone
let moto: Page

test.describe.configure({mode: 'serial'})

test.beforeAll(async () => {
  phone = await connectPhone()
  moto = phone.page
})

test.beforeEach(async () => {
  openChrome()
  await moto.bringToFront()
  await resetApp(moto)
  await introduce(moto, 'Moto')
})

test.afterAll(async () => {
  setWifi(true)
  await phone?.browser.close()
})

async function newDesk(browser: Browser, name = 'Desk'): Promise<Page> {
  const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']})
  const page = await context.newPage()
  await page.goto('/')
  await introduce(page, name)
  return page
}

async function introduce(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', {name: 'Continue'}).click()
  await expect(page.getByRole('heading', {name: 'New group'})).toBeVisible()
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', {name: 'Send'}).click()
}

const texts = (page: Page) => page.locator('.log li:not(.event)')
const connected = (page: Page, count = 1) => expect(page.locator('.status')).toHaveText(new RegExp(`Connected to ${count}`), {timeout: 45_000})

/** Desk starts a group and Moto joins by its link. Both end up connected in the chat. */
async function deskInvitesMoto(desk: Page, chatName: string) {
  await desk.getByLabel('Chat name').fill(chatName)
  await desk.getByRole('button', {name: 'Start a group'}).click()
  await desk.getByRole('button', {name: 'Copy invite link'}).click()
  const invite = await desk.evaluate(() => navigator.clipboard.readText())
  await moto.goto(invite)
  await expect(moto.getByRole('heading', {name: chatName})).toBeVisible({timeout: 30_000})
  await connected(moto)
  await connected(desk)
}

test('the phone joins a group by link, chats, and keeps its history across a reload', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Join test')
  console.log('route seen by phone:', await moto.locator('.status').textContent())

  await send(desk, 'hello phone')
  await expect(moto.locator('.theirs', {hasText: 'hello phone'})).toContainText('Desk')
  await send(moto, 'hello desk')
  await expect(desk.locator('.theirs', {hasText: 'hello desk'})).toContainText('Moto')
  await expect(moto.getByText('Desk started this chat')).toBeVisible()
  expect(moto.url()).not.toContain('#i=')

  await moto.reload()
  await expect(moto.getByText('hello phone')).toBeVisible()
  await expect(moto.getByText('hello desk')).toBeVisible()
  await connected(moto)
  await send(desk, 'after reload')
  await expect(moto.locator('.theirs', {hasText: 'after reload'})).toBeVisible()
  await expect(moto).toHaveTitle('Join test · snrdlr')
})

test('the phone starts a group and someone joins through its code', async ({browser}) => {
  const desk = await newDesk(browser)
  await moto.getByLabel('Chat name').fill('Phone group')
  await moto.getByRole('button', {name: 'Start a group'}).click()
  const code = moto.getByRole('img', {name: 'Invite code for this chat'})
  await expect(code).toBeVisible()
  // The whole code is on screen without scrolling.
  const box = (await code.boundingBox())!
  const view = await moto.evaluate(() => ({width: innerWidth, height: innerHeight}))
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height)

  await desk.goto(await copiedBy(moto, 'Copy invite link'))
  await expect(desk.getByRole('heading', {name: 'Phone group'})).toBeVisible({timeout: 30_000})
  await connected(desk)
  await send(desk, 'made it')
  await expect(moto.locator('.theirs', {hasText: 'made it'})).toBeVisible()
  await expect(moto.getByText('Desk joined · invited by you')).toBeVisible()
})

test('messages sent while the phone is on its home screen show up, in order, when it returns', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Away test')
  await send(moto, 'before leaving')
  await expect(desk.locator('.theirs', {hasText: 'before leaving'})).toBeVisible()

  for (const awaySeconds of [20, 70]) {
    phone = await away(phone, awaySeconds * 1000, async () => {
      await send(desk, `first while away ${awaySeconds}s`)
      await sleep(2000)
      await send(desk, `second while away ${awaySeconds}s`)
    })
    moto = phone.page

    await expect(moto.locator('.theirs', {hasText: `second while away ${awaySeconds}s`})).toBeVisible({timeout: 45_000})
    await expect(moto.locator('.theirs', {hasText: `first while away ${awaySeconds}s`})).toBeVisible()
    await connected(moto)
  }
  await expect(texts(moto)).toHaveText([
    /before leaving/,
    /first while away 20s/,
    /second while away 20s/,
    /first while away 70s/,
    /second while away 70s/
  ])
  await send(moto, 'back again')
  await expect(desk.locator('.theirs', {hasText: 'back again'})).toBeVisible({timeout: 45_000})
})

test('the chat list shows what arrived while the phone was elsewhere', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Unread test')
  await moto.getByRole('button', {name: 'Back to chats'}).click()
  await expect(moto.locator('.chats .open', {hasText: 'Unread test'})).toBeVisible()

  phone = await away(phone, 40_000, async () => {
    for (const text of ['one', 'two', 'three']) await send(desk, text)
  })
  moto = phone.page

  await expect(moto.locator('.chats .unread')).toHaveText('3', {timeout: 45_000})
  await moto.locator('.chats .open', {hasText: 'Unread test'}).click()
  await expect(texts(moto)).toHaveText([/one/, /two/, /three/])
  await moto.getByRole('button', {name: 'Back to chats'}).click()
  await expect(moto.locator('.chats .unread')).toHaveCount(0)
})

test('a direct chat from the phone\'s code, then "add someone" starts a group', async ({browser}) => {
  const desk = await newDesk(browser)
  await moto.getByRole('button', {name: 'Show my code'}).click()
  await desk.goto(await copiedBy(moto, 'Copy link'))
  await expect(desk.getByRole('heading', {name: 'Moto'})).toBeVisible({timeout: 30_000})
  // The phone's code closes by itself and it goes straight to the chat.
  await expect(moto.getByRole('heading', {name: 'Desk'})).toBeVisible({timeout: 30_000})
  await connected(moto)
  await expect(moto.getByRole('button', {name: 'Invite'})).toHaveCount(0)
  await send(desk, 'just us')
  await expect(moto.locator('.theirs', {hasText: 'just us'})).toBeVisible()

  await moto.getByRole('button', {name: 'Add someone'}).click()
  await expect(moto.getByRole('heading', {name: 'Group with Desk'})).toBeVisible()
  await desk.getByRole('button', {name: 'Open'}).click()
  await expect(desk.getByRole('heading', {name: 'Group with Desk'})).toBeVisible()
  await connected(moto)
  await send(desk, 'in the group')
  await expect(moto.locator('.theirs', {hasText: 'in the group'})).toBeVisible()
})

test('the message box stays above the on-screen keyboard', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Keyboard test')
  for (let i = 1; i <= 25; i++) await send(desk, `line ${i}`)
  await expect(moto.locator('.theirs', {hasText: 'line 25'})).toBeVisible()

  const before = await moto.evaluate(() => visualViewport!.height)
  // A real touch, sent through the debugger, so Android raises its keyboard as it would for a finger.
  const target = (await moto.getByLabel('Message').boundingBox())!
  const point = {x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2)}
  const session = await moto.context().newCDPSession(moto)
  await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]})
  await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []})
  await expect.poll(() => moto.evaluate(() => visualViewport!.height), {timeout: 10_000}).toBeLessThan(before - 100)
  await sleep(1000)

  const layout = await moto.evaluate(() => {
    const box = (label: string) => document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect()
    const last = [...document.querySelectorAll('.log li')].at(-1)!.getBoundingClientRect()
    return {visible: visualViewport!.height, offset: visualViewport!.offsetTop, input: box('Message').bottom, last: last.bottom, lastTop: last.top}
  })
  console.log('keyboard layout:', JSON.stringify({before, ...layout}))
  expect(layout.input).toBeLessThanOrEqual(layout.offset + layout.visible + 1)
  expect(layout.lastTop).toBeGreaterThanOrEqual(layout.offset)
  expect(layout.last).toBeLessThanOrEqual(layout.offset + layout.visible + 1)
  await moto.keyboard.press('Escape').catch(() => {})
})

test('the phone reconnects by itself after Wi-Fi drops and returns', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Wifi test')

  setWifi(false)
  await sleep(15_000)
  await send(moto, 'typed with no network')
  await send(desk, 'sent while phone offline')
  setWifi(true)

  await expect(desk.locator('.theirs', {hasText: 'typed with no network'})).toBeVisible({timeout: 120_000})
  await expect(moto.locator('.theirs', {hasText: 'sent while phone offline'})).toBeVisible({timeout: 60_000})
  await connected(moto)
  await expect(moto.locator('.error')).toHaveCount(0)
})

test('the phone does not offer to stay connected, and a computer does', async ({browser}) => {
  const desk = await newDesk(browser)
  await expect(desk.getByRole('heading', {name: 'Stay connected'})).toBeVisible()
  await expect(moto.getByRole('heading', {name: 'New group'})).toBeVisible()
  await expect(moto.getByRole('heading', {name: 'Stay connected'})).toHaveCount(0)
  expect(await moto.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false)
})

test('a long press on a message opens its reactions, and the phone can react and be reacted to', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Reactions')
  await connected(moto)
  await send(desk, 'press me')
  const bubble = moto.locator('.theirs', {hasText: 'press me'})
  await expect(bubble).toBeVisible()

  // A real touch held in place, sent through the debugger.
  const box = (await bubble.boundingBox())!
  const point = {x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2)}
  const session = await moto.context().newCDPSession(moto)
  await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]})
  await sleep(800)
  await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []})

  // The menu opens, stays open once the finger lifts, fits the screen, and no text got selected.
  const menu = moto.locator('.menu')
  await expect(menu).toBeVisible()
  await sleep(500)
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  const width = await moto.evaluate(() => innerWidth)
  expect(menuBox.x).toBeGreaterThanOrEqual(0)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width)
  expect(await moto.evaluate(() => getSelection()?.toString() ?? '')).toBe('')

  await moto.getByRole('button', {name: 'React ❤️'}).tap()
  await expect(desk.locator('.mine', {hasText: 'press me'}).getByRole('button', {name: '❤️ from Moto'})).toBeVisible()

  // The desk agrees; the phone shows a count of two, with its own marked.
  await desk.locator('.mine', {hasText: 'press me'}).locator('.reactions button').click()
  await expect(bubble.locator('.reactions .own')).toHaveText('❤️2')
})

test('the phone sends a picture and receives one', async ({browser}) => {
  const desk = await newDesk(browser)
  await deskInvitesMoto(desk, 'Pictures')
  await connected(moto)
  const photo = (page: Page, width: number, height: number) =>
    page
      .evaluate(
        ([w, h]) => {
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const context = canvas.getContext('2d')!
          context.fillStyle = '#28f'
          context.fillRect(0, 0, w, h)
          context.fillStyle = '#fd0'
          context.fillRect(w / 4, h / 4, w / 2, h / 2)
          return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
        },
        [width, height]
      )
      .then(base64 => ({name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64')}))

  // From the phone: shrunk on the phone itself before it leaves.
  await moto.getByLabel('Pictures to add').setInputFiles(await photo(desk, 3200, 2400))
  await expect(moto.getByRole('img', {name: 'Picture 1 to send'})).toBeVisible({timeout: 20_000})
  await moto.getByLabel('Message').fill('from the phone')
  await moto.getByRole('button', {name: 'Send'}).click()
  const atDesk = desk.locator('.theirs.image img.full')
  await expect(atDesk).toBeVisible({timeout: 30_000})
  await expect.poll(() => atDesk.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1600, 1200])
  await expect(desk.locator('.theirs.image')).toContainText('from the phone')

  // To the phone: it shows, fits the screen, and opens full screen on a tap.
  await desk.getByLabel('Pictures to add').setInputFiles(await photo(desk, 900, 1600))
  await expect(desk.getByRole('img', {name: 'Picture 1 to send'})).toBeVisible()
  await desk.getByRole('button', {name: 'Send'}).click()
  const atMoto = moto.locator('.theirs.image')
  await expect(atMoto.locator('img.full')).toBeVisible({timeout: 30_000})
  const box = (await atMoto.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(await moto.evaluate(() => innerWidth))
  await atMoto.locator('.picture').tap()
  await expect(moto.getByRole('dialog', {name: 'Picture'})).toBeVisible()
  await moto.getByRole('button', {name: 'Close picture'}).tap()
  await expect(moto.getByRole('dialog', {name: 'Picture'})).toHaveCount(0)

  // Both are still there after a reload.
  await moto.reload()
  await expect(moto.locator('.log .image img.full')).toHaveCount(2, {timeout: 30_000})
})
