import {defineConfig} from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  // Pairing goes through public Nostr relays, so allow for slow signaling.
  timeout: 90_000,
  use: {baseURL: 'http://localhost:4173'},
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true
  }
})
