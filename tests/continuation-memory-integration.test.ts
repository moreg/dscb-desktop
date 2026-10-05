import { createWritingProject } from './helpers/writing-project'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { OutlineRepository } from '../src/main/data/outline-repository'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

describe('续写质量与长篇记忆集成', () => {
  let root: string
  let dir: string
  let id: string
  let service: WriteService
  let generateStream: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'continuation-memory-'))
    const settings = { getProjectsRoot: async (fallback: string) => fallback } as SettingsRepository
    const projects = new ProjectService(join(root, 'projects'), new LibraryRepository(join(root, 'library.json')), settings)
    id = (await createWritingProject(projects, { name: '长篇证据', genre: '玄幻' })).id
    dir = await projects.resolveDir(id)
    generateStream = vi.fn().mockResolvedValue('{}')
    const llm = { generateStream } as unknown as LlmService
    service = new WriteService(projects, llm)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('生成服务为手机和批量调用返回纯正文，同时保留流式伏笔回执供编辑器处理', async () => {
    const raw = '他在门上看见 Keep Out，便收回了手。\n\n【本章伏笔回执】\n{"planted":["门上的警告"],"collected":[]}'
    generateStream.mockImplementation(async (_prompt, options) => {
      options.onToken(raw)
      return raw
    })
    const onToken = vi.fn()
    const result = await service.generateChapterStream(id, 1, { onToken })
    expect(result).toBe('他在门上看见Keep Out，便收回了手。')
    expect(onToken).toHaveBeenCalledWith(raw)
  })

  it('生成结果大段复制远章正文时拦截返回，不交给调用方保存', async () => {
    const old = '陆安推开祠堂的木门，一枚青铜钥匙从门楣上落下。他用袖口接住钥匙，看见齿缝中塞着尚未干透的红泥。院里没有脚印，只有井沿留着半只破鞋。他把钥匙放进内袋，绕过供桌走到后窗。窗纸上新割出的孔洞正对着山路，一匹无人的马停在那里，鞍边挂着他昨夜交给弟弟的包袱。'
    await new ProseRepo(dir).write(3, old, '钥匙')
    generateStream.mockResolvedValue(old)
    await expect(service.generateChapterStream(id, 250)).rejects.toThrow('LLM_PROSE_REPETITION')
  })

  it('字数上限不转成必须补足的下限，保留剧情完成后的停止选项', async () => {
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '交还信物', wordEstimate: '不超过3000字' })
    const p = await service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(2000))
    expect(p.wordTarget.bound).toBe('about')
    expect(p.user).toContain('这是剩余上限，允许少写')
    expect(p.user).toContain('若剧情已全部完成，可自然结束')
    expect(p.user).not.toMatch(/不少于\s*1000|新增\s*1000\s*字.{0,8}硬性下限/)
  })

  it('保留7600字符长章中段独有事实和未完台词', async () => {
    const fact = '阿明把唯一的虎符烧成了灰，此后再无虎符。'
    const existing = '甲'.repeat(3000) + fact + '乙'.repeat(4500) + '他问：“证据究竟在'
    const p = await service.buildChapterPrompt(id, 1, null, undefined, existing)
    expect(p.user).toContain(existing)
    expect(p.user).toContain('先续完末尾未完成的句子、台词或动作')
    expect(p.user).not.toContain('省略本章中段')
  })

  it('超出同章上下文预算时明确拒绝，不偷偷丢掉中段', async () => {
    await expect(service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(40001)))
      .rejects.toThrow('CHAPTER_CONTEXT_TOO_LARGE')
  })
  it('接近字数上限时收尾预算不超过剩余额度，已经达到上限则不追加字数任务', async () => {
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 1, plotSummary: '交还信物', wordEstimate: '不超过3000字' })
    const near = await service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(2950))
    expect(near.targetWords).toBe(50)
    const done = await service.buildChapterPrompt(id, 1, null, undefined, '甲'.repeat(3000))
    expect(done.targetWords).toBe(0)
    expect(done.user).toContain('额度为零且末句已完整时无需新增正文')
  })

  it('第250章能召回第3章的道具原文，改写后不会继续引用旧版本', async () => {
    const prose = new ProseRepo(dir)
    await prose.write(3, '陆安将乌金虎符投入熔炉，虎符融成铁水。从此军令只能由印信传递。', '焚符')
    await prose.write(240, '新的一日，陆安抵达边城。', '边城')
    await new OutlineRepository(dir).upsertDetailed({ chapterNumber: 250, plotSummary: '陆安调查乌金虎符的下落', charactersAppearing: ['陆安'] })
    const first = await service.buildChapterPrompt(id, 250)
    expect(first.user).toContain('与本章有关的历史正文证据')
    expect(first.user).toContain('第 3 章 · 正文/')
    expect(first.user).toContain('虎符融成铁水')
    await prose.write(3, '陆安将乌金虎符封进石匣，交给守门人保管。', '焚符')
    const next = await service.buildChapterPrompt(id, 250)
    expect(next.user).toContain('交给守门人保管')
    expect(next.user).not.toContain('虎符融成铁水')
  })

  it('正文与细纲不同时，近期记忆不把计划包装成已发生事实', async () => {
    await new ProseRepo(dir).write(1, '陆安仍未找到母亲，渡船停在岸边。', '寻找')
    await mkdir(join(dir, '细纲'), { recursive: true })
    await writeFile(join(dir, '细纲', '细纲_第001章_寻找.md'), '# 寻找\n\n- **核心事件**：陆安救出了母亲，渡船沉没。')
    const p = await service.buildChapterPrompt(id, 2)
    const previousProse = p.user.split('**上一章完整正文**')[1]?.split('```')[1] ?? ''
    expect(previousProse).toContain('陆安仍未找到母亲')
    expect(previousProse).not.toContain('陆安救出了母亲')
  })

  it('回写旧章不注入未来时间线与已撤销的设定演进', async () => {
    await mkdir(join(dir, '追踪'), { recursive: true })
    await writeFile(join(dir, '追踪', '时间线.md'), '# 时间线\n\n## 历史事件与小说事件对照表\n\n| 章节 | 事件 |\n|---|---|\n| 第8章 | 旧友到访 |\n| 第11章 | 秘密未来伏击 |\n')
    await writeFile(join(dir, '追踪', '设定演进.md'), '# 设定演进\n\n| 日期 | 章节 | 类型 | 文件 | 摘要 | 状态 |\n|---|---|---|---|---|---|\n| 今天 | 第8章 | 能力 | 规则 | 已知规则 | 已应用 |\n| 今天 | 第9章 | 能力 | 规则 | 撤销规则 | 已撤销 |\n| 今天 | 第100章 | 能力 | 规则 | 未来称帝规则 | 已应用 |\n')
    const p = await service.buildChapterPrompt(id, 10)
    expect(p.user).toContain('已知规则')
    expect(p.user).not.toContain('秘密未来伏击')
    expect(p.user).not.toContain('未来称帝规则')
    expect(p.user).not.toContain('撤销规则')
  })
})
