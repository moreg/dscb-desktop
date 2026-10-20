import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
if (!process.env.TENCHAPTER_LIVE_DIR) throw new Error('Set TENCHAPTER_LIVE_DIR to the isolated test result directory')
const root = resolve(process.env.TENCHAPTER_LIVE_DIR)
const entry = join(root, 'audit.cjs')
await build({ entryPoints: ['scripts/tenchapter-live-audit.ts'], outfile: entry, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'] })
const env = { ...process.env, TENCHAPTER_LIVE_DIR: root }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [entry], { env, stdio: 'inherit', windowsHide: true })
child.on('exit', code => { process.exitCode = code || 0 })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
