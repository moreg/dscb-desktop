import { describe, expect, it, vi } from 'vitest'
import { AGY_PROMPT_BUDGET, buildAntigravityPrompt } from '../src/main/data/antigravity-prompt'
import { buildSystemPrompt } from '../src/main/data/skill-prompts'
import { LlmService } from '../src/main/data/llm-service'
import type { SecretStore } from '../src/main/data/secret-store'
import { runAntigravity } from '../src/main/data/antigravity-runner'
import { runCodex } from '../src/main/data/codex-runner'

vi.mock('../src/main/data/antigravity-runner', () => ({
  runAntigravity: vi.fn(async () => ({ full: '正文' })), probeAntigravity: vi.fn()
}))
vi.mock('../src/main/data/codex-runner', () => ({
  runCodex: vi.fn(async () => ({ full: '正文' })), probeCodex: vi.fn()
}))

const task = '# 第 2 章 写作任务\n临时要求：必须保留\n本章细纲：先开门再对质，不能提前揭底。'
const draft = '**【本章已写正文前部】**\n```\n已写正文不得删减\n# 项目设定\n这是正文内的标题\n```'
const ending = '# 现在请写第 2 章正文\n只补剩余 500 字，不重写前部，只输出正文。'
const longPrompt = [
  '小说《测试》', '# 项目设定', '### 世界规则', '设定。'.repeat(10000),
  '### 金手指', '规则。'.repeat(8000), task,
  '# 第 1 章 衔接原料', '上章正文。'.repeat(2500), '上章最后一句必须衔接',
  '# 上一章结尾状态（结构化提取）', '人物在门口，没有拿到钥匙。',
  '# 角色信息', '### 甲', '人物甲。'.repeat(3000), '### 乙', '人物乙。'.repeat(3000),
  '---', draft, ending
].join('\n')

