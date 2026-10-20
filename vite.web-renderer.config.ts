import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  publicDir: resolve(__dirname, 'build'),
  plugins: [
    react(),
    {
      name: 'dscb-web-flag',
      transformIndexHtml(html) {
        return html.replace('<body>', '<body>\n    <script src="/web-flag.js"></script>')
      }
    }
  ],
  build: {
    outDir: resolve(__dirname, 'out/web/renderer'),
    emptyOutDir: true
  }
})
