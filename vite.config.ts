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

const build = buildStamp()

export default defineConfig({
  // Relative asset paths, so the build works under any GitHub Pages subpath.
  base: './',
  plugins: [
    preact(),
    {
      // Published beside the app so that an open tab can tell when a newer build is out (src/update.ts).
      name: 'version-file',
      generateBundle() {
        this.emitFile({type: 'asset', fileName: 'version.json', source: JSON.stringify({build})})
      }
    }
  ],
  // Small files would otherwise be folded into the script itself. The shortest sounds are that small,
  // and would then be downloaded by everyone, whichever sound set they use.
  build: {assetsInlineLimit: 0},
  define: {__BUILD__: JSON.stringify(build)}
})
