import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { CoverLearningLibraryService, DEFAULT_COVER_LEARNING_LIBRARY } from '../src/main/data/cover-learning-library'
import { SettingsRepository } from '../src/main/data/settings-repository'
import type { LlmService } from '../src/main/data/llm-service'
import { analyzeCover } from '../src/main/data/cover-learning-analysis'
import { buildCoverPrompt, COVER_STYLE_PRESETS } from '../src/main/data/skill-prompts/cover/cover-styles'

const cleanup: string[] = []

async function fixture(llm?: Pick<LlmService, 'generateStream'>): Promise<{
  root: string
  service: CoverLearningLibraryService
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'cover-library-'))
  cleanup.push(root)
  const settings = new SettingsRepository(join(root, 'config', 'settings.json'))
  return {
    root,
    service: new CoverLearningLibraryService(settings, join(root, 'default-library'), llm as LlmService | undefined)
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('CoverLearningLibraryService', () => {
  it('仅迁移旧内置英文规则，保持原ID、禁用状态、自定义规则与磁盘文件', async () => {
    const { service } = await fixture()
    const first = await service.load()
    const oldRule = 'Use a portrait 3:4 master canvas and keep essential text inside the central 85% safe area.'
    const oldId = `builtin:${createHash('sha256').update(oldRule).digest('hex').slice(0, 16)}`
    const customRule = oldRule + ' AUTHOR EDIT: preserve the red umbrella.'
    const raw = JSON.parse(await fs.readFile(first.summary.filePath, 'utf-8'))
    raw.globalRules = [oldRule, customRule]
    raw.learning.ruleOverrides[oldId] = false
    const stored = JSON.stringify(raw, null, 2)
    await fs.writeFile(first.summary.filePath, stored)

    const result = await service.load()
    expect(result.summary.rules?.find((rule) => rule.id === oldId)).toMatchObject({ text: DEFAULT_COVER_LEARNING_LIBRARY.globalRules[0], source: 'builtin', enabled: false })
    expect(result.library.globalRules).toEqual([DEFAULT_COVER_LEARNING_LIBRARY.globalRules[0], customRule])
    expect(result.library.globalRules[0]).not.toContain('85%')
    expect(service.getRulesForGenre(result.library, 'urban')).toEqual([customRule])
    expect(await fs.readFile(first.summary.filePath, 'utf-8')).toBe(stored)
  })

  it('旧统计规则只迁移完整机械句型，保持ID、证据、停用与历史快照，历史AI英文不改', async () => {
    const { service } = await fixture()
    const first = await service.load()
    const oldRules = [
      'Observed local library: 100% of tracked covers use portrait composition; prioritize a tall mobile-first silhouette.',
      'Observed local library: 80% cluster near 9:16; adapt those composition patterns to the required 3:4 master ratio and central safe area.',
      'Observed local library favors saturated color separation; keep the focal subject and typography strongly differentiated.',
      'Observed local library favors soft tonal transitions; reserve a cleaner text field to protect readability.',
      'Observed local library has the lowest average visual-detail density in the upper third; consider it as the first typography candidate when it does not cover a face.',
      'Observed recurring dominant color families: red, blue; use them as evidence, not as a mandatory palette.'
    ]
    const raw = JSON.parse(await fs.readFile(first.summary.filePath, 'utf-8'))
    const known = oldRules.map((text, index) => ({ id: `statistics:general:${index}`, text, source: 'statistics', sampleCount: 5, enabled: false, evidence: ['evidence-1'] }))
    const edited = { ...known[0], id: 'statistics:general:edited', text: oldRules[0] + ' MY EDIT' }
    const ai = { ...known[0], id: 'ai:general:1', source: 'ai', text: 'CUSTOM OLD AI RULE' }
    raw.learning.generatedRules = [...known, edited, ai]
    raw.learning.ruleHistory = [{ updatedAt: 'old-snapshot', rules: known }]
    const stored = JSON.stringify(raw, null, 2)
    await fs.writeFile(first.summary.filePath, stored)
    const { library } = await service.load()
    for (const [index, rule] of library.learning.generatedRules.slice(0, known.length).entries()) {
      expect(rule.text).toMatch(/^本地样本观察：/)
      expect(rule.text).not.toMatch(/[a-z]/i)
      expect(rule).toMatchObject({ id: known[index].id, enabled: false, evidence: ['evidence-1'], source: 'statistics' })
    }
    expect(library.learning.generatedRules.slice(known.length)).toEqual([edited, ai])
    expect(library.learning.ruleHistory).toEqual(raw.learning.ruleHistory)
    expect(await fs.readFile(first.summary.filePath, 'utf-8')).toBe(stored)
  })

  it('首次使用时把 138 张样本的学习结果初始化为本地 JSON', async () => {
    const { service } = await fixture()
    const summary = await service.initialize()

    expect(summary.status).toBe('ready')
    expect(summary.sampleCount).toBe(138)
    expect(summary.categoryCount).toBe(23)
    expect(summary.styleCount).toBe(21)
    expect(summary.analyzedSampleCount).toBe(0)
    expect(summary.trackedSampleCount).toBe(0)
    expect(summary.legacySampleCount).toBe(138)
    expect(summary.rules?.filter((rule) => rule.source === 'builtin').every((rule) => /\p{Script=Han}/u.test(rule.text))).toBe(true)
    expect(JSON.parse(await fs.readFile(summary.filePath, 'utf-8')).name).toBe('番茄小说封面学习库')
  })

  it('每次生成前重新读盘，手工修改的风格和规则立即进入提示词', async () => {
    const { service } = await fixture()
    const first = await service.load()
    const raw = JSON.parse(await fs.readFile(first.summary.filePath, 'utf-8'))
    raw.styles.folk_horror.prompt = 'custom hand-edited paper-cut horror language'
    raw.globalRules = ['CUSTOM_LIBRARY_RULE: reserve a silent black band behind the title.']
    await fs.writeFile(first.summary.filePath, JSON.stringify(raw, null, 2), 'utf-8')

    const second = await service.load()
    const learned = service.resolveStyle(second.library, 'folk_horror', 'supernatural')
    const prompt = buildCoverPrompt({
      bookName: '夜路',
      authorName: '某某',
      platform: 'fanqie',
      genre: 'supernatural',
      composition: 'scene',
      stylePreset: learned.key,
      learningPreset: learned.definition,
      learningRules: second.library.globalRules
    })

    expect(prompt).toContain('custom hand-edited paper-cut horror language')
    expect(prompt).toContain('CUSTOM_LIBRARY_RULE')
  })

  it('auto 按题材使用学习库推荐风格', async () => {
    const { service } = await fixture()
    const { library } = await service.load()
    library.genreRecommendations.scifi = 'minimal_typographic'

    expect(service.resolveStyle(library, 'auto', 'scifi').key).toBe('minimal_typographic')
    expect(service.resolveStyle(library, 'game_neon', 'scifi').key).toBe('game_neon')
  })

  it('旧版学习库自动补全真人和二次元风格，并保留用户修改', async () => {
    const { service } = await fixture()
    const initialized = await service.initialize()
    const raw = JSON.parse(await fs.readFile(initialized.filePath, 'utf-8'))
    delete raw.styles.photorealistic
    delete raw.styles.anime_illustration
    raw.styles.folk_horror.prompt = 'CUSTOM_LEGACY_STYLE: hand-cut red paper silhouettes.'
    raw.globalRules = ['CUSTOM_LEGACY_RULE: keep a quiet band behind the title.']
    raw.genreRecommendations.urban = 'minimal_typographic'
    const stored = JSON.stringify(raw, null, 2)
    await fs.writeFile(initialized.filePath, stored, 'utf-8')

    const loaded = await service.load()

    expect(loaded.summary.status).toBe('ready')
    expect(loaded.summary.styleCount).toBe(21)
    expect(loaded.summary.sampleCount).toBe(138)
    expect(loaded.library.styles.folk_horror.prompt).toBe(raw.styles.folk_horror.prompt)
    expect(loaded.library.globalRules).toEqual(raw.globalRules)
    expect(service.resolveStyle(loaded.library, 'auto', 'urban').key).toBe('minimal_typographic')
    for (const key of ['photorealistic', 'anime_illustration'] as const) {
      const learned = service.resolveStyle(loaded.library, key, 'urban')
      expect(learned.key).toBe(key)
      expect(learned.definition).toEqual(COVER_STYLE_PRESETS[key])
      const prompt = buildCoverPrompt({
        bookName: '盛夏重逢',
        authorName: '某某',
        platform: 'fanqie',
        genre: 'urban',
        composition: 'closeup',
        stylePreset: learned.key,
        learningPreset: learned.definition,
        learningRules: loaded.library.globalRules
      })
      expect(prompt).toContain(COVER_STYLE_PRESETS[key].prompt)
      expect(prompt).toContain('CUSTOM_LEGACY_RULE')
    }
    expect(await fs.readFile(initialized.filePath, 'utf-8')).toBe(stored)
  })

  it('损坏的用户文件不被覆盖，并安全回退到内置库', async () => {
    const { service } = await fixture()
    const initialized = await service.initialize()
    await fs.writeFile(initialized.filePath, '{ broken json', 'utf-8')

    const loaded = await service.load()
    expect(loaded.summary.status).toBe('fallback')
    expect(loaded.summary.styleCount).toBe(21)
    for (const key of ['photorealistic', 'anime_illustration'] as const) {
      expect(service.resolveStyle(loaded.library, key, 'urban')).toEqual({
        key,
        definition: COVER_STYLE_PRESETS[key]
      })
    }
    expect(await fs.readFile(initialized.filePath, 'utf-8')).toBe('{ broken json')
  })

  it('可以迁移到用户选择的本地目录', async () => {
    const { root, service } = await fixture()
    const original = await service.load()
    original.library.globalRules.push('MIGRATION_SENTINEL_RULE')
    await fs.writeFile(original.summary.filePath, JSON.stringify(original.library, null, 2), 'utf-8')
    const selected = join(root, 'portable-cover-library')
    const summary = await service.setDirectory(selected)

    expect(summary.directory).toBe(selected)
    expect(summary.filePath).toBe(join(selected, 'cover-learning-library.json'))
    await expect(fs.access(summary.filePath)).resolves.toBeUndefined()
    expect(JSON.parse(await fs.readFile(summary.filePath, 'utf-8')).globalRules).toContain('MIGRATION_SENTINEL_RULE')
  })

  it('学习文件夹时按内容指纹去重，并把分析结果与任务记录写入学习库', async () => {
    const { root, service } = await fixture()
    const covers = join(root, 'covers')
    const nested = join(covers, 'nested')
    await fs.mkdir(nested, { recursive: true })
    const red = join(covers, 'red.png')
    const renamedCopy = join(nested, '同一张图改名.png')
    const resizedCopy = join(nested, '同一张图缩放版.png')
    const similarButDifferent = join(nested, '相近颜色但不同封面.png')
    const blue = join(nested, 'blue.png')
    await createPatternCover(red, '#d64025')
    await fs.copyFile(red, renamedCopy)
    await createPatternCover(resizedCopy, '#d64025', 576, 768)
    await createPatternCover(similarButDifferent, '#d54025')
    await createPatternCover(blue, '#2255aa')
    await fs.writeFile(join(covers, 'broken.jpg'), 'not an image', 'utf-8')

    const first = await service.learnFolder(covers)
    expect(first.scanned).toBe(6)
    expect(first.learned).toBe(3)
    expect(first.duplicates).toBe(2)
    expect(first.failed).toBe(1)
    expect(first.summary.sampleCount).toBe(141)
    expect(first.summary.trackedSampleCount).toBe(3)
    expect(first.summary.learningRunCount).toBe(1)
    expect(first.observations.length).toBeGreaterThan(0)

    const second = await service.learnFolder(covers)
    expect(second.learned).toBe(0)
    expect(second.duplicates).toBe(5)
    expect(second.failed).toBe(1)
    expect(second.summary.sampleCount).toBe(141)
    expect(second.summary.trackedSampleCount).toBe(3)
    expect(second.summary.learningRunCount).toBe(2)

    const stored = JSON.parse(await fs.readFile(second.summary.filePath, 'utf-8'))
    expect(stored.learning.samples).toHaveLength(3)
    expect(stored.learning.runs).toHaveLength(2)
    expect(stored.learning.generatedRules).toHaveLength(0)
    expect(stored.globalRules.some((rule: string) => rule.startsWith('本地样本观察'))).toBe(false)
  })

  it('首批 138 张旧样本重新选择时按迁移指纹跳过，不重复增加总数', async () => {
    const { root, service } = await fixture()
    const folder = join(root, 'legacy-covers')
    await fs.mkdir(folder, { recursive: true })
    await fs.copyFile(
      join(process.cwd(), 'research', 'fanqie-cover-study', '2026-07-31', 'images', 'female-ancient-society', '01.jpg'),
      join(folder, '改过名字的旧封面.jpg')
    )

    const result = await service.learnFolder(folder)
    expect(result.learned).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.summary.sampleCount).toBe(138)
    expect(result.summary.trackedSampleCount).toBe(1)
    expect(result.summary.legacySampleCount).toBe(138)
  })

  it('学习过程中请求切换目录时排队迁移，学习结果不会留在失效目录', async () => {
    const { root, service } = await fixture()
    const covers = join(root, 'race-covers')
    await fs.mkdir(covers, { recursive: true })
    await createPatternCover(join(covers, 'new.png'), '#319966')
    const destination = join(root, 'moved-library')

    const learning = service.learnFolder(covers)
    const moving = service.setDirectory(destination)
    await learning
    const moved = await moving

    expect(moved.directory).toBe(destination)
    expect(moved.sampleCount).toBe(139)
    expect(moved.trackedSampleCount).toBe(1)
    expect(JSON.parse(await fs.readFile(moved.filePath, 'utf-8')).learning.samples).toHaveLength(1)
  })

  it('超过两万条指纹记录后重新加载不会静默截断', async () => {
    const { service } = await fixture()
    const loaded = await service.load()
    const raw = JSON.parse(await fs.readFile(loaded.summary.filePath, 'utf-8'))
    const metrics = {
      width: 90,
      height: 160,
      aspectRatio: 9 / 16,
      averageRgb: [100, 100, 100],
      luminance: 0.4,
      saturation: 0,
      contrast: 0.2,
      warmth: 0,
      detailByBand: [0.1, 0.1, 0.1],
      dominantColor: 'neutral',
      perceptualHash: '',
      visualFingerprint: ''
    }
    raw.learning.samples = Array.from({ length: 20_001 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'),
      relativePath: `${index}.png`,
      sourceDirectory: 'fixture',
      learnedAt: '2026-07-31T00:00:00.000Z',
      metrics
    }))
    await fs.writeFile(loaded.summary.filePath, JSON.stringify(raw), 'utf-8')

    expect((await service.load()).library.learning.samples).toHaveLength(20_001)
  })

  it('拒绝横图、极低分辨率和纯色，并保留损坏图片的具体原因', async () => {
    const { root, service } = await fixture()
    const folder = join(root, 'invalid-covers')
    await fs.mkdir(folder)
    await createPatternCover(join(folder, 'landscape.png'), '#aa2244', 384, 288)
    await createPatternCover(join(folder, 'tiny.png'), '#224488', 60, 80)
    const { Canvas } = await import('skia-canvas')
    const solid = new Canvas(288, 384)
    solid.getContext('2d').fillStyle = '#ff0000'
    solid.getContext('2d').fillRect(0, 0, 288, 384)
    await fs.writeFile(join(folder, 'solid.png'), await solid.toBuffer('png'))
    await fs.writeFile(join(folder, 'broken.jpg'), 'broken image')
    await createPatternCover(join(folder, 'valid.png'), '#118855')
    const result = await service.learnFolder(folder)
    expect(result).toMatchObject({ scanned: 5, learned: 1, rejected: 3, failed: 1, aiStatus: 'off' })
    expect(result.issues).toHaveLength(4)
    expect(result.issues?.every((issue) => issue.path.length > 0 && issue.reason.length > 0)).toBe(true)
    expect(result.summary.rules?.filter((rule) => rule.source === 'statistics')).toHaveLength(0)
    const stored = JSON.parse(await fs.readFile(result.summary.filePath, 'utf-8'))
    expect(stored.learning.runs[0].issues).toHaveLength(4)
  })

  it('主色从实际像素色族统计，红蓝拼色不会虚构紫色主色', async () => {
    const { root } = await fixture()
    const { Canvas } = await import('skia-canvas')
    const canvas = new Canvas(288, 384)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ff0000'
    context.fillRect(0, 0, 144, 384)
    context.fillStyle = '#0000ff'
    context.fillRect(144, 0, 144, 384)
    const path = join(root, 'red-blue.png')
    await fs.writeFile(path, await canvas.toBuffer('png'))
    const metrics = await analyzeCover(path)
    expect(['red', 'blue']).toContain(metrics.dominantColor)
    expect(metrics.colorFamilies).toEqual([{ color: 'red', share: 0.5 }, { color: 'blue', share: 0.5 }])
  })

  it('本组满五张才启用统计规则，并按题材隔离学习结果', async () => {
    const { root, service } = await fixture()
    const folder = join(root, 'genre-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 4; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${100 + index}, 30, 30)`)
    const first = await service.learnFolder(folder, { genre: 'mystery' })
    expect(first.summary.rules?.filter((rule) => rule.source === 'statistics')).toHaveLength(0)
    await createPatternCover(join(folder, '4.png'), '#773333')
    const second = await service.learnFolder(folder, { genre: 'mystery' })
    expect(second.summary.genreSampleCounts?.mystery).toBe(5)
    const statisticRules = second.summary.rules?.filter((rule) => rule.source === 'statistics') ?? []
    expect(statisticRules.every((rule) => rule.text.startsWith('本地样本观察：') && !/[a-z]/i.test(rule.text))).toBe(true)
    expect(statisticRules.map((rule) => rule.id)).toEqual(expect.arrayContaining(['statistics:mystery:portrait', 'statistics:mystery:saturation', 'statistics:mystery:contrast', 'statistics:mystery:quiet-band', 'statistics:mystery:palette']))
    const { library } = await service.load()
    const mysteryRules = service.getRulesForGenre(library, 'mystery')
    const romanceRules = service.getRulesForGenre(library, 'modern_romance')
    expect(mysteryRules.some((rule) => rule.startsWith('本地样本观察'))).toBe(true)
    expect(romanceRules.some((rule) => rule.startsWith('本地样本观察'))).toBe(false)
    expect(library.globalRules.some((rule) => rule.startsWith('本地样本观察'))).toBe(false)
  })

  it('旧库的有效统计规则仅在内存迁移，重复导入不会丢失且保留用户修改', async () => {
    const { root, service } = await fixture()
    const folder = join(root, 'legacy-valid-statistics')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${130 + index}, 70, 30)`)
    const result = await service.learnFolder(folder)
    const raw = JSON.parse(await fs.readFile(result.summary.filePath, 'utf-8'))
    raw.learning.observedRules = raw.learning.generatedRules.map((rule: { text: string }) => rule.text)
    raw.globalRules.push(...raw.learning.observedRules, 'USER_MODIFIED_LEGACY_RULE')
    delete raw.learning.generatedRules
    const stored = JSON.stringify(raw, null, 2)
    await fs.writeFile(result.summary.filePath, stored)
    const migrated = await service.load()
    expect(migrated.summary.rules?.filter((rule) => rule.source === 'statistics').length).toBeGreaterThan(0)
    expect(service.getRulesForGenre(migrated.library, 'urban')).toContain('USER_MODIFIED_LEGACY_RULE')
    expect(await fs.readFile(result.summary.filePath, 'utf-8')).toBe(stored)
    const repeated = await service.learnFolder(folder)
    expect(repeated).toMatchObject({ learned: 0, duplicates: 5 })
    expect(repeated.summary.rules?.some((rule) => rule.source === 'statistics')).toBe(true)
    const modern = JSON.parse(await fs.readFile(result.summary.filePath, 'utf-8'))
    expect(modern.learning.observedRules).toEqual([])
    expect(modern.learning.generatedRules.length).toBeGreaterThan(0)
  })

  it('超过五十条用户规则完整保留，AI 规则替换更新而非持续累积', async () => {
    let round = 0
    const generateStream = vi.fn(async () => JSON.stringify({ extraGlobalRules: [`中文规则_${++round}`], observations: [] }))
    const { root, service } = await fixture({ generateStream })
    const loaded = await service.load()
    const raw = JSON.parse(await fs.readFile(loaded.summary.filePath, 'utf-8'))
    raw.globalRules = Array.from({ length: 75 }, (_, index) => `USER_RULE_${index}`)
    await fs.writeFile(loaded.summary.filePath, JSON.stringify(raw))
    const folder = join(root, 'ai-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${100 + index}, 50, 30)`)
    await service.learnFolder(folder, { aiMode: 'summary' })
    await createPatternCover(join(folder, '5.png'), '#885522')
    const result = await service.learnFolder(folder, { aiMode: 'summary' })
    expect(result.aiStatus).toBe('completed')
    const current = await service.load()
    expect(current.library.globalRules).toHaveLength(75)
    expect(service.getRulesForGenre(current.library, 'urban')).toContain('中文规则_2')
    expect(service.getRulesForGenre(current.library, 'urban')).not.toContain('中文规则_1')
    expect(current.summary.rules?.filter((rule) => rule.source === 'ai')).toHaveLength(1)
    expect(generateStream).toHaveBeenCalledTimes(2)
  })

  it('默认纯本地且不足五张时不会调用模型', async () => {
    const generateStream = vi.fn(async () => '{}')
    const { root, service } = await fixture({ generateStream })
    const folder = join(root, 'local-only')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${40 + index}, 120, 90)`)
    await service.learnFolder(folder)
    const small = join(root, 'small-genre')
    await fs.mkdir(small)
    await createPatternCover(join(small, 'one.png'), '#555588')
    const result = await service.learnFolder(small, { aiMode: 'vision', genre: 'scifi' })
    expect(result.aiStatus).toBe('skipped')
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('AI新规则要求中文，纯英文响应报错并保留上次已生效的中文AI规则', async () => {
    const generateStream = vi.fn<LlmService['generateStream']>()
      .mockResolvedValueOnce(JSON.stringify({ extraGlobalRules: ['保持克制的配色和清晰的明暗层次。'], observations: ['主色之间区分清楚。'] }))
      .mockResolvedValueOnce(JSON.stringify({ extraGlobalRules: ['Use a controlled palette.'], observations: ['English observation'] }))
    const { root, service } = await fixture({ generateStream })
    const folder = join(root, 'chinese-ai-rules')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${140 + index}, 60, 80)`)
    const first = await service.learnFolder(folder, { aiMode: 'summary' })
    expect(first.aiStatus).toBe('completed')
    const [instruction, options] = generateStream.mock.calls[0]
    expect(instruction).toContain('两组字符串全部使用自然简体中文')
    expect(instruction).toContain('没有看到图片')
    expect(options?.jsonSchema).toMatchObject({ properties: { extraGlobalRules: { items: { description: expect.stringContaining('简体中文') } } } })
    const previous = first.summary.rules?.filter((rule) => rule.source === 'ai')
    const second = await service.learnFolder(folder, { aiMode: 'summary' })
    expect(second.aiStatus).toBe('failed')
    expect(second.aiMessage).toContain('中文规则')
    expect(second.summary.rules?.filter((rule) => rule.source === 'ai')).toEqual(previous)
  })

  it('视觉模式只发送最多六张 512 像素缩略图，规则绑定样本证据', async () => {
    const generateStream = vi.fn<LlmService['generateStream']>(async () => JSON.stringify({ extraGlobalRules: ['为书名保留清晰留白。'], observations: ['标题有清晰留白。'] }))
    const { root, service } = await fixture({ generateStream })
    const folder = join(root, 'vision-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 7; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${90 + index}, 50, 160)`, 576, 768)
    const result = await service.learnFolder(folder, { aiMode: 'vision', genre: 'light_novel' })
    expect(result.aiStatus).toBe('completed')
    const options = generateStream.mock.calls[0]?.[1] as { images?: string[] } | undefined
    expect(options?.images).toHaveLength(6)
    const { loadImage } = await import('skia-canvas')
    for (const dataUrl of options?.images ?? []) {
      const image = await loadImage(Buffer.from(dataUrl.split(',')[1], 'base64'))
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(512)
    }
    const aiRule = result.summary.rules?.find((rule) => rule.source === 'ai')
    expect(aiRule?.text).toBe('为书名保留清晰留白。')
    expect(generateStream.mock.calls[0][0]).toContain('两组字符串全部使用自然简体中文')
    expect(aiRule?.evidence).toHaveLength(6)
    expect(aiRule?.evidence?.every((entry) => /^[a-f0-9]{64}:\d\.png$/.test(entry))).toBe(true)
  })

  it('纯本地导入后可对同一批已有封面主动补做视觉分析，也可重试失败模型', async () => {
    const generateStream = vi.fn<LlmService['generateStream']>()
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockResolvedValue(JSON.stringify({ extraGlobalRules: ['为标题保留干净区域。'], observations: [] }))
    const { root, service } = await fixture({ generateStream })
    const folder = join(root, 'existing-vision')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${60 + index}, 70, 120)`)
    await service.learnFolder(folder)
    const failed = await service.learnFolder(folder, { aiMode: 'vision' })
    expect(failed).toMatchObject({ learned: 0, duplicates: 5, aiStatus: 'failed' })
    const retried = await service.learnFolder(folder, { aiMode: 'vision' })
    expect(retried).toMatchObject({ learned: 0, duplicates: 5, aiStatus: 'completed' })
    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(retried.summary.analyzedSampleCount).toBe(5)
  })

  it('旧目录移动后重复导入刷新源路径，视觉分析仍读取新的封面位置', async () => {
    const generateStream = vi.fn<LlmService['generateStream']>(async () => JSON.stringify({ extraGlobalRules: ['保持视觉主体不受遮挡。'], observations: [] }))
    const { root, service } = await fixture({ generateStream })
    const folder = join(root, 'old-source')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${110 + index}, 70, 50)`)
    await service.learnFolder(folder)
    const moved = join(root, 'new-source')
    await fs.rename(folder, moved)
    const result = await service.learnFolder(moved, { aiMode: 'vision' })
    expect(result).toMatchObject({ learned: 0, duplicates: 5, aiStatus: 'completed' })
    const stored = (await service.load()).library
    expect(stored.learning.samples.every((sample) => sample.sourceDirectory === moved)).toBe(true)
    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(result.summary.analyzedSampleCount).toBe(5)
  })

  it('缩放编码重复图更新源路径和指纹，不额外增加样本或重复生成统计版本', async () => {
    const { root, service } = await fixture()
    const original = join(root, 'original-encoding')
    const resized = join(root, 'resized-encoding')
    await fs.mkdir(original)
    await fs.mkdir(resized)
    for (let index = 0; index < 5; index++) {
      await createPatternCover(join(original, `${index}.png`), `rgb(${140 + index}, 80, 40)`)
      await createPatternCover(join(resized, `${index}.png`), `rgb(${140 + index}, 80, 40)`, 576, 768)
    }
    await service.learnFolder(original)
    const before = (await service.load()).library
    const result = await service.learnFolder(resized)
    const after = (await service.load()).library
    expect(result).toMatchObject({ learned: 0, duplicates: 5 })
    expect(result.summary.analyzedSampleCount).toBe(5)
    expect(after.learning.samples.every((sample) => sample.sourceDirectory === resized)).toBe(true)
    expect(after.learning.samples.every((sample) => sample.metrics.width === 576)).toBe(true)
    expect(after.learning.ruleHistory).toHaveLength(before.learning.ruleHistory.length)
  })

  it('不支持视觉和模型失败都保留本地样本及明确 AI 状态', async () => {
    const generateStream = vi.fn(async () => { throw new Error('LLM_VISION_UNSUPPORTED') })
    const { root, service } = await fixture({ generateStream })
    const folder = join(root, 'unsupported-vision')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${120 + index}, 30, 60)`)
    const result = await service.learnFolder(folder, { aiMode: 'vision' })
    expect(result.aiStatus).toBe('unsupported')
    expect(result.learned).toBe(5)
    expect(result.summary.analyzedSampleCount).toBe(5)
    expect(result.summary.rules?.some((rule) => rule.source === 'statistics')).toBe(true)
    expect(result.aiMessage).toContain('已保存本地结果')
  })

  it('规则开关和回退保留用户规则与已分析样本', async () => {
    const { root, service } = await fixture()
    const loaded = await service.load()
    const raw = JSON.parse(await fs.readFile(loaded.summary.filePath, 'utf-8'))
    raw.globalRules.push('CUSTOM_USER_RULE')
    await fs.writeFile(loaded.summary.filePath, JSON.stringify(raw))
    const folder = join(root, 'rollback-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${180 + index}, 30, 50)`)
    const result = await service.learnFolder(folder, { genre: 'urban' })
    const rule = result.summary.rules?.find((entry) => entry.source === 'statistics')
    expect(rule).toBeDefined()
    const disabled = await service.setRuleEnabled(rule!.id, false)
    expect(disabled.rules?.find((entry) => entry.id === rule!.id)?.enabled).toBe(false)
    expect(service.getRulesForGenre((await service.load()).library, 'urban')).not.toContain(rule!.text)
    const rolledBack = await service.rollbackLastLearningRules()
    expect(rolledBack.analyzedSampleCount).toBe(5)
    expect(rolledBack.rules?.some((entry) => entry.source === 'statistics')).toBe(false)
    expect(rolledBack.rules?.some((entry) => entry.text === 'CUSTOM_USER_RULE')).toBe(true)
  })

  it('目标目录损坏时拒绝切换，不覆盖目标也不更改当前设置', async () => {
    const { root, service } = await fixture()
    const original = await service.initialize()
    const folder = join(root, 'broken-destination')
    await fs.mkdir(folder)
    const target = join(folder, 'cover-learning-library.json')
    await fs.writeFile(target, '{broken')
    await expect(service.setDirectory(folder)).rejects.toThrow('当前目录保持不变')
    expect((await service.load()).summary.directory).toBe(original.directory)
    expect(await fs.readFile(target, 'utf-8')).toBe('{broken')
  })

  it('取消保留已完成样本，下次从内容指纹继续，重启可读取最终任务状态', async () => {
    const { root, service } = await fixture()
    const folder = join(root, 'cancel-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 12; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${80 + index}, 60, 120)`)
    const originalRead = fs.readFile.bind(fs)
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('.png') && service.getTaskState()?.processed === 2) service.cancelLearning()
      return originalRead(...args)
    }) as typeof fs.readFile)
    const cancelled = await service.learnFolder(folder)
    readSpy.mockRestore()
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.learned).toBeGreaterThan(0)
    expect(cancelled.learned).toBeLessThan(12)
    expect(cancelled.summary.analyzedSampleCount).toBe(cancelled.learned)
    const resumed = await service.learnFolder(folder)
    expect(resumed.learned + cancelled.learned).toBe(12)
    expect(resumed.summary.analyzedSampleCount).toBe(12)
    const settings = new SettingsRepository(join(root, 'config', 'settings.json'))
    const restarted = new CoverLearningLibraryService(settings, join(root, 'default-library'))
    await restarted.initialize()
    expect(restarted.getTaskState()?.phase).toBe('completed')
    expect(restarted.getTaskState()?.processed).toBe(12)
    expect(restarted.getTaskState()?.result).toMatchObject({ learned: resumed.learned, duplicates: resumed.duplicates })
    expect(restarted.getTaskState()?.result?.summary.analyzedSampleCount).toBe(12)
  })

  it('学习期间手工修改规则和风格不会被保存步骤覆盖', async () => {
    const { root, service } = await fixture()
    const original = await service.load()
    const generateStream = vi.fn<LlmService['generateStream']>(async () => {
      const raw = JSON.parse(await fs.readFile(original.summary.filePath, 'utf-8'))
      raw.globalRules.push('USER_EDIT_DURING_AI')
      raw.styles.folk_horror.prompt = 'USER_STYLE_DURING_AI'
      await fs.writeFile(original.summary.filePath, JSON.stringify(raw))
      return JSON.stringify({ extraGlobalRules: ['使用克制的配色。'], observations: [] })
    })
    const settings = new SettingsRepository(join(root, 'config', 'settings.json'))
    const learning = new CoverLearningLibraryService(settings, join(root, 'default-library'), { generateStream } as unknown as LlmService)
    const folder = join(root, 'manual-edit-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${160 + index}, 60, 20)`)
    await learning.learnFolder(folder, { aiMode: 'summary' })
    const updated = await learning.load()
    expect(updated.library.globalRules).toContain('USER_EDIT_DURING_AI')
    expect(updated.library.styles.folk_horror.prompt).toBe('USER_STYLE_DURING_AI')
    expect(updated.summary.analyzedSampleCount).toBe(5)
  })

  it('取消 AI 汇总不注入尚未完成的 AI 规则，并保留已分析样本', async () => {
    const { root, service } = await fixture()
    const settings = new SettingsRepository(join(root, 'config', 'settings.json'))
    const generateStream = vi.fn<LlmService['generateStream']>(async () => {
      expect(learning.cancelLearning()).toEqual({ ok: true })
      return JSON.stringify({ extraGlobalRules: ['尚未完成的中文规则'], observations: [] })
    })
    const learning = new CoverLearningLibraryService(settings, join(root, 'default-library'), { generateStream } as unknown as LlmService)
    await service.initialize()
    const folder = join(root, 'cancel-ai-covers')
    await fs.mkdir(folder)
    for (let index = 0; index < 5; index++) await createPatternCover(join(folder, `${index}.png`), `rgb(${70 + index}, 100, 140)`)
    const result = await learning.learnFolder(folder, { aiMode: 'summary' })
    expect(result).toMatchObject({ cancelled: true, learned: 5, aiStatus: 'skipped' })
    expect(result.summary.rules?.some((rule) => rule.text === '尚未完成的中文规则')).toBe(false)
    expect(result.summary.analyzedSampleCount).toBe(5)
  })

  it('采用和淘汰反馈按封面 ID 更新，单次反馈不删除规则', async () => {
    const { service } = await fixture()
    const initial = await service.load()
    const feedback = { id: 'project/封面_v1', genre: 'urban' as const, status: 'adopted' as const, reason: '标题清晰', libraryVersion: initial.library.updatedAt, rules: ['RULE'] }
    await service.recordFeedback(feedback)
    await service.recordFeedback({ ...feedback, status: 'rejected', reason: '主体不合适' })
    const current = await service.load()
    expect(current.library.learning.feedback).toHaveLength(1)
    expect(current.library.learning.feedback[0].reason).toBe('主体不合适')
    expect(current.library.globalRules).toEqual(initial.library.globalRules)
    expect(current.summary.feedbackSummary).toEqual({ adopted: 0, rejected: 1, unrated: 0 })
  })

  it('任务记录超过一百条后累计次数继续增长', async () => {
    const { root, service } = await fixture()
    const loaded = await service.load()
    const raw = JSON.parse(await fs.readFile(loaded.summary.filePath, 'utf-8'))
    const run = { directory: 'fixture', scanned: 0, learned: 0, duplicates: 0, failed: 0, startedAt: '', completedAt: '', observations: [] }
    raw.learning.runs = Array.from({ length: 100 }, () => run)
    raw.learning.totalRunCount = 125
    await fs.writeFile(loaded.summary.filePath, JSON.stringify(raw))
    const folder = join(root, 'empty-covers')
    await fs.mkdir(folder)
    const result = await service.learnFolder(folder)
    expect(result.summary.learningRunCount).toBe(126)
    expect((await service.load()).library.learning.runs).toHaveLength(100)
  })
})

async function createPatternCover(
  filePath: string,
  color: string,
  width = 288,
  height = 384
): Promise<void> {
  const { Canvas } = await import('skia-canvas')
  const canvas = new Canvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(width / 4, height / 4, width / 2, height / 4)
  context.fillStyle = '#111111'
  context.fillRect(width / 4, height * 3 / 4, width / 2, height / 16)
  const buffer = await canvas.toBuffer('png')
  await fs.writeFile(filePath, buffer)
}
