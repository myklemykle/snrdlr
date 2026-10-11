import {defineConfig} from '@playwright/test'

// The test build talks only to a relay on this machine and skips TURN, so runs touch no public service.
const RELAY_PORT = 7777
const APP_PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {baseURL: `http://localhost:${APP_PORT}`},
  webServer: [
    {
      command: 'npm run relay',
      env: {RELAY_PORT: String(RELAY_PORT)},
      port: RELAY_PORT,
      reuseExistingServer: true
    },
    {
      command: `vite build --outDir dist-e2e && vite preview --outDir dist-e2e --port ${APP_PORT} --strictPort`,
      env: {VITE_NOSTR_RELAYS: `ws://localhost:${RELAY_PORT}`, VITE_TURN_URL: ''},
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: false
    }
  ]
})
