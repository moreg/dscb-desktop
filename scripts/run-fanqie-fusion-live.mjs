import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(process.env.FUSION_LIVE_DIR || `scratch/desktop-fusion-live-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(root, { recursive: true })
const outfile = join(root, 'harness.cjs')
await build({ entryPoints: ['scripts/fanqie-fusion-live.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'expose-production-parser-for-live-audit', setup(build) {
    if (process.env.FUSION_LIVE_TIMEOUT_MS) build.onLoad({ filter: /data[\\/]llm-service\.ts$/ }, async args => {
      const timeout = Number(process.env.FUSION_LIVE_TIMEOUT_MS)
      if (!Number.isInteger(timeout) || timeout < 600000 || timeout > 3600000) throw new Error('Invalid live test timeout')
      const text = await readFile(args.path, 'utf8')
      if (!text.includes('const LARGE_STREAM_TIMEOUT_MS = 600_000')) throw new Error('Timeout source changed')
      return { contents: text.replace('const LARGE_STREAM_TIMEOUT_MS = 600_000', `const LARGE_STREAM_TIMEOUT_MS = ${timeout}`), loader: 'ts' }
    })
    build.onLoad({ filter: /fanqie-chart[\\/]service\.ts$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')) + '\nexport { coerceIdeas }\n', loader: 'ts'
    }))
  } }] })
const require = createRequire(import.meta.url)
const env = { ...process.env, FUSION_LIVE_DIR: root }
delete env.ELECTRON_RUN_AS_NODE
console.log(`OUTPUT ${root}`)
const child = spawn(require('electron'), [outfile], { stdio: 'inherit', windowsHide: true, env })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
