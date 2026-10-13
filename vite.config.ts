import {execSync} from 'node:child_process'
import {defineConfig} from 'vite'
import preact from '@preact/preset-vite'

// Shown on the home screen, so it is easy to tell which build a device is running.
function buildStamp(): string {
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim()
  } catch {
    // Not a git checkout.
  }
  return `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${commit}`
}

export default defineConfig({
  // Relative asset paths, so the build works under any GitHub Pages subpath.
  base: './',
  plugins: [preact()],
  // Small files would otherwise be folded into the script itself. The shortest sounds are that small,
  // and would then be downloaded by everyone, whichever sound set they use.
  build: {assetsInlineLimit: 0},
  define: {__BUILD__: JSON.stringify(buildStamp())}
})
