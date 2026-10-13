import {defineConfig} from '@playwright/test'
import base from './playwright.config'

// Runs the app on a real Android phone attached by USB, paired with a desktop browser on this machine.
// The phone reaches the test build and the local relay through adb's reverse tunnels, so it uses its own
// storage for http://localhost and never touches the live site's chats. See e2e-android/phone.ts.
export default defineConfig({
  ...base,
  testDir: 'e2e-android',
  timeout: 180_000,
  retries: 0,
  globalSetup: './e2e-android/setup.ts',
  webServer: (base.webServer as NonNullable<typeof base.webServer> & unknown[]).map(server => ({...server, reuseExistingServer: true}))
})
