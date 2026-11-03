import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

// 对真实项目补跑指定章节的写后处理（生产恢复路径，不重新生成正文）。
// 用法：REPAIR_PROJECT=项目名 REPAIR_CHAPTER=68 node scripts/run-repair-chapter.mjs
const entry = 'scratch/repair-chapter-live.cjs'
await mkdir('scratch', { recursive: true })
await build({ entryPoints: ['scripts/repair-chapter-live.ts'], outfile: entry, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'] })
const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [entry], { env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code || 0 })