describe('agy prompt budget', () => {
  it('将长篇检查的 10 分钟预算传给实际 AGY runner', async () => {
    const service = new LlmService({ read: async () => ({ activeId: 'agy', providers: [
      { id: 'agy', label: 'agy', protocol: 'antigravity', model: '', baseUrl: '', apiKey: '' }
    ] }) } as unknown as SecretStore)
    await service.generateStream('核对完整章节与历史记忆', { maxTokens: 3000, meta: { feature: 'longformGuard' } })
    expect(vi.mocked(runAntigravity).mock.calls.at(-1)![1]?.timeoutSec).toBe(600)
  })
  it('leaves short requests unchanged and caps long review inputs', () => {
    expect(buildAntigravityPrompt('任务', '规则', '前缀')).toBe('前缀规则\n\n---\n\n任务')
    const source = '审核原文，不可遗漏：' + '文'.repeat(40000)
    const out = buildAntigravityPrompt(source + '\n只输出 JSON', undefined, '')
    expect(out.length).toBe(AGY_PROMPT_BUDGET)
    expect(out).toMatch(/^审核原文，不可遗漏：/)
    expect(out.endsWith('只输出 JSON')).toBe(true)
    expect(out).toContain('中间部分已截取省略')
  })

  it('fits large chapter backgrounds while retaining instructions, draft, state and document names', () => {
    const system = buildSystemPrompt('玄幻修真', null, undefined, undefined, 'finish')
    const out = buildAntigravityPrompt(longPrompt, system, '只执行本轮任务\n')
    expect(out.length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
    for (const value of [system, task, draft, ending, '人物在门口，没有拿到钥匙。',
      '### 世界规则', '### 金手指', '### 甲', '### 乙', '上章最后一句必须衔接']) {
      expect(out).toContain(value)
    }
    expect(out).toContain('此处省略部分背景')
  })

  it('rejects oversized chapter task instead of silently dropping the middle of the outline', () => {
    const prompt = [task, '本章细纲'.repeat(10000), ending].join('\n')
    expect(() => buildAntigravityPrompt(prompt, undefined, '')).toThrow('AGY_WRITING_CONTEXT_TOO_LARGE')
  })

  it('caps oversized system prompts and continuation drafts too', () => {
    const out = buildAntigravityPrompt('正文审核', '规则'.repeat(25000), '前缀')
    expect(out.length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
    expect(out.startsWith('前缀')).toBe(true)
    expect(out.endsWith('正文审核')).toBe(true)
    expect(() => buildAntigravityPrompt([task, draft, '正文'.repeat(25000), ending].join('\n'), '规则'.repeat(25000), '前缀'))
      .toThrow('AGY_WRITING_CONTEXT_TOO_LARGE')
  })

  it('never dispatches a writing request whose essential outline exceeds the model limit', async () => {
    const service = new LlmService({ read: async () => ({ activeId: 'agy', providers: [
      { id: 'agy', label: 'agy', protocol: 'antigravity', model: '', baseUrl: '', apiKey: '' }
    ] }) } as unknown as SecretStore)
    vi.mocked(runAntigravity).mockClear()
    await expect(service.generateStream([task, '细纲'.repeat(20000), ending].join('\n'), { meta: { feature: 'chapter' } }))
      .rejects.toThrow('AGY_WRITING_CONTEXT_TOO_LARGE')
    expect(runAntigravity).not.toHaveBeenCalled()
  })

  it('preserves the full current outline, repair feedback and draft when trimming long repair context', () => {
    const outline = '# 第 4 章 写作任务\n细纲必须先取信再记账。\n写作禁区：不能提前揭底。'
    const draftText = '第一段正文。\n' + '实际正文。'.repeat(1000) + '\n章末原句。'
    const prompt = [
      '修复任务', '--- 最初确认的问题 ---', '本章：事实错误',
      '--- 本轮需要解决的问题或上轮复检反馈 ---', '不得虚构谈话',
      '--- 前文、细纲、记忆及作者要求（按来源使用） ---', '背景'.repeat(18000), outline,
      '# 第 3 章 衔接原料', '旧文'.repeat(12000), '--- 当前原稿（本轮所有替换均基于此稿） ---', draftText
    ].join('\n')
    const result = buildAntigravityPrompt(prompt, '仅修复冲突。', '')
    expect(result.length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
    for (const text of [outline, draftText, '本章：事实错误', '不得虚构谈话']) expect(result).toContain(text)
    expect(result).toContain('此处省略部分背景')
  })

  it('refuses a repair if the protected draft and outline alone exceed the input limit', () => {
    const prompt = ['修复任务', '--- 最初确认的问题 ---', '错误',
      '--- 前文、细纲、记忆及作者要求（按来源使用） ---', '# 第 4 章 写作任务\n重点细纲',
      '--- 当前原稿（本轮所有替换均基于此稿） ---', '完整原稿'.repeat(10000)].join('\n')
    expect(() => buildAntigravityPrompt(prompt, undefined, '')).toThrow('AGY_REPAIR_CONTEXT_TOO_LARGE')
  })

  it('includes merged overhead in the limit and handles exact boundaries and emoji', () => {
    for (const size of [AGY_PROMPT_BUDGET - 1, AGY_PROMPT_BUDGET, AGY_PROMPT_BUDGET + 1]) {
      const prompt = '字'.repeat(size)
      const out = buildAntigravityPrompt(prompt, undefined, '')
      expect(out.length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
      if (size <= AGY_PROMPT_BUDGET) expect(out).toBe(prompt)
    }
    const out = buildAntigravityPrompt('😀'.repeat(20000), '规则', '前缀')
    expect(out.length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('protects the entire continuation draft appended to a background section', () => {
    const prose = '开头' + '正文'.repeat(4000) + '中间关键证据' + '正文'.repeat(4000) + '结尾'
    const prompt = [task, '# 伏笔追踪', '伏笔'.repeat(25000),
      '**【本章已写正文前部】**（不要重写）', '```', prose, '```', ending].join('\n')
    const out = buildAntigravityPrompt(prompt, '规则', '')
    expect(out.length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
    expect(out).toContain(prose)
  })

  it('compacts only the resolved agy provider, including feature routing', async () => {
    const config = { activeId: 'codex', providers: [
      { id: 'agy', label: 'agy', protocol: 'antigravity', model: '', baseUrl: '', apiKey: '' },
      { id: 'codex', label: 'codex', protocol: 'codex', model: '', baseUrl: '', apiKey: '' }
    ], featureRouting: { chapter: { providerId: 'agy' } } }
    const service = new LlmService({ read: async () => config } as unknown as SecretStore)
    await service.generateStream(longPrompt, { systemPrompt: '保留规则', meta: { feature: 'chapter' } })
    expect(vi.mocked(runAntigravity).mock.calls.at(-1)![0].length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
    await service.generateStream(longPrompt, { systemPrompt: '保留规则' })
    expect(vi.mocked(runCodex).mock.calls.at(-1)![0]).toContain(longPrompt)
    await service.generateStream('审核：' + '文'.repeat(40000), {
      systemPrompt: '严格输出 JSON', meta: { feature: 'chapter' }
    })
    expect(vi.mocked(runAntigravity).mock.calls.at(-1)![0].length).toBeLessThanOrEqual(AGY_PROMPT_BUDGET)
  })
})
