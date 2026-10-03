import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Canvas, loadImage } from 'skia-canvas'
import { CoverService, MAX_COVER_PROMPT_CHARACTERS } from '../src/main/data/cover-service'
import { withCoverChannel } from '../src/main/data/cover-channel'
import { withCoverFrameSafety } from '../src/main/data/cover-frame'
import { COVER_STYLE_PRESETS, TITLE_FONT_STYLES } from '../src/main/data/skill-prompts/cover/cover-styles'
import type { CoverLearningContext, GenerateCoverInput } from '../src/shared/types'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(rules = ['NEW RULE']) {
  const root = await fs.mkdtemp(join(tmpdir(), 'cover-feedback-'))
  cleanup.push(root)
  const canvas = new Canvas(24, 32)
  canvas.getContext('2d').fillRect(0, 0, 24, 32)
  const imageData = (await canvas.toBuffer('png')).toString('base64')
  const generate = vi.fn(async () => imageData)
  const recordFeedback = vi.fn(async () => undefined)
  const load = vi.fn(async () => ({
    library: { updatedAt: 'new-library', source: { sampleCount: 100 }, globalRules: ['NEW RULE'] },
    summary: { rules: [] }
  }))
  const library = {
    load,
    resolveStyle: () => ({ key: 'urban_cinematic', definition: COVER_STYLE_PRESETS.urban_cinematic }),
    getRulesForGenre: () => rules,
    recordFeedback
  }
  const service = new CoverService(
    { resolveDir: async () => root } as unknown as ConstructorParameters<typeof CoverService>[0],
    { generate } as unknown as ConstructorParameters<typeof CoverService>[1],
    library as unknown as ConstructorParameters<typeof CoverService>[2]
  )
  const context: CoverLearningContext = {
    libraryVersion: 'old-library@original',
    rules: ['KEEP THIS RULE', 'DELETED RULE'],
    sourceSampleCount: 10,
    resolvedStylePreset: 'urban_cinematic',
    sources: ['statistics:urban · original sample']
  }
  const input: GenerateCoverInput = {
    projectId: 'project-1', bookName: '都市长夜', authorName: '某某', platform: 'fanqie',
    genreOverride: 'urban', promptOverride: 'AUTHOR EDIT\nKEEP THIS RULE', learningContext: context,
    promptSource: 'edited'
  }
  return { root, service, input, context, load, generate, recordFeedback }
}

