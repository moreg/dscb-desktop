import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Canvas, loadImage } from 'skia-canvas'
import { CoverService } from '../src/main/data/cover-service'
import { withCoverChannel } from '../src/main/data/cover-channel'
import { withVisualDirection } from '../src/main/data/cover-visual-direction'
import { COVER_FRAME_SAFETY_PROMPT, withCoverFrameSafety } from '../src/main/data/cover-frame'
import { inspectCoverPromptText } from '../src/renderer/src/cover-page-state'
import type { GenerateCoverInput } from '../src/shared/types'

const cleanup: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(width = 96, height = 144) {
  const root = await fs.mkdtemp(join(tmpdir(), 'cover-pipeline-'))
  cleanup.push(root)
  const canvas = new Canvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#00ff00'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ff0000'
  context.fillRect(0, 0, width, Math.ceil(height / 15))
  context.fillStyle = '#0000ff'
  context.fillRect(0, height - Math.ceil(height / 15), width, Math.ceil(height / 15))
  const png = await canvas.toBuffer('png')
  const generate = vi.fn(async (_prompt: string, _size: string, _signal?: AbortSignal) => png.toString('base64'))
  const edit = vi.fn(async (_prompt: string, _size: string, _path: string, _signal?: AbortSignal) => png.toString('base64'))
  const service = new CoverService(
    { resolveDir: async (id: string) => join(root, id) } as ConstructorParameters<typeof CoverService>[0],
    { generate, edit } as unknown as ConstructorParameters<typeof CoverService>[1]
  )
  const input: GenerateCoverInput = {
    projectId: 'p1', bookName: '夜路', authorName: '作者', platform: 'fanqie',
    promptOverride: "Title text '夜路'.\nAuthor byline: 作者著."
  }
  return { root, dir: join(root, 'p1', '封面'), png, generate, edit, service, input }
}

async function pixels(file: string): Promise<{ width: number; height: number; top: number[]; bottom: number[] }> {
  const image = await loadImage(file)
  const canvas = new Canvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  return {
    width: image.width, height: image.height,
    top: [...context.getImageData(0, 0, 1, 1).data],
    bottom: [...context.getImageData(0, image.height - 1, 1, 1).data]
  }
}

