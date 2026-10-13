import {defineConfig} from '@playwright/test'

// The test build talks only to a relay on this machine and skips TURN, so runs touch no public service.
const RELAY_PORT = 7777
const APP_PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // One worker: every test pairs browsers through the same local relay and port.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    // Without mDNS, two browsers on one machine can always find each other's local address, CI included.
    launchOptions: {args: ['--disable-features=WebRtcHideLocalIpsWithMdns']}
  },
  webServer: [
    {
      command: 'npm run relay',
      env: {RELAY_PORT: String(RELAY_PORT)},
      port: RELAY_PORT,
      reuseExistingServer: true
    },
    {
      command: `vite build --outDir dist-e2e && vite preview --outDir dist-e2e --port ${APP_PORT} --strictPort`,
      // A short join timeout keeps the stale-invite test quick.
      env: {VITE_NOSTR_RELAYS: `ws://localhost:${RELAY_PORT}`, VITE_TURN_URL: '', VITE_JOIN_TIMEOUT_MS: '4000', VITE_UPDATE_IDLE_MS: '1500'},
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: false
    }
  ]
})
