import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { WriteService } from '../src/main/data/write-service'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { TrackingMdRepo } from '../src/main/data/skill-format/tracking-md-repo'
import { SettingsMdRepo } from '../src/main/data/skill-format/settings-md-repo'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
import type { ProjectService } from '../src/main/data/project-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { Character, PrevEndingState } from '../src/shared/types'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(complete => { resolve = complete })
  return { promise, resolve }
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'chapter-context-performance-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})
function service() {
  const projects = { resolveDir: async () => dir } as unknown as ProjectService
  const llm = { generateStream: vi.fn() } as unknown as LlmService
  return new WriteService(projects, llm) as unknown as {
    loadChapterContext(dir: string, chapter: number, options?: { needEndingState?: boolean }): Promise<{ prevProse: string; prevEndingState?: PrevEndingState; characters: Character[] }>
  }
}
const ending: PrevEndingState = { chapterNumber: 1, characterPositions: [], characterStates: [], timePoint: '', unfinished: [], suspense: '', props: [] }

describe('chapter context preparation', () => {
  it('starts independent local reads and ending extraction before any blocked read finishes', async () => {
    const local = deferred<void>()
    const model = deferred<PrevEndingState>()
    const started = new Set<string>()
    vi.spyOn(CharacterRepo.prototype, 'list').mockImplementation(async () => { started.add('characters'); await local.promise; return [] })
    vi.spyOn(TrackingMdRepo.prototype, 'read').mockImplementation(async () => { started.add('tracking'); await local.promise; return null })
    vi.spyOn(SettingsMdRepo.prototype, 'read').mockImplementation(async () => { started.add('settings'); await local.promise; return null })
    vi.spyOn(ProseRepo.prototype, 'read').mockResolvedValue('上章真实正文。')
    vi.spyOn(WriteFlowService.prototype, 'extractEndingState').mockImplementation(async () => { started.add('model'); return model.promise })
    const preparation = service().loadChapterContext(dir, 2, { needEndingState: true })
    try {
      await vi.waitFor(() => expect([...started]).toEqual(expect.arrayContaining(['characters', 'tracking', 'settings', 'model'])))
    } finally {
      local.resolve()
      model.resolve(ending)
    }
    expect(await preparation).toMatchObject({ prevProse: '上章真实正文。', prevEndingState: ending })
  })

  it('loads only the current and previous outline files', async () => {
    const root = join(dir, '细纲')
    await fs.mkdir(root)
    for (let chapter = 1; chapter <= 30; chapter++) {
      await fs.writeFile(join(root, '细纲_第' + String(chapter).padStart(3, '0') + '章_测试.md'), '# 测试\n\n## 第 ' + chapter + ' 章：测试\n- **核心事件**：事件' + chapter)
    }
    const readAll = vi.spyOn(DetailedOutlineMdRepo.prototype, 'listAll')
    const reads = vi.spyOn(fs, 'readFile')
    await service().loadChapterContext(dir, 20)
    expect(readAll).not.toHaveBeenCalled()
    const outlines = reads.mock.calls.map(([file]) => String(file)).filter(file => dirname(file) === root)
    expect(outlines.sort()).toEqual([join(root, '细纲_第019章_测试.md'), join(root, '细纲_第020章_测试.md')])
  })

  it('shares one ending-state model call across overlapping preparations', async () => {
    const model = deferred<PrevEndingState>()
    vi.spyOn(ProseRepo.prototype, 'read').mockResolvedValue('相同上章正文。')
    const extraction = vi.spyOn(WriteFlowService.prototype, 'extractEndingState').mockReturnValue(model.promise)
    const writing = service()
    const first = writing.loadChapterContext(dir, 2, { needEndingState: true })
    const second = writing.loadChapterContext(dir, 2, { needEndingState: true })
    await vi.waitFor(() => expect(extraction).toHaveBeenCalledTimes(1))
    model.resolve(ending)
    await Promise.all([first, second])
    expect(extraction).toHaveBeenCalledTimes(1)
  })

  it('rechecks historical boundaries after model waiting when later prose is saved', async () => {
    await new CharacterRepo(dir).create({ name: '角色', identity: '未来身份' })
    const model = deferred<PrevEndingState>()
    const cardsLoaded = deferred<void>()
    const readCharacters = CharacterRepo.prototype.list
    vi.spyOn(CharacterRepo.prototype, 'list').mockImplementation(async function(this: CharacterRepo) {
      const characters = await readCharacters.call(this)
      cardsLoaded.resolve()
      return characters
    })
    vi.spyOn(ProseRepo.prototype, 'read').mockResolvedValue('上章真实正文。')
    const extraction = vi.spyOn(WriteFlowService.prototype, 'extractEndingState').mockReturnValue(model.promise)
    const preparation = service().loadChapterContext(dir, 2, { needEndingState: true })
    await cardsLoaded.promise
    await vi.waitFor(() => expect(extraction).toHaveBeenCalledTimes(1))
    await fs.mkdir(join(dir, '正文'), { recursive: true })
    await fs.writeFile(join(dir, '正文', '002.md'), '后来保存的正文。')
    model.resolve(ending)
    const context = await preparation
    expect(context.characters.find(character => character.name === '角色')?.identity).toBeUndefined()
  })
})
