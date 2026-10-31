// Real configured models, real existing project, full backup before the first run.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, copyFile, readFile, writeFile, cp, access } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = key => args[args.indexOf(key) + 1]
if (!args.includes('--project') || !args.includes('--output')) throw new Error('Required: --project <existing book> --output <run directory>')
const project = resolve(option('--project'))
const root = resolve(option('--output'))
if (root === project || root.startsWith(project + sep)) throw new Error('The run directory must be outside the book')
const source = join(process.env.APPDATA, 'ai-writer-desktop')
await mkdir(join(root, 'profile', 'config'), { recursive: true })
const manifestFile = join(root, 'manifest.json')
const prior = await readFile(manifestFile, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
if (prior && prior.project !== project) throw new Error('Existing run belongs to another book')
if (!prior) {
  await access(join(project, '正文'))
  const library = JSON.parse(await readFile(join(source, 'library.json'), 'utf8'))
  const entry = library.projects.find(p => resolve(p.path).toLowerCase() === project.toLowerCase())
  if (!entry) throw new Error('Project is not in the current library')
  await cp(project, join(root, 'before'), { recursive: true, errorOnExist: true, force: false })
  await copyFile(join(source, 'Local State'), join(root, 'profile', 'Local State'))
  await copyFile(join(source, 'config', 'settings.json'), join(root, 'profile', 'config', 'settings.json'))
  await copyFile(join(source, 'config', 'providers.enc'), join(root, 'profile', 'config', 'providers.enc'))
  await writeFile(join(root, 'library.json'), JSON.stringify({ schemaVersion: 1, projects: [entry] }, null, 2))
  await writeFile(manifestFile, JSON.stringify({ project, projectId: entry.id, backup: join(root, 'before'), source,
    startedAt: new Date().toISOString(), fromChapter: 2, toChapter: 3 }, null, 2))
}
await build({ entryPoints: ['scripts/chapter-local-repair-live.ts'], outfile: join(root, 'harness.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const env = { ...process.env, CHAPTER_RECOVERY_LIVE_DIR: root }
delete env.ELECTRON_RUN_AS_NODE
console.log(`LIVE_RECOVERY ${root}`)
const child = spawn(require('electron'), [join(root, 'harness.cjs')], { env, stdio: 'inherit', windowsHide: true })
await writeFile(join(root, 'process.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code || 0 })
