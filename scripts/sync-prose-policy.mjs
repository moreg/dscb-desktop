import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skills = resolve(process.argv.find(arg => arg.startsWith('--skills='))?.slice(9) ?? join(app, '..', '技能'))
const check = process.argv.includes('--check')
const raw = await readFile(join(app, 'src/shared/prose-policy.json'), 'utf8')
const policy = JSON.parse(raw)
const markdown = `# 正文保真与逐章检测\n\n规则版本：${policy.version}。\n\n` +
  ['paragraphs', 'dialogueParagraphs', 'punctuation', 'dialogue', 'preservation', 'detection', 'readerNoteBoundary'].map(key => policy[key]).join('\n\n') + '\n'
const names = new Set(['正文写作', '正文审核', '细纲生成', '细纲审核', '小说立项', '大纲审核'])
const targets = [join(skills, '正文规则源.json')]
async function visit(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['node_modules', '.git', 'tests', 'sync-backups'].includes(entry.name)) continue
    const dir = join(folder, entry.name)
    if (names.has(entry.name)) {
      try {
        await readFile(join(dir, 'SKILL.md'))
        targets.push(join(dir, 'references/正文保真与逐章检测.md'))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await visit(dir)
  }
}
await visit(skills)
await visit(join(app, '.agents/skills'))
const mismatches = []
for (const file of targets) {
  const expected = file.endsWith('.json') ? raw : markdown
  if (check) {
    const actual = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (actual !== expected) mismatches.push(file)
  } else {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, expected, 'utf8')
  }
}
if (mismatches.length) throw new Error(`规则副本不一致：\n${mismatches.join('\n')}`)
console.log(`${check ? '校验' : '同步'} ${targets.length} 份规则，版本 ${policy.version}。`)