describe('封面生成来源与效果反馈', () => {
  it('文字重编保留画面编辑与学习快照，后续出图仍应用新选女频并解除旧男频锁', async () => {
    const { service, input, context, generate, load } = await fixture()
    const old = withCoverChannel("Title text '都市长夜' in old typography.\nMain subject: an elderly man in a dark coat.\nAUTHOR EDIT: retain the red umbrella.\nKEEP THIS RULE", 'male')
    const patched = await service.resolvePromptWithLibrary({
      ...input, promptOverride: undefined, typographyBasePrompt: old,
      channel: 'female', typography: { titleFont: 'modern' }
    })
    expect(patched).toContain(TITLE_FONT_STYLES.modern)
    expect(patched).toContain('AUTHOR EDIT: retain the red umbrella.')
    expect(load).not.toHaveBeenCalled()
    const result = await service.generate({ ...input, channel: 'female', promptOverride: patched })
    expect(generate).toHaveBeenCalledWith(withCoverFrameSafety(withCoverChannel(patched, 'female')), '1024x1536', expect.any(AbortSignal))
    expect(result.generationMetadata?.channel).toBe('female')
    expect(result.generationMetadata?.learningContext).toEqual({ ...context, rules: ['KEEP THIS RULE'] })
  })

  it('更新文字先读上下文时仍保留原库快照，并排除冲突布局而不引入新规则', async () => {
    const { service, input, context, load } = await fixture(['A NEW UNREQUESTED RULE.'])
    const oldRules = ['Place the title in the upper third band.', 'Keep the title legible on mobile.']
    const base = "Title text '都市长夜' in old typography.\nAUTHOR EDIT: keep the red umbrella.\nLearned cover rules: " + oldRules.join(' ')
    const request = {
      ...input, promptOverride: undefined, bookName: '新书名', typographyBasePrompt: base,
      typography: { titlePosition: 'center' as const }, learningContext: { ...context, rules: oldRules }
    }
    const updatedContext = await service.getPromptContext(request)
    const prompt = await service.resolvePromptWithLibrary({ ...request, learningContext: updatedContext })
    expect(updatedContext.libraryVersion).toBe(context.libraryVersion)
    expect(updatedContext.rules).toEqual(['Keep the title legible on mobile.'])
    expect(prompt).toContain("书名文字：'新书名'")
    expect(prompt).toContain('AUTHOR EDIT: keep the red umbrella.')
    expect(prompt).not.toContain('upper third band')
    expect(prompt).not.toContain('UNREQUESTED')
    expect(load).not.toHaveBeenCalled()
  })
  it('超过12条的最新AI规则同时进入提示词和版本快照，不因为旧用户规则被截断', async () => {
    const rules = [...Array.from({ length: 75 }, (_, index) => `USER RULE ${index + 1}.`), 'LATEST AI RULE.']
    const { service, input } = await fixture(rules)
    const clean = { ...input, promptOverride: undefined, learningContext: undefined }
    const context = await service.getPromptContext(clean)
    expect(context.rules).toEqual(rules)
    expect(context.sourceSampleCount).toBe(100)
    const prompt = await service.resolvePromptWithLibrary({ ...clean, learningContext: context })
    expect(prompt).toContain('LATEST AI RULE.')
  })

  it('超过实际出图预算时明确报错并保留所有内容，不调用图像生成', async () => {
    const { service, input, generate } = await fixture()
    const longPrompt = 'a'.repeat(MAX_COVER_PROMPT_CHARACTERS + 1)
    await expect(service.generate({ ...input, promptOverride: longPrompt })).rejects.toThrow('COVER_PROMPT_TOO_LONG')
    expect(generate).not.toHaveBeenCalled()
    expect(longPrompt).toHaveLength(MAX_COVER_PROMPT_CHARACTERS + 1)
  })
  it('保留编辑框的旧学习快照，仅补画布安全区，原图和上传图共享实际规则来源', async () => {
    const { root, service, input, context, load, generate } = await fixture()
    const result = await service.generate(input)
    expect(generate).toHaveBeenCalledWith(withCoverFrameSafety(input.promptOverride!), '1024x1536', expect.any(AbortSignal))
    expect(load).not.toHaveBeenCalled()
    expect(result.generationMetadata?.learningContext).toEqual({ ...context, rules: ['KEEP THIS RULE'] })
    expect(result.generationMetadata?.promptSource).toBe('edited')
    const stored = JSON.parse(await fs.readFile(join(root, '封面', '封面_v1.metadata.json'), 'utf8'))
    expect(stored.learningContext.libraryVersion).toBe('old-library@original')
    const files = await service.list('project-1')
    expect(files).toHaveLength(2)
    expect(files.every((file) => file.generationMetadata?.learningContext?.libraryVersion === context.libraryVersion)).toBe(true)
    const image = await loadImage(join(root, '封面', '封面_v1.png'))
    expect(image.width * 4).toBe(image.height * 3)
  })

  it('采用、淘汰和修正原因可重存，上传版与原图始终看到同一条反馈', async () => {
    const { service, input, recordFeedback } = await fixture()
    await service.generate(input)
    await service.updateFeedback({ projectId: 'project-1', fileName: '封面_v1.png', status: 'adopted', reason: '书名清楚' })
    const changed = await service.updateFeedback({ projectId: 'project-1', fileName: '封面_v1_上传.png', status: 'rejected', reason: '裁切后署名不完整' })
    expect(changed.feedback).toMatchObject({ status: 'rejected', reason: '裁切后署名不完整' })
    expect(recordFeedback).toHaveBeenLastCalledWith({
      id: 'project-1/封面_v1', genre: 'urban', status: 'rejected', reason: '裁切后署名不完整',
      libraryVersion: 'old-library@original', rules: ['KEEP THIS RULE']
    })
    expect((await service.list('project-1')).every((file) => file.feedback?.status === 'rejected')).toBe(true)
    await service.updateFeedback({ projectId: 'project-1', fileName: '封面_v1.png', status: 'unrated', reason: '' })
    expect((await service.list('project-1')).every((file) => file.feedback?.status === 'unrated')).toBe(true)
  })

  it('仅重新编译文字层时保留结构化场景和手改正文，非标准提示词不被吞掉', async () => {
    const { service, input } = await fixture()
    const old = 'Title text \'都市长夜\' in old typography.\nA one-armed elderly detective.\nAUTHOR EDIT: retain the red umbrella.'
    const recompiled = await service.resolvePromptWithLibrary({
      ...input, promptOverride: undefined, typographyBasePrompt: old,
      typography: { titleFont: 'modern' }, scene: { characterDesc: 'a one-armed elderly detective' }
    })
    expect(recompiled).toContain(TITLE_FONT_STYLES.modern)
    expect(recompiled).toContain('A one-armed elderly detective.')
    expect(recompiled).toContain('AUTHOR EDIT: retain the red umbrella.')
    expect(await service.resolvePromptWithLibrary({
      ...input, promptOverride: undefined, typographyBasePrompt: 'Just draw a moon.'
    })).toBe('Just draw a moon.')
  })

  it('模板构建拒绝来源快照与当前规则不一致，重新读取后能够构建', async () => {
    const { service, input } = await fixture()
    await expect(service.resolvePromptWithLibrary({ ...input, promptOverride: undefined })).rejects.toThrow('COVER_LIBRARY_CHANGED')
    const clean = { ...input, promptOverride: undefined, learningContext: undefined }
    const learningContext = await service.getPromptContext(clean)
    const prompt = await service.resolvePromptWithLibrary({ ...clean, learningContext })
    expect(prompt).toContain('NEW RULE')
  })

  it('拒绝把反馈写到封面目录外，旧封面没有来源记录也可以评价', async () => {
    const { root, service } = await fixture()
    await fs.mkdir(join(root, '封面'), { recursive: true })
    const oldImage = new Canvas(24, 32)
    await fs.writeFile(join(root, '封面', '封面_v2.png'), await oldImage.toBuffer('png'))
    await expect(service.updateFeedback({
      projectId: 'project-1', fileName: '../other.png', status: 'rejected'
    })).rejects.toThrow('非法封面文件路径')
    const old = await service.updateFeedback({
      projectId: 'project-1', fileName: '封面_v2.png', status: 'rejected', reason: '旧版本'
    })
    expect(old.feedback?.reason).toBe('旧版本')
    expect(old.generationMetadata).toBeUndefined()
  })
})
