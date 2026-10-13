// Drives Chrome on an Android phone attached by USB: adb for the device, Chrome's remote debugging for the page.
import {execFileSync} from 'node:child_process'
import {chromium, type Browser, type Page} from '@playwright/test'

export const APP_PORT = 4173
export const RELAY_PORT = 7777
const DEVTOOLS_PORT = 9222
const APP = `http://localhost:${APP_PORT}`
const CHROME = 'com.android.chrome/com.google.android.apps.chrome.Main'

export function adb(...args: string[]): string {
  return execFileSync('adb', args, {encoding: 'utf8', timeout: 20_000}).trim()
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Tunnels the app, the relay and Chrome's debugging port, and checks the phone is usable. */
export function prepareDevice() {
  const devices = adb('devices').split('\n').slice(1).filter(line => line.trim())
  if (devices.length !== 1 || !devices[0].endsWith('device')) {
    throw new Error(`Expected one authorized Android device, got: ${devices.join('; ') || 'none'}`)
  }
  if (!/mWakefulness=Awake/.test(adb('shell', 'dumpsys', 'power')) || /isKeyguardShowing=true/.test(adb('shell', 'dumpsys', 'window'))) {
    throw new Error('Unlock the phone and keep its screen on before running these tests.')
  }
  adb('reverse', `tcp:${APP_PORT}`, `tcp:${APP_PORT}`)
  adb('reverse', `tcp:${RELAY_PORT}`, `tcp:${RELAY_PORT}`)
  adb('forward', `tcp:${DEVTOOLS_PORT}`, 'localabstract:chrome_devtools_remote')
}

/** Brings Chrome to the front as it was left. (Opening a link from outside would replace the tab under test.) */
export function openChrome() {
  adb('shell', 'am', 'start', '-n', CHROME)
}

export const pressHome = () => adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
export const setWifi = (on: boolean) => adb('shell', 'svc', 'wifi', on ? 'enable' : 'disable')

export type Phone = {page: Page; browser: Browser}

async function attach(): Promise<Phone> {
  let browser: Browser | undefined
  for (let attempt = 0; !browser; attempt++) {
    await sleep(1000)
    try {
      adb('forward', `tcp:${DEVTOOLS_PORT}`, 'localabstract:chrome_devtools_remote')
      browser = await chromium.connectOverCDP(`http://localhost:${DEVTOOLS_PORT}`, {timeout: 10_000})
    } catch (error) {
      if (attempt >= 15) throw error
    }
  }
  const page = browser.contexts()[0].pages().find(candidate => candidate.url().startsWith(APP))
  if (!page) throw new Error('The app tab is not open on the phone.')
  return {page, browser}
}

/** Connects to the phone's Chrome and returns the app's tab, with the app's storage wiped. */
export async function connectPhone(): Promise<Phone> {
  // Chrome is restarted on the test app's tab. Its other tabs stay, but are not loaded until visited;
  // attaching to a phone full of live background tabs hangs.
  adb('shell', 'am', 'force-stop', 'com.android.chrome')
  adb('shell', 'am', 'start', '-n', CHROME, '-a', 'android.intent.action.VIEW', '-d', `${APP}/`)
  const phone = await attach()
  await resetApp(phone.page)
  return phone
}

/**
 * Sends the phone to its home screen for a while, then brings Chrome back. The debugger is detached
 * throughout: while attached it makes the page believe it is always visible, which would hide the very
 * thing being tested. Returns a fresh connection; the old page object is dead.
 */
export async function away(phone: Phone, ms: number, meanwhile: () => Promise<void> = async () => {}): Promise<Phone> {
  await phone.browser.close()
  pressHome()
  const until = Date.now() + ms
  await sleep(ms / 2)
  await meanwhile()
  await sleep(Math.max(0, until - Date.now()))
  openChrome()
  // The app gets a moment on its own to notice it is back before anything looks at it.
  await sleep(1500)
  return attach()
}

/** Forgets the test app's identity and chats on the phone. Only http://localhost storage is touched. */
export async function resetApp(page: Page) {
  // Leave the app first, so nothing holds its database open while it is cleared.
  await page.goto('about:blank')
  const session = await page.context().newCDPSession(page)
  await session.send('Storage.clearDataForOrigin', {origin: APP, storageTypes: 'all'})
  await session.detach()
  await page.goto(`${APP}/`)
  // The app is invite-only; these tests start from someone who has been invited before.
  await page.evaluate(() => localStorage.setItem('snrdlr.invited', '1'))
  await page.reload()
}

/** Clicks a copy button and returns what it copied, without needing clipboard permission on the phone. */
export async function copiedBy(page: Page, buttonName: string): Promise<string> {
  await page.evaluate(() => {
    navigator.clipboard.writeText = async text => {
      ;(window as unknown as {copied: string}).copied = text
    }
  })
  await page.getByRole('button', {name: buttonName}).click()
  return page.evaluate(() => (window as unknown as {copied: string}).copied)
}
