import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'src/web/electron-shim.ts')
    }
  },
  ssr: {
    // 别名指向源码，必须打进包里，不能当成 npm 上的 electron 外置。
    noExternal: ['electron']
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: resolve(__dirname, 'out/web-server'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/web/server.ts'),
      output: {
        format: 'cjs',
        entryFileNames: 'server.cjs'
      }
    }
  }
})
