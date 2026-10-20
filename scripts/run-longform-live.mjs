import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(process.env.LONGFORM_LIVE_DIR || `scratch/longform-live/run-${Date.now()}`)
await mkdir(root, { recursive: true })
const entry = join(root, 'harness.cjs')
await build({ entryPoints: ['scripts/longform-live.ts'], outfile: entry, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'] })
const require = createRequire(import.meta.url)
const env = { ...process.env, LONGFORM_LIVE_DIR: root }
delete env.ELECTRON_RUN_AS_NODE
console.log(`Live model calls enabled. Isolated results: ${root}`)
const child = spawn(require('electron'), [entry], { env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code || 0 })
