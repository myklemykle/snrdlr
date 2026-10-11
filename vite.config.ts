import {defineConfig} from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  // Relative asset paths, so the build works under any GitHub Pages subpath.
  base: './',
  plugins: [preact()]
})
