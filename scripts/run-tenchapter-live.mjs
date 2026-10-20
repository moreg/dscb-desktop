// Starts the actual built desktop application. Force-kills only this isolated process tree,
// restarts it, and leaves the real renderer to restore its own persisted batch session.
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, copyFile, readFile, writeFile, cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const root = resolve(process.env.TENCHAPTER_LIVE_DIR || `scratch/tenchapter-live/run-${Date.now()}`)
const original = process.env.LONGFORM_USER_DATA || join(process.env.APPDATA, 'ai-writer-desktop')
await mkdir(join(root, 'profile', 'config'), { recursive: true })
await mkdir(join(root, 'calls'), { recursive: true })
const scenario = process.env.TENCHAPTER_SCENARIO || 'postprocess'
await writeFile(join(root, 'run-config.json'), JSON.stringify({scenario, startedAt:new Date().toISOString()},null,2))
if (!process.env.TENCHAPTER_LIVE_DIR) await copyFile(join(original, 'Local State'), join(root, 'profile', 'Local State'))
await build({ entryPoints: ['scripts/tenchapter-live-init.ts'], outfile: join(root, 'init.cjs'), bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'] })
await copyFile('scripts/tenchapter-live-bootstrap.cjs', join(root, 'bootstrap.cjs'))
const env = { ...process.env, TENCHAPTER_LIVE_DIR: root, LONGFORM_USER_DATA: original,
  TENCHAPTER_APP_MAIN: resolve('out/main/index.js') }
delete env.ELECTRON_RUN_AS_NODE
let child, stopping = false, quitting = false
const journal = await readFile(join(root, 'processes.json'), 'utf8').then(JSON.parse).catch(() => [])
async function start() {
  child = spawn(require('electron'), [join(root, 'bootstrap.cjs')], { env, stdio: 'inherit', windowsHide: true })
  journal.push({ event: 'start', pid: child.pid, time: new Date().toISOString() })
  await writeFile(join(root, `app-build-${child.pid}.json`), JSON.stringify({ main:env.TENCHAPTER_APP_MAIN,
    sha256:createHash('sha256').update(await readFile(env.TENCHAPTER_APP_MAIN)).digest('hex') },null,2))
  await writeFile(join(root, 'processes.json'), JSON.stringify(journal, null, 2))
  child.on('exit', async code => {
    journal.push({ event: 'exit', pid: child.pid, code, time: new Date().toISOString() })
    await writeFile(join(root, 'processes.json'), JSON.stringify(journal, null, 2))
    if (stopping) { stopping = false; await start() }
    else { console.log('APP_EXIT', code); process.exitCode = code || process.exitCode || 0; clearInterval(timer) }
  })
}
console.log(`TEN_CHAPTER_LIVE ${root}`)
const timer = setInterval(async () => {
  if (stopping || quitting || !child?.pid) return
  const final = await readFile(join(root, 'batch-result.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (final?.progress?.status === 'completed') {
    quitting = true
    await writeFile(join(root, 'command.json'), JSON.stringify({ action: 'quit' }))
    return
  }
  const flags = await Promise.all((scenario === 'entity-write' ? ['crash-ready-entity.json'] : ['crash-ready.json', 'crash-ready-seven.json']).map(file =>
    readFile(join(root, file), 'utf8').then(JSON.parse).catch(() => null)))
  const flag = flags.find(f => f?.pid === child.pid)
  if (!flag || stopping || flag.pid !== child.pid) return
  stopping = true
  journal.push({ event: 'force-kill', pid: child.pid, chapter: flag.chapter, time: new Date().toISOString() })
  console.log('FORCE_KILL_REAL_APP', child.pid, `chapter ${flag.chapter} postprocessing`)
  await writeFile(join(root, 'processes.json'), JSON.stringify(journal, null, 2))
  const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))
  await cp(project.path, join(root, scenario === 'entity-write' ? 'before-force-kill-entity' : flag.chapter === 7 ? 'before-force-kill-seven' : 'before-force-kill'), { recursive: true })
  await copyFile(join(root, 'ui-current.json'), join(root, `ui-before-force-kill-${flag.chapter}.json`))
  // Native Windows tree termination: no AbortController and no in-process service replacement.
  const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  writeFileSync(join(root, scenario === 'entity-write' ? 'kill-result-entity.json' : flag.chapter === 7 ? 'kill-result-7.json' : 'kill-result.json'),
    JSON.stringify({ pid: child.pid, chapter: flag.chapter, status: result.status, stdout: result.stdout, stderr: result.stderr }))
  if (result.status !== 0) {
    stopping = false
    process.exitCode = 1
    clearInterval(timer)
    await writeFile(join(root, 'command.json'), JSON.stringify({ action: 'quit' }))
  }
}, 500)
await start()