describe('封面生成任务和成品提交', () => {
  it.each(['male', 'female'] as const)('新建中文模板实际出图保留 %s 频道和人物细节，存盘与发送内容一致', async (channel) => {
    const { service, input, generate, dir } = await fixture()
    await service.generate({ ...input, promptOverride: undefined, channel, genreOverride: 'urban',
      visualDirection: '不要人物，纯场景', composition: 'fullbody',
      scene: { characterDesc: '一位六十岁、独臂的男性侦探，身穿青铜护甲，手持断刀', backgroundDesc: '废弃的旧火车站' } })
    const sent = generate.mock.calls[0][0]
    expect(inspectCoverPromptText(sent, input.bookName, input.authorName)).toBe('matches')
    for (const detail of ['六十岁', '独臂', '青铜护甲', '断刀', '废弃的旧火车站']) expect(sent).toContain(detail)
    const subject = sent.split('\n').find((line) => line.startsWith('主体人物：'))!
    expect(subject).toContain(channel === 'male' ? '男性' : '女性')
    expect(subject).not.toContain(channel === 'male' ? '女性' : '男性')
    expect(sent).toContain(COVER_FRAME_SAFETY_PROMPT)
    expect(await fs.readFile(join(dir, '封面_v1.prompt.txt'), 'utf8')).toBe(sent)
  })

  it.each(['male', 'female'] as const)('手改提示词和相反提炼方向仍应用 %s 频道，并记录到成品和裁剪版本', async (channel) => {
    const { service, input, generate, dir } = await fixture()
    const visualDirection = channel === 'male' ? '女性人物，全身，冷色灯光' : '男性人物，全身，暖色灯光'
    const result = await service.generate({ ...input, channel, visualDirection })
    const prompt = withCoverFrameSafety(withCoverChannel(withVisualDirection(input.promptOverride!, visualDirection, channel), channel))
    expect(generate).toHaveBeenCalledWith(prompt, '1024x1536', expect.any(AbortSignal))
    expect(await fs.readFile(join(dir, '封面_v1.prompt.txt'), 'utf8')).toBe(prompt)
    expect(result.generationMetadata?.channel).toBe(channel)
    expect((await service.list('p1')).every((file) => file.generationMetadata?.channel === channel)).toBe(true)
    const recropped = await service.updateCrop({ projectId: 'p1', fileName: result.fileName, offsetY: 0 })
    expect(recropped.generationMetadata?.channel).toBe(channel)
  })

  it.each(['male', 'female'] as const)('图生图同样发送 %s 人物要求并保留参考图路径', async (channel) => {
    const { root, service, input, png, generate, edit, dir } = await fixture()
    const referenceDir = join(root, 'p1', '素材')
    await fs.mkdir(referenceDir, { recursive: true })
    const refImagePath = join(referenceDir, 'reference.png')
    await fs.writeFile(refImagePath, png)
    const result = await service.generate({ ...input, channel, refImagePath })
    expect(generate).not.toHaveBeenCalled()
    expect(edit).toHaveBeenCalledWith(withCoverFrameSafety(withCoverChannel(input.promptOverride!, channel)), '1024x1536', refImagePath, expect.any(AbortSignal))
    expect(result.generationMetadata?.channel).toBe(channel)
    expect(await fs.readFile(join(dir, '封面_v1.ref.txt'), 'utf8')).toBe(refImagePath)
  })

  it('自动频道保留已有画面文字，补实际画布安全区且不写入显式频道记录', async () => {
    const { service, input, generate } = await fixture()
    const result = await service.generate(input)
    expect(generate).toHaveBeenCalledWith(input.promptOverride + '\n' + COVER_FRAME_SAFETY_PROMPT, '1024x1536', expect.any(AbortSignal))
    expect(result.generationMetadata?.channel).toBeUndefined()
  })

  it.each(['male', 'female'] as const)('%s 频道与无人物方向冲突时，最终发送内容仍保留人物细节', async (channel) => {
    const { service, generate, input } = await fixture()
    await service.generate({ ...input, channel, visualDirection: '不要人物，纯场景',
      promptOverride: input.promptOverride + '\nMain subject: a sixty-year-old one-armed detective in bronze armor, holding a broken blade.\nBackground: an old railway station.' })
    const sent = generate.mock.calls[0][0]
    for (const detail of ['sixty-year-old', 'one-armed', 'bronze armor', 'broken blade', 'old railway station']) expect(sent).toContain(detail)
    expect(sent).toMatch(new RegExp(`人物频道约束 \\[${channel}\\]`))
    expect(sent).toContain(COVER_FRAME_SAFETY_PROMPT)
  })

  it('只换画风不会删除带媒介词的手改人物，书名与署名仍原样发送', async () => {
    const { service, generate, input } = await fixture()
    await service.generate({ ...input, visualDirection: '二次元风格，只改变画风',
      promptOverride: input.promptOverride + '\nMain subject: photorealistic live-action portrait of a sixty-year-old one-armed detective in a red raincoat.\nCUSTOM: blue railway platform sign.' })
    const sent = generate.mock.calls[0][0]
    for (const detail of ['sixty-year-old', 'one-armed', 'detective', 'red raincoat', 'CUSTOM: blue railway platform sign.']) expect(sent).toContain(detail)
    expect(sent).toContain(input.promptOverride)
  })

  it('在主进程恢复运行状态并拒绝同项目的重复生成', async () => {
    const { service, generate, input } = await fixture()
    let finish!: (value: string) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = service.generate(input)
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    const snapshot = service.getGenerationTask('p1')!
    expect(snapshot.phase).toBe('generating')
    snapshot.phase = 'failed'
    expect(service.getGenerationTask('p1')?.phase).toBe('generating')
    await expect(service.generate(input)).rejects.toThrow('COVER_GENERATION_IN_PROGRESS')
    expect(generate).toHaveBeenCalledOnce()
    const canvas = new Canvas(24, 32)
    finish((await canvas.toBuffer('png')).toString('base64'))
    const cover = await pending
    expect(service.getGenerationTask('p1')).toMatchObject({ phase: 'completed', cover: { fileName: cover.fileName } })
  })

  it('取消即使模型迟到返回也不提交图片，终态可查询并可重试', async () => {
    const { service, generate, input, png } = await fixture()
    let finish!: (value: string) => void
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = service.generate(input)
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    expect(service.cancelGeneration('p1')).toEqual({ ok: true })
    expect(generate.mock.calls[0][2]?.aborted).toBe(true)
    finish(png.toString('base64'))
    await expect(pending).rejects.toThrow('COVER_GENERATION_CANCELLED')
    expect(service.getGenerationTask('p1')?.phase).toBe('cancelled')
    expect(await service.list('p1')).toEqual([])
    expect(service.cancelGeneration('p1')).toEqual({ ok: false })
    generate.mockResolvedValue(png.toString('base64'))
    await service.generate(input)
    expect(service.getGenerationTask('p1')?.phase).toBe('completed')
  })

  it('坏图片在版本预留前被拒绝，历史没有损坏占位文件', async () => {
    const { service, generate, input, dir } = await fixture()
    generate.mockResolvedValue(Buffer.from('not an image').toString('base64'))
    await expect(service.generate(input)).rejects.toThrow('COVER_INVALID_IMAGE')
    expect(service.getGenerationTask('p1')?.phase).toBe('failed')
    expect(await fs.readdir(dir)).toEqual([])
    expect(await service.list('p1')).toEqual([])
  })

  it('正式提交中断时清理本版本全部产物，允许后续重新生成', async () => {
    const { service, input, dir } = await fixture()
    const rename = fs.rename.bind(fs)
    const fault = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).endsWith('_上传.png')) throw new Error('simulated disk failure')
      await rename(source, target)
    })
    await expect(service.generate(input)).rejects.toThrow('simulated disk failure')
    expect(await fs.readdir(dir)).toEqual([])
    expect(await service.list('p1')).toEqual([])
    fault.mockRestore()
    const result = await service.generate(input)
    expect(result.version).toBe(1)
    expect((await service.list('p1')).map((file) => file.fileName)).toEqual(['封面_v1.png', '封面_v1_上传.png'])
  })

  it('保存过程中禁止取消，未提交版本在列表中不可见', async () => {
    const { service, input, dir } = await fixture()
    const rename = fs.rename.bind(fs)
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    let saving = false
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).endsWith('封面_v1.png')) {
        saving = true
        await gate
      }
      await rename(source, target)
    })
    const pending = service.generate(input)
    await vi.waitFor(() => expect(saving).toBe(true))
    expect(service.getGenerationTask('p1')?.phase).toBe('saving')
    expect(service.cancelGeneration('p1')).toEqual({ ok: false })
    expect(await service.list('p1')).toEqual([])
    expect((await fs.readdir(dir)).some((name) => name.endsWith('_原始.png'))).toBe(true)
    finish()
    await pending
    expect(await service.list('p1')).toHaveLength(2)
  })

  it('旧版本仍能列出，有新格式但无提交标记的文件和坏图被排除', async () => {
    const { service, dir, png } = await fixture()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, '封面_v1.png'), png)
    await fs.writeFile(join(dir, '封面_v2.png'), 'broken image')
    await fs.writeFile(join(dir, '封面_v3.png'), png)
    await fs.writeFile(join(dir, '封面_v3.metadata.json'), JSON.stringify({ storageVersion: 2 }))
    expect((await service.list('p1')).map((file) => file.version)).toEqual([1])
  })

  it('原始图或上传图仍存在的旧版本不会被后续生成覆盖', async () => {
    const { service, input, dir, png } = await fixture()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, '封面_v5_原始.png'), png)
    await fs.writeFile(join(dir, '封面_v6_上传.png'), png)
    const result = await service.generate(input)
    expect(result.version).toBe(7)
    expect(await fs.readFile(join(dir, '封面_v5_原始.png'))).toEqual(png)
    expect(await fs.readFile(join(dir, '封面_v6_上传.png'))).toEqual(png)
  })

  it('保留原图全部上下边缘，主成品不放大，上传版尺寸准确并显示低清提示', async () => {
    const { service, input, dir } = await fixture()
    const result = await service.generate(input)
    expect(result.originalFileName).toBe('封面_v1_原始.png')
    expect(result.warnings?.join('')).toContain('清晰度不足')
    const original = await pixels(join(dir, result.originalFileName!))
    expect(original).toMatchObject({ width: 96, height: 144, top: [255, 0, 0, 255], bottom: [0, 0, 255, 255] })
    expect(await pixels(join(dir, result.fileName))).toMatchObject({ width: 96, height: 128 })
    expect(await pixels(join(dir, '封面_v1_上传.png'))).toMatchObject({ width: 600, height: 800 })
    expect(await service.readAsDataURL('p1', result.originalFileName!)).toMatch(/^data:image\/png;base64,/)
    expect(await service.list('p1')).toHaveLength(2)
  })

  it('重新裁剪可保留顶部或底部，成品与上传版同步且不改变原图和学习来源', async () => {
    const { service, input, dir } = await fixture()
    await service.generate(input)
    const before = await fs.readFile(join(dir, '封面_v1_原始.png'))
    const oldMetadata = JSON.parse(await fs.readFile(join(dir, '封面_v1.metadata.json'), 'utf8'))
    await service.updateFeedback({ projectId: 'p1', fileName: '封面_v1.png', status: 'adopted', reason: '保留' })
    const top = await service.updateCrop({ projectId: 'p1', fileName: '封面_v1_上传.png', offsetY: 0 })
    expect((await pixels(join(dir, '封面_v1.png'))).top).toEqual([255, 0, 0, 255])
    expect((await pixels(join(dir, '封面_v1_上传.png'))).top).toEqual([255, 0, 0, 255])
    expect(top.feedback?.status).toBe('adopted')
    const bottom = await service.updateCrop({ projectId: 'p1', fileName: '封面_v1.png', offsetY: 1 })
    expect((await pixels(join(dir, '封面_v1.png'))).bottom).toEqual([0, 0, 255, 255])
    expect(bottom.generationMetadata?.generatedAt).toBe(oldMetadata.generatedAt)
    expect(await fs.readFile(join(dir, '封面_v1_原始.png'))).toEqual(before)
    expect(bottom.generationMetadata?.crop).toEqual({ offsetX: 0.5, offsetY: 1, fit: 'cover' })
  })

  it('保留全图模式同时保留上下边缘，参数越界在修改文件前被拒绝', async () => {
    const { service, input, dir } = await fixture()
    await service.generate(input)
    const before = await fs.readFile(join(dir, '封面_v1.png'))
    await expect(service.updateCrop({ projectId: 'p1', fileName: '封面_v1.png', offsetY: 2 })).rejects.toThrow('COVER_INVALID_CROP')
    expect(await fs.readFile(join(dir, '封面_v1.png'))).toEqual(before)
    const result = await service.updateCrop({ projectId: 'p1', fileName: '封面_v1.png', fit: 'contain' })
    const image = await loadImage(join(dir, '封面_v1.png'))
    const canvas = new Canvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const center = Math.floor(image.width / 2)
    expect([...context.getImageData(center, 0, 1, 1).data]).toEqual([255, 0, 0, 255])
    expect([...context.getImageData(center, image.height - 1, 1, 1).data]).toEqual([0, 0, 255, 255])
    expect(result.generationMetadata?.crop?.fit).toBe('contain')
  })

  it('重新裁剪保存失败回退原成品、上传图和元数据', async () => {
    const { service, input, dir } = await fixture()
    await service.generate(input)
    const names = ['封面_v1.png', '封面_v1_上传.png', '封面_v1.metadata.json']
    const before = await Promise.all(names.map((name) => fs.readFile(join(dir, name))))
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).endsWith('.metadata.json')) throw new Error('simulated crop failure')
      await rename(source, target)
    })
    await expect(service.updateCrop({ projectId: 'p1', fileName: '封面_v1.png', offsetY: 0 })).rejects.toThrow('simulated crop failure')
    expect(await Promise.all(names.map((name) => fs.readFile(join(dir, name))))).toEqual(before)
    expect(await service.list('p1')).toHaveLength(2)
    expect((await fs.readdir(dir)).some((name) => name.startsWith('.cover-') || name.endsWith('.updating'))).toBe(false)
  })

  it('拒绝对没有原图的旧版本或路径穿越文件重新裁剪', async () => {
    const { service, dir, png } = await fixture()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, '封面_v1.png'), png)
    await expect(service.updateCrop({ projectId: 'p1', fileName: '封面_v1.png' })).rejects.toThrow('COVER_NO_ORIGINAL')
    await expect(service.updateCrop({ projectId: 'p1', fileName: '../封面_v1.png' })).rejects.toThrow('非法封面文件名')
  })
})
