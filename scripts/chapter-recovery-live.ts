import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import assert from 'node:assert/strict'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { UsageRepository } from '../src/main/data/usage-repository'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { WriteService } from '../src/main/data/write-service'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { BenchmarkResolver } from '../src/main/data/teardown/benchmark-resolver'
import { TeardownRepository } from '../src/main/data/teardown/teardown-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import { readLongformReviewState, blockedLongformChapters } from '../src/main/data/longform-review-state'
import { writeJsonAtomic } from '../src/main/data/atomic'
import { countWords } from '../src/main/data/words'

const root = resolve(process.env.CHAPTER_RECOVERY_LIVE_DIR!)
app.setPath('userData', join(root, 'profile'))
let logTail = Promise.resolve()
function event(kind: string, value: object = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, ...value })
  console.log(line)
  logTail = logTail.then(() => fs.appendFile(join(root, 'events.jsonl'), line + '\n'))
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(join(root, 'manifest.json'), 'utf8'))
  const dir = manifest.project as string, id = manifest.projectId as string
  const attemptsDir = join(root, `attempt-${Date.now()}`)
  await fs.mkdir(join(attemptsDir, 'calls'), { recursive: true })
  await writeJsonAtomic(join(root, 'latest-attempt.json'), { directory: attemptsDir })
  const secret = new SecretStore(join(root, 'profile', 'config', 'providers.enc'))
  const config = await secret.read()
  await writeJsonAtomic(join(root, 'models.json'), { activeId: config.activeId,
    providers: config.providers.map(({ id, label, model, protocol }) => ({ id, label, model, protocol })),
    featureRouting: config.featureRouting })
  assert(config.providers.length, 'No configured models')
  const settings = new SettingsRepository(join(root, 'profile', 'config', 'settings.json'))
  const projects = new ProjectService(join(root, 'unused-projects'), new LibraryRepository(join(root, 'library.json')), settings)
  assert.equal(resolve(await projects.resolveDir(id)), resolve(dir))
  const llm = new LlmService(secret, new UsageRepository(join(root, 'usage')))
  const original = llm.generateStream.bind(llm)
  const calls: Array<{ sequence: number; feature: string; chapter?: number; startedAt: string; ms?: number; chars?: number; error?: string }> = []
  llm.generateStream = async (prompt, opts = {}) => {
    const call = { sequence: calls.length + 1, feature: opts.meta?.feature ?? 'unknown',
      chapter: opts.meta?.chapterNumber, startedAt: new Date().toISOString() } as typeof calls[number]
    calls.push(call)
    if (call.feature === 'chapter' && call.chapter === 3) {
      assert(!blockedLongformChapters(await readLongformReviewState(dir))['2'], 'Chapter 3 was generated before chapter 2 recovery completed')
      event('chapter-2-recovered-before-chapter-3')
    }
    const stem = `${String(call.sequence).padStart(3, '0')}-${call.feature.replace(/[^a-z0-9_-]/gi, '_')}`
    await fs.writeFile(join(attemptsDir, 'calls', `${stem}-input.txt`), `${opts.systemPrompt ?? ''}\n\n${prompt}`)
    event('model-start', call)
    const started = Date.now()
    try {
      const answer = await original(prompt, opts)
      call.chars = answer.length
      await fs.writeFile(join(attemptsDir, 'calls', `${stem}-output.txt`), answer)
      return answer
    } catch (error) { call.error = (error as Error).message; throw error }
    finally { call.ms = Date.now() - started; event('model-end', call); await writeJsonAtomic(join(attemptsDir, 'calls.json'), calls) }
  }
  const chapters = new ChapterService(projects)
  const service = new WriteService(projects, llm, undefined, undefined, chapters, settings,
    new BenchmarkResolver(new TeardownRepository(join(manifest.source, 'teardown-library'))), new DeslopService(llm))
  const before2 = await new ProseRepo(dir).read(2)
  const before3 = await new ProseRepo(dir).read(3)
  const state = await readLongformReviewState(dir)
  assert(before2.trim(), 'Chapter 2 has no saved prose')
  await writeJsonAtomic(join(attemptsDir, 'before.json'), { state,
    chapter2: { hash: hashProse(before2), words: countWords(before2) }, chapter3: { hash: hashProse(before3), words: countWords(before3) } })
  // Resume an already-paid third-chapter draft after a failed prior attempt.
  // The first run starts at chapter 3 and exercises automatic recovery from its normal prompt path.
  if (before3.trim() && blockedLongformChapters(state)['2']) {
    const repaired = await service.repairQuarantinedChapters(id, () => {}, { onlyChapters: [2],
      onRepairProgress: (message, chapter) => event('recovery-progress', { chapter, message }) })
    assert(repaired.ok, JSON.stringify(repaired.failures))
  }
  const resultWrites: Promise<void>[] = []
  const progress = await service.generateChaptersBatch(id, 3, 3,
    (chapter, result) => { event('chapter-complete', { chapter }); resultWrites.push(writeJsonAtomic(join(attemptsDir, `chapter-${chapter}-result.json`), result)) },
    null, { onFlowProgress: (step, chapter) => event('flow', { chapter, step }),
      onGenerationStage: (stage, chapter) => event('stage', { chapter, stage }),
      onAutoDeslopResult: (report, chapter) => event('expression-check', { chapter, report }),
      onContentSaved: chapter => { event('prose-saved', { chapter }) } },
    before3.trim() ? { fromChapter: 3, total: 1, completed: [3], pendingPostProcessChapter: 3 } : undefined,
    { autoContinue: true })
  await Promise.all(resultWrites)
  const finalState = await readLongformReviewState(dir)
  const snapshots = []
  for (const chapter of [2, 3]) {
    const prose = await new ProseRepo(dir).read(chapter)
    const summary = await new ChapterSummaryRepo(dir).readCurrent(chapter, prose)
    snapshots.push({ chapter, hash: hashProse(prose), words: countWords(prose), summaryCurrent: !!summary,
      quarantined: !!blockedLongformChapters(finalState)[String(chapter)] })
    await fs.writeFile(join(attemptsDir, `chapter-${chapter}-final.md`), prose)
  }
  const report = { progress, snapshots, finalState, calls: calls.length, finishedAt: new Date().toISOString() }
  await writeJsonAtomic(join(attemptsDir, 'report.json'), report)
  await writeJsonAtomic(join(root, 'result.json'), report)
  event('result', report)
  assert.equal(progress.status, 'completed', progress.pauseReason ?? progress.error)
  assert(snapshots.every(s => s.words > 0 && s.summaryCurrent && !s.quarantined), 'Saved prose, summaries or quarantine checks incomplete')
}

app.whenReady().then(main).catch(async error => {
  event('fatal', { message: (error as Error).message })
  await writeJsonAtomic(join(root, 'last-error.json'), { message: (error as Error).message, at: new Date().toISOString() })
  process.exitCode = 1
}).finally(async () => { await logTail; app.exit(process.exitCode || 0) })
