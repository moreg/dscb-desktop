/** Opt-in live repair for a real project's paused chapter. Never imported by the unit test suite.
 * Bundle with esbuild --platform=node --external:electron; run using Electron.
 * Uses the real userData (decrypt providers.enc with the real key) and the production
 * resume path: reuse the saved prose, rerun all post-processing, never regenerate.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { readLongformReviewState } from '../src/main/data/longform-review-state'

const chapter = Number(process.env.REPAIR_CHAPTER || '68')
const projectName = process.env.REPAIR_PROJECT || ''
const source = join(app.getPath('appData'), 'ai-writer-desktop')
app.setPath('userData', source) // Chromium's existing secure-storage key is needed to decrypt providers.enc.

async function main(): Promise<number> {
  const settings = new SettingsRepository(join(source, 'config', 'settings.json'))
  const projectsRoot = await settings.getProjectsRoot(join(source, 'projects'))
  const secret = new SecretStore(join(source, 'config', 'providers.enc'))
  const llm = new LlmService(secret)
  const projects = new ProjectService(projectsRoot, new LibraryRepository(join(source, 'library.json')), settings)

  const all = await projects.listProjects()
  const project = projectName ? all.find((p) => p.name === projectName || p.id === projectName) : all[0]
  if (!project) throw new Error(`project not found: ${projectName || '(first)'}`)
  const id = project.id
  const dir = await projects.resolveDir(id)

  const prose = await new ProseRepo(dir).read(chapter)
  if (!prose.trim()) throw new Error(`第 ${chapter} 章正文不存在，无法按恢复路径补跑`)
  const before = await readLongformReviewState(dir)
  console.log(`[repair] project=${project.name} dir=${dir}`)
  console.log(`[repair] chapter=${chapter} proseChars=${prose.length}`)
  console.log(`[repair] quarantine before: pending=${Object.keys(before.pending)} batchPending=${Object.keys(before.batchPending ?? {})}`)

  const chapterService = new ChapterService(projects)
  const service = new WriteService(projects, llm, undefined, undefined, chapterService, settings,
    undefined, new DeslopService(llm))

  const result = await service.generateChaptersBatch(id, chapter, chapter, (ch, r) => {
    console.log(`[repair] chapter ${ch} done: outlineSynced=${r.outlineDiff?.proseSynced ?? '-'} ` +
      `memoryErrors=${r.memory?.errors?.length ?? 0} reviewRequired=${r.memoryApply?.reviewRequired?.length ?? 0} ` +
      `superseded=${String(r.memoryApply?.superseded ?? false)}`)
  }, null, {
    onGenerationStage: (stage) => console.log(`[stage] ${stage}`)
  }, { fromChapter: chapter, total: 1, completed: [chapter], pendingPostProcessChapter: chapter },
  { autoContinue: true })

  console.log(`[repair] batch status=${result.status}${result.pauseReason ? ` pauseReason=${result.pauseReason}` : ''}`)
  const after = await readLongformReviewState(dir)
  console.log(`[repair] quarantine after: pending=${Object.keys(after.pending)} batchPending=${Object.keys(after.batchPending ?? {})}`)
  const meta = (await chapterService.getChapter(id, chapter)).meta
  const summaryExists = await fs.access(join(dir, '记忆', '章节概要', `第${String(chapter).padStart(3, '0')}章.json`))
    .then(() => true, () => false)
  console.log(`[repair] chapter ${chapter}: status=${meta.status} words=${meta.wordCount} summaryExists=${summaryExists}`)
  return result.status === 'completed' ? 0 : 2
}

main()
  .then((code) => app.exit(code))
  .catch((err) => { console.error('[repair] FATAL', err); app.exit(1) })
