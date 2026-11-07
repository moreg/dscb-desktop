import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

// Opt-in live generation, isolated fixtures, no user-project writes.
const root = resolve(process.env.CONTINUATION_AB_DIR || `scratch/continuation-quality-ab/2026-11-07-${Date.now()}`)
await mkdir(root, { recursive: true })
if ((await readdir(root)).some(name => name.endsWith('-raw.txt'))) {
  throw new Error('This directory already contains raw model outputs; choose a new CONTINUATION_AB_DIR to preserve them.')
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const promptFiles = ['src/main/data/write-service.ts', 'src/main/data/skill-prompts/index.ts',
  'src/main/data/skill-prompts/chapter-rules.ts', 'src/main/data/skill-prompts/scene-naturalness.ts']
const provenance = { baselineRevision: revision, files: [] }
for (const variant of ['before', 'after']) {
  const sources = new Map()
  for (const file of promptFiles) {
    const source = variant === 'before' ? execFileSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8' }) : await readFile(file, 'utf8')
    sources.set(resolve(file), source)
    const saved = join(root, 'sources', variant, file)
    await mkdir(resolve(saved, '..'), { recursive: true })
    await writeFile(saved, source)
    provenance.files.push({ variant, file, sha256: createHash('sha256').update(source).digest('hex') })
  }
  await build({ stdin: { contents: `export { buildSystemPrompt } from './src/main/data/skill-prompts/index'; export { renderComparisonUserPrompt } from './src/main/data/write-service';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(root, `${variant}-prompts.cjs`), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    plugins: [{ name: `frozen-${variant}-prompt-sources`, setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async args => {
        let contents = sources.get(args.path)
        if (contents === undefined) return
        if (relative(process.cwd(), args.path).replaceAll('\\', '/') === 'src/main/data/write-service.ts') {
          contents += '\nexport { renderUserPrompt as renderComparisonUserPrompt };\n'
        }
        return { contents, loader: 'ts' }
      })
    } }] })
}
await writeFile(join(root, 'provenance.json'), JSON.stringify(provenance, null, 2))
const entry = join(root, 'harness.cjs')
await build({ entryPoints: ['scripts/continuation-quality-ab.ts'], outfile: entry, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'] })
const env = { ...process.env, CONTINUATION_AB_DIR: root }
delete env.ELECTRON_RUN_AS_NODE
console.log(`Comparison artifacts: ${root}`)
const child = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code || 0 })
