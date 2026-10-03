import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildCoverPrompt, COVER_STYLE_PRESETS, GENRE_STYLES, PLATFORM_STYLES } from '../src/main/data/skill-prompts/cover/cover-styles'
import { withCoverChannel } from '../src/main/data/cover-channel'
import { withVisualDirection } from '../src/main/data/cover-visual-direction'
import { withCoverFrameSafety } from '../src/main/data/cover-frame'
import { inspectCoverPromptText } from '../src/renderer/src/cover-page-state'
import { CoverService } from '../src/main/data/cover-service'
import { CoverLearningLibraryService } from '../src/main/data/cover-learning-library'
import { SettingsRepository } from '../src/main/data/settings-repository'
import type { CoverChannel, CoverGenre, CoverPlatform, CoverStylePreset } from '../src/shared/types'

const bookName = '长夜问剑'
const authorName = '青山'
const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function verifyChinesePrompt(prompt: string): void {
  expect(inspectCoverPromptText(prompt, bookName, authorName)).toBe('matches')
  // Only internal envelope identifiers are language-independent; all generated prose must be Chinese.
  const prose = prompt.replace(/<\/?author-visual-direction>/g, '').replace(/\[(?:male|female|managed)\]/g, '')
  expect(prose.match(/[a-z]{3,}/gi)).toBeNull()
  expect(prompt.match(/^画幅安全区：/gm)).toHaveLength(1)
}

describe('中文封面提示词端到端契约', () => {
  it('真实学习库接入后生成中文提示词，版本快照只记录实际使用的规则', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'cover-chinese-'))
    cleanup.push(root)
    const library = new CoverLearningLibraryService(new SettingsRepository(join(root, 'settings.json')), join(root, 'library'))
    const service = new CoverService(
      { resolveDir: async () => root } as unknown as ConstructorParameters<typeof CoverService>[0],
      {} as ConstructorParameters<typeof CoverService>[1], library)
    const input = { projectId: 'p1', bookName, authorName, platform: 'fanqie' as const, genreOverride: 'xianxia' as const, stylePreset: 'ink_minimal' as const }
    const learningContext = await service.getPromptContext(input)
    const prompt = await service.resolvePromptWithLibrary({ ...input, learningContext })
    verifyChinesePrompt(prompt)
    expect(learningContext.rules.length).toBeGreaterThan(0)
    for (const rule of learningContext.rules) expect(prompt).toContain(rule)
    expect(learningContext.sources?.length).toBeGreaterThan(0)
  })

  it('所有平台和题材的默认模板都是中文，且可被编辑器识别', () => {
    for (const platform of Object.keys(PLATFORM_STYLES) as CoverPlatform[]) {
      for (const genre of Object.keys(GENRE_STYLES) as CoverGenre[]) {
        const prompt = buildCoverPrompt({ bookName, authorName, platform, genre, composition: 'closeup' })
        verifyChinesePrompt(prompt)
      }
    }
  })

  it('所有明确风格在自动、男频、女频下均保持中文并且重复组装不改变内容', () => {
    const visualDirection = '只将光线改为冷色，人物不变'
    for (const stylePreset of Object.keys(COVER_STYLE_PRESETS) as CoverStylePreset[]) {
      for (const channel of [undefined, 'male', 'female'] as Array<CoverChannel | undefined>) {
        const prompt = buildCoverPrompt({ bookName, authorName, platform: 'fanqie', genre: 'light_novel', composition: 'duo', stylePreset, channel, visualDirection })
        const finalize = (value: string) => withCoverFrameSafety(withCoverChannel(withVisualDirection(value, visualDirection, channel), channel))
        const final = finalize(prompt)
        verifyChinesePrompt(final)
        expect(finalize(final)).toBe(final)
      }
    }
  })
})
