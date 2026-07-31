import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CoverLearningLibraryService } from '../src/main/data/cover-learning-library'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { buildCoverPrompt } from '../src/main/data/skill-prompts/cover/cover-styles'

const cleanup: string[] = []

async function fixture(): Promise<{
  root: string
  service: CoverLearningLibraryService
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'cover-library-'))
  cleanup.push(root)
  const settings = new SettingsRepository(join(root, 'config', 'settings.json'))
  return {
    root,
    service: new CoverLearningLibraryService(settings, join(root, 'default-library'))
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('CoverLearningLibraryService', () => {
  it('首次使用时把 138 张样本的学习结果初始化为本地 JSON', async () => {
    const { service } = await fixture()
    const summary = await service.initialize()

    expect(summary.status).toBe('ready')
    expect(summary.sampleCount).toBe(138)
    expect(summary.categoryCount).toBe(23)
    expect(summary.styleCount).toBe(19)
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

  it('损坏的用户文件不被覆盖，并安全回退到内置库', async () => {
    const { service } = await fixture()
    const initialized = await service.initialize()
    await fs.writeFile(initialized.filePath, '{ broken json', 'utf-8')

    const loaded = await service.load()
    expect(loaded.summary.status).toBe('fallback')
    expect(loaded.summary.styleCount).toBe(19)
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
    await createSolidCover(red, '#d64025')
    await fs.copyFile(red, renamedCopy)
    await createSolidCover(resizedCopy, '#d64025', 180, 320)
    await createSolidCover(similarButDifferent, '#d54025')
    await createSolidCover(blue, '#2255aa')
    await fs.writeFile(join(covers, 'broken.jpg'), 'not an image', 'utf-8')

    const first = await service.learnFolder(covers)
    expect(first.scanned).toBe(6)
    expect(first.learned).toBe(3)
    expect(first.duplicates).toBe(2)
    expect(first.failed).toBe(1)
    expect(first.summary.sampleCount).toBe(141)
    expect(first.summary.trackedSampleCount).toBe(141)
    expect(first.summary.learningRunCount).toBe(1)
    expect(first.observations.length).toBeGreaterThan(0)

    const second = await service.learnFolder(covers)
    expect(second.learned).toBe(0)
    expect(second.duplicates).toBe(5)
    expect(second.failed).toBe(1)
    expect(second.summary.sampleCount).toBe(141)
    expect(second.summary.trackedSampleCount).toBe(141)
    expect(second.summary.learningRunCount).toBe(2)

    const stored = JSON.parse(await fs.readFile(second.summary.filePath, 'utf-8'))
    expect(stored.learning.samples).toHaveLength(3)
    expect(stored.learning.runs).toHaveLength(2)
    expect(stored.learning.observedRules.length).toBeGreaterThan(0)
    expect(stored.globalRules.some((rule: string) => rule.startsWith('Observed local library'))).toBe(true)
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
    expect(result.summary.trackedSampleCount).toBe(138)
  })

  it('学习过程中请求切换目录时排队迁移，学习结果不会留在失效目录', async () => {
    const { root, service } = await fixture()
    const covers = join(root, 'race-covers')
    await fs.mkdir(covers, { recursive: true })
    await createSolidCover(join(covers, 'new.png'), '#319966')
    const destination = join(root, 'moved-library')

    const learning = service.learnFolder(covers)
    const moving = service.setDirectory(destination)
    await learning
    const moved = await moving

    expect(moved.directory).toBe(destination)
    expect(moved.sampleCount).toBe(139)
    expect(moved.trackedSampleCount).toBe(139)
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
})

async function createSolidCover(
  filePath: string,
  color: string,
  width = 90,
  height = 160
): Promise<void> {
  const { Canvas } = await import('skia-canvas')
  const canvas = new Canvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(0, 0, width, height)
  const buffer = await canvas.toBuffer('png')
  await fs.writeFile(filePath, buffer)
}
