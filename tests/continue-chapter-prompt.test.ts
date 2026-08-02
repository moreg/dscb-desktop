import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

/**
 * 续写（existingText）路径的 prompt 行为。
 * 覆盖：extend/finish 模式切换、前部截断、自检清单在续写下的措辞。
 */
describe('续写 prompt', () => {
  let ps: ProjectService
  let projectId: string

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aw-cont-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '续写测试', genre: '都市' })).id
  })

  /** 写一份细纲，指定本章字数预估 */
  async function writeOutline(wordEstimate: string): Promise<void> {
    const dir = await ps.resolveDir(projectId)
    await mkdir(path.join(dir, '细纲'), { recursive: true })
    await writeFile(
      path.join(dir, '细纲', '第01卷.md'),
      `# 第01卷\n\n## 第1章：测试章节\n\n**核心事件：** 测试事件\n**字数预估：** ${wordEstimate}\n`,
      'utf-8'
    )
  }

  it('无 existingText 时按整章字数下限出指令', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const prompt = await service.buildChapterPrompt(projectId, 1)
    expect(prompt.targetWords).toBe(2500)
    expect(prompt.user).toContain('正文不少于 2500 字')
    expect(prompt.user).not.toContain('本章已写正文前部')
  })

  it('已写部分较短时进入 extend 模式，目标字数只算剩余额度', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const existing = '甲'.repeat(1000)
    const prompt = await service.buildChapterPrompt(projectId, 1, null, undefined, existing)

    expect(prompt.targetWords).toBe(1500)
    expect(prompt.user).toContain('本次继续写不少于 1500 字')
    expect(prompt.user).not.toContain('本章篇幅已经写够了')
    expect(prompt.user).toContain('本章已写正文前部')
  })

  it('已写部分达标时进入 finish 模式，改为收尾而不是继续加码', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const existing = '甲'.repeat(2400)
    const prompt = await service.buildChapterPrompt(projectId, 1, null, undefined, existing)

    // 回归：旧逻辑 max(500, 2500-2400) 会强制再写 500 字，章节永远收不了尾
    expect(prompt.user).toContain('本章篇幅已经写够了')
    expect(prompt.user).toContain('收尾')
    expect(prompt.user).not.toContain('这是硬性下限')
    expect(prompt.targetWords).toBeLessThan(500)
  })

  it('已写部分超出预估时同样走 finish 模式，不会出现负数字数', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const existing = '甲'.repeat(5000)
    const prompt = await service.buildChapterPrompt(projectId, 1, null, undefined, existing)

    expect(prompt.targetWords).toBeGreaterThan(0)
    expect(prompt.user).toContain('本章篇幅已经写够了')
  })

  it('超长已写前部被截断，保留头尾并标注省略字数', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const head = '头'.repeat(100)
    const middle = '中'.repeat(9000)
    const tail = '尾'.repeat(100)
    const existing = head + middle + tail
    const prompt = await service.buildChapterPrompt(projectId, 1, null, undefined, existing)

    expect(prompt.user).toContain('省略本章中段')
    expect(prompt.user).toContain(head)
    expect(prompt.user).toContain(tail)
    // 整段前部不应被原样塞进 prompt
    expect(prompt.user).not.toContain(existing)
  })

  it('短前部不截断', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const existing = '甲'.repeat(200)
    const prompt = await service.buildChapterPrompt(projectId, 1, null, undefined, existing)

    expect(prompt.user).toContain(existing)
    expect(prompt.user).not.toContain('省略本章中段')
  })

  /**
   * 写后自检的连续性三项（上章悬念/上章未完成/人物位置）依赖 prevEndingState。
   * 自检本身不打 LLM，所以只在「写本章正文时刚提取过」的缓存命中时才跑得上。
   */
  describe('写后自检复用上章结尾状态缓存', () => {
    async function seedPrevChapter(): Promise<void> {
      const dir = await ps.resolveDir(projectId)
      await mkdir(path.join(dir, '正文'), { recursive: true })
      await writeFile(
        path.join(dir, '正文', '第001章 上一章.md'),
        '他站在码头上，望着远处的船。到底走不走，他还没想好。',
        'utf-8'
      )
    }

    const endingStateJson = JSON.stringify({
      characterPositions: [{ name: '他', location: '码头', action: '眺望' }],
      characterStates: [],
      timePoint: '傍晚',
      unfinished: ['还没决定走不走'],
      suspense: '他到底走不走',
      props: []
    })

    it('缓存未命中时降级跳过三项，且不额外打 LLM', async () => {
      await seedPrevChapter()
      const llm = mockLlm(endingStateJson)
      const service = new WriteService(ps, llm)

      const report = await service.selfCheckChapter(projectId, 2, '他终于上了船。')

      expect(llm.generateStream).not.toHaveBeenCalled()
      expect(report.items.some((i) => i.id === 'prev_suspense')).toBe(false)
      expect(report.items.some((i) => i.id === 'char_position')).toBe(false)
    })

    it('写本章正文后缓存命中，三项连续性检查真正出现在报告里', async () => {
      await writeOutline('2500')
      await seedPrevChapter()
      const llm = mockLlm(endingStateJson)
      const service = new WriteService(ps, llm)

      // 走一次写正文的 prompt 构造，填充上章结尾状态缓存
      await service.buildChapterPrompt(projectId, 2)
      const callsAfterPrompt = (llm.generateStream as ReturnType<typeof vi.fn>).mock.calls.length
      expect(callsAfterPrompt).toBe(1)

      const report = await service.selfCheckChapter(projectId, 2, '他终于上了船。')

      // 自检没有再打一次 LLM
      expect((llm.generateStream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsAfterPrompt
      )
      expect(report.items.some((i) => i.id === 'prev_suspense')).toBe(true)
      expect(report.items.some((i) => i.id === 'unfinished_0')).toBe(true)
      expect(report.items.some((i) => i.id === 'char_position')).toBe(true)
    })
  })

  /**
   * 写前清单与写后自检必须对齐：写后自检会判的项，写前就得告诉模型。
   * 判定范围见 chapter-self-check.ts——上章未完成看**全章**，续写这一轮也在范围内。
   */
  it('续写时保留「上章未完成」——写后自检按全章判它，删掉就是让模型对着没见过的要求挨判', async () => {
    await writeOutline('2500')
    const dir = await ps.resolveDir(projectId)
    await mkdir(path.join(dir, '正文'), { recursive: true })
    await writeFile(
      path.join(dir, '正文', '第001章 上一章.md'),
      '他站在码头上，望着远处的船。到底走不走，他还没想好。',
      'utf-8'
    )
    const service = new WriteService(
      ps,
      mockLlm(
        JSON.stringify({
          characterPositions: [{ name: '他', location: '码头', action: '眺望' }],
          characterStates: [],
          timePoint: '傍晚',
          unfinished: ['还没决定走不走'],
          suspense: '他到底走不走',
          props: []
        })
      )
    )

    const prompt = await service.buildChapterPrompt(
      projectId,
      2,
      null,
      undefined,
      '甲'.repeat(500)
    )

    expect(prompt.user).toContain('上章未完成')
    expect(prompt.user).toContain('还没决定走不走')
    // 悬念也保留，但改成「前部没回应就本次补上」的措辞
    expect(prompt.user).toContain('上章悬念')
    expect(prompt.user).toContain('若【本章已写正文前部】尚未回应')
  })

  /**
   * system prompt 的通用守则是按「从零写整章」写死的，且允许用户在设置里覆盖，
   * 逐条改内置文本既盖不全也会破坏用户自定义。改成末尾追加覆盖声明，
   * 这几条断言钉住「续写时冲突条款确实被改写过」。
   */
  describe('system prompt 续写覆盖声明', () => {
    it('非续写时不出现覆盖声明', async () => {
      await writeOutline('2500')
      const service = new WriteService(ps, mockLlm(''))
      const prompt = await service.buildChapterPrompt(projectId, 1)

      expect(prompt.system).not.toContain('续写模式覆盖声明')
      expect(prompt.continueMode).toBeUndefined()
    })

    it('extend：字数是本次增量，章末不得强行收尾', async () => {
      await writeOutline('2500')
      const service = new WriteService(ps, mockLlm(''))
      const prompt = await service.buildChapterPrompt(
        projectId,
        1,
        null,
        undefined,
        '甲'.repeat(500)
      )

      expect(prompt.continueMode).toBe('extend')
      expect(prompt.system).toContain('续写模式覆盖声明')
      // 与 OUTPUT_RULES「章末必须以对话或事件结尾，违反此条立即视为失败」冲突的改写
      expect(prompt.system).toContain('不要强行收尾')
      expect(prompt.system).toContain('本次要新增')
      // 与 CONTINUITY_RULES「本章开头必须回应或延续」冲突的改写
      expect(prompt.system).toContain('禁止重写、复述或另起一个开头')
    })

    it('finish：明确宣布「字数硬性下限」本次不适用，且要求收尾', async () => {
      await writeOutline('2500')
      const service = new WriteService(ps, mockLlm(''))
      const prompt = await service.buildChapterPrompt(
        projectId,
        1,
        null,
        undefined,
        '甲'.repeat(2400)
      )

      expect(prompt.continueMode).toBe('finish')
      // 回归：user prompt 说「不要凑字数拉长」，system 却说「宁可写超」，finish 模式会被压过去
      expect(prompt.system).toContain('本次**不适用**')
      expect(prompt.system).toContain('收束本章')
      expect(prompt.system).not.toContain('不要强行收尾')
    })
  })

  /**
   * 自检清单当初已按续写改过措辞，但它上游的「衔接原料 / 上一章结尾状态」两段
   * 仍写着「本章开头必须对接此处状态」——同一份 prompt 里前后打架。
   */
  it('续写时上游衔接段不再要求「开头对接」，改成不矛盾 + 前部漏了才补', async () => {
    await writeOutline('2500')
    const dir = await ps.resolveDir(projectId)
    await mkdir(path.join(dir, '正文'), { recursive: true })
    await writeFile(
      path.join(dir, '正文', '第001章 上一章.md'),
      '他站在码头上，望着远处的船。到底走不走，他还没想好。',
      'utf-8'
    )
    const service = new WriteService(
      ps,
      mockLlm(
        JSON.stringify({
          characterPositions: [{ name: '他', location: '码头', action: '眺望' }],
          characterStates: [],
          timePoint: '傍晚',
          unfinished: ['还没决定走不走'],
          suspense: '他到底走不走',
          props: []
        })
      )
    )

    const cont = await service.buildChapterPrompt(projectId, 2, null, undefined, '甲'.repeat(500))
    expect(cont.user).not.toContain('本章开头必须对接')
    expect(cont.user).toContain('不要回头改开头')
    expect(cont.user).toContain('前部若已回应就不要再回应一遍')
    expect(cont.user).toContain('整章含已写前部必须处理')

    // 非续写路径保持原措辞
    const fresh = await service.buildChapterPrompt(projectId, 2)
    expect(fresh.user).toContain('本章开头必须对接')
  })

  it('续写时给出剧情点进度对齐指令（细纲每轮整份重发，不点明就会重复或跳点）', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const prompt = await service.buildChapterPrompt(
      projectId,
      1,
      null,
      undefined,
      '甲'.repeat(500)
    )

    expect(prompt.user).toContain('进度对齐')
    expect(prompt.user).toContain('第一个未写的剧情点')
  })

  it('中段省略标记不采用括号省略句式（deslop 占位符硬规则会拦这个形状）', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const prompt = await service.buildChapterPrompt(
      projectId,
      1,
      null,
      undefined,
      '中'.repeat(9000)
    )

    expect(prompt.user).toContain('省略本章中段')
    // check-degeneration.ts PLACEHOLDER_PATTERNS 的括号省略正则
    expect(prompt.user).not.toMatch(/[（(](此处|以下|这里|下文|后续)?\s*(省略|略)(去|过)?[^）)]{0,10}[）)]/)
  })

  it('续写时自检清单改为对接已写前部，不再要求「开头」对齐上一章', async () => {
    await writeOutline('2500')
    const service = new WriteService(ps, mockLlm(''))
    const existing = '甲'.repeat(500)
    const prompt = await service.buildChapterPrompt(projectId, 1, null, undefined, existing)

    expect(prompt.user).toContain('接续点连续')
    expect(prompt.user).toContain('不重复前部')
    expect(prompt.user).not.toContain('上章结尾对接')
  })
})
