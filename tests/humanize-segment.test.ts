import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService, parseHumanizerOutput } from '../src/main/data/write-service'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { LlmService } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return { generateStream: vi.fn().mockResolvedValue(reply) } as unknown as LlmService
}

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

describe('parseHumanizerOutput', () => {
  it('parses well-formed output with 【改写后】 and 【改动说明】', () => {
    const raw = `【改写后】
她没笑，只看了他一眼。

【改动说明】
- 删除"嘴角带了点弧度"，换成具体行为
- 加"没接话"留白`
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('她没笑，只看了他一眼。')
    expect(r.reason).toContain('删除"嘴角带了点弧度"')
  })

  it('strips surrounding markdown fences', () => {
    const raw = `【改写后】
\`\`\`
她笑了一下。
\`\`\`

【改动说明】
- 直接用"笑了一下"`
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('她笑了一下。')
  })

  it('falls back to whole input when no markers', () => {
    const raw = '整段没有标签的内容'
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('整段没有标签的内容')
    expect(r.reason).toContain('未按预期格式')
  })

  it('handles missing 【改动说明】 section', () => {
    const raw = '【改写后】\n他顿了顿。\n'
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('他顿了顿。')
    expect(r.reason).toContain('未提供改动说明')
  })

  it('returns empty result for empty input', () => {
    const r = parseHumanizerOutput('   ')
    expect(r.rewritten).toBe('')
    expect(r.reason).toBe('')
  })

  it('handles multi-line 改写后 content', () => {
    const raw = `【改写后】
第一段改了。
第二段也改了。
第三段保留原文事实。

【改动说明】
- 删 AI 套话
- 加行为描写`
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toContain('第一段改了。')
    expect(r.rewritten).toContain('第二段也改了。')
    expect(r.reason).toContain('删 AI 套话')
  })
})

describe('WriteService.humanizeSegment', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-hz-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '古风仙侠' })).id
  })

  it('returns rewritten text on success', async () => {
    const llmReply = `【改写后】
他看了她一眼，没接话。

【改动说明】
- 删"嘴角带了点弧度"`
    const service = new WriteService(ps, mockLlm(llmReply))
    const result = await service.humanizeSegment(
      projectId,
      '他嘴角带了点弧度，什么都没说。',
      '嘴角+弧度底层模式'
    )
    expect(result.rewritten).toBe('他看了她一眼，没接话。')
    expect(result.reason).toContain('嘴角')
  })

  it('returns empty rewritten + error reason on LLM failure', async () => {
    const llm = {
      generateStream: vi.fn().mockRejectedValue(new Error('网络超时'))
    } as unknown as LlmService
    const service = new WriteService(ps, llm)
    const result = await service.humanizeSegment(
      projectId,
      '他心中一动。',
      '心理描写模板'
    )
    expect(result.rewritten).toBe('')
    expect(result.reason).toContain('网络超时')
  })

  it('returns empty rewritten when snippet is empty', async () => {
    const service = new WriteService(ps, mockLlm('ignored'))
    const result = await service.humanizeSegment(projectId, '   ', 'something')
    expect(result.rewritten).toBe('')
    expect(result.reason).toContain('空')
  })

  it('passes xianxia genre voice to the LLM prompt (verified via call args)', async () => {
    const llm = mockLlm('【改写后】\n他没接话。\n\n【改动说明】\n- 删 AI 词')
    const service = new WriteService(ps, llm)
    await service.humanizeSegment(
      projectId,
      '他似乎隐藏着什么。',
      '似乎隐藏着什么（套话）'
    )
    expect(llm.generateStream).toHaveBeenCalledTimes(1)
    const [, opts] = (llm.generateStream as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { systemPrompt?: string; meta?: { feature?: string } }
    ]
    // system prompt 应含古风/仙侠 题材（来自项目 genre）
    expect(opts.systemPrompt).toContain('古风')
    expect(opts.systemPrompt).toContain('仙侠')
    // meta.feature 标记为 humanize（用于用量统计）
    expect(opts.meta?.feature).toBe('humanize')
  })

  it('falls back to urban voice when project genre is unknown', async () => {
    // 新建无 genre 的项目
    const id2 = (await ps.create({ name: '匿名' })).id
    const llm = mockLlm('【改写后】\n他笑了一下。\n\n【改动说明】\n- 替换')
    const service = new WriteService(ps, llm)
    await service.humanizeSegment(id2, '她笑了一下', 'check')
    const [, opts] = (llm.generateStream as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { systemPrompt?: string }
    ]
    // 兜底应是 modern urban
    expect(opts.systemPrompt).toMatch(/现代|都市/)
  })
})

describe('parseHumanizerOutput (edge cases for batch flow)', () => {
  it('trims whitespace around 改写后 content', () => {
    const raw = `【改写后】\n\n  \n她笑了一下。\n  \n\n【改动说明】\n- 替换`
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('她笑了一下。')
  })

  it('handles 改动说明 with bullet markers', () => {
    const raw = `【改写后】\n她顿了顿。\n\n【改动说明】\n- 删"似乎"\n- 加"没接话"\n- 留白`
    const r = parseHumanizerOutput(raw)
    expect(r.reason).toContain('删"似乎"')
    expect(r.reason).toContain('加"没接话"')
    expect(r.reason).toContain('留白')
  })

  it('preserves inline punctuation in rewrite', () => {
    const raw = `【改写后】\n"你——"她没说完。\n\n【改动说明】\n- 删"他似乎"插入语`
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('"你——"她没说完。')
  })

  it('handles code-fenced rewrite with Chinese punctuation inside', () => {
    const raw = `【改写后】\n\`\`\`\n她抬眼，没接话。\n\`\`\`\n\n【改动说明】\n- 替换`
    const r = parseHumanizerOutput(raw)
    expect(r.rewritten).toBe('她抬眼，没接话。')
  })

  it('does not confuse 改写后 markers in body text', () => {
    // 边界：原文里出现"【改写后】"字面字符串，应只匹配外层标签
    const raw = `【改写后】\n她听懂了【改写后】这个标签，但没用。\n\n【改动说明】\n- 删冗余`
    const r = parseHumanizerOutput(raw)
    // 取到第二个【改写后】之前的全部内容
    expect(r.rewritten).toContain('她听懂了【改写后】这个标签')
  })
})

describe('WriteService.humanizeSegment (batch integration)', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-hzb-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '古风' })).id
  })

  it('handles sequential multi-call (batch) deterministically', async () => {
    const llm = mockLlm('【改写后】\n他没接话。\n\n【改动说明】\n- 删 AI 词')
    const service = new WriteService(ps, llm)
    const snippets = [
      '他似乎在想什么。',
      '她似乎隐藏着什么。',
      '他似乎要说什么。'
    ]
    // 串行模拟"批量改写"
    const results = []
    for (const s of snippets) {
      results.push(await service.humanizeSegment(projectId, s, 'test'))
    }
    expect(results).toHaveLength(3)
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
    for (const r of results) {
      expect(r.rewritten).toBe('他没接话。')
    }
  })

  it('one failure does not block subsequent calls in batch', async () => {
    let callCount = 0
    const llm = {
      generateStream: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 2) return Promise.reject(new Error('第 2 次失败'))
        return Promise.resolve('【改写后】\n改完了。\n\n【改动说明】\n- ok')
      })
    } as unknown as LlmService
    const service = new WriteService(ps, llm)
    const results = []
    for (const s of ['片段1', '片段2', '片段3']) {
      results.push(await service.humanizeSegment(projectId, s, 'test'))
    }
    expect(results[0].rewritten).toBe('改完了。')
    expect(results[1].rewritten).toBe('')
    expect(results[1].reason).toContain('第 2 次失败')
    expect(results[2].rewritten).toBe('改完了。')
  })

  it('uses meta.feature=humanize for usage accounting', async () => {
    const llm = mockLlm('【改写后】\nok\n\n【改动说明】\n- ok')
    const service = new WriteService(ps, llm)
    await service.humanizeSegment(projectId, '片段', 'rule-x')
    const [, opts] = (llm.generateStream as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { meta?: { feature?: string; projectId?: string } }
    ]
    expect(opts.meta?.feature).toBe('humanize')
    expect(opts.meta?.projectId).toBe(projectId)
  })
})

describe('WriteService.humanizeSegment (deslop pipeline 路径)', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-hzd-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '古风' })).id
  })

  it('注入 deslopService 后走 deslop pipeline（mild 级别）', async () => {
    // 用会命中 deslop 扫描器的 snippet（"仿佛"是 Gate A 禁用词）
    const llmReply = `【改写后】
他没接话，转身走了。

【改动说明】
- 第1行｜原句：仿佛 -> 改后：删 ｜理由：书面比喻破坏口语语感`
    const llm = mockLlm(llmReply)
    const deslopService = new DeslopService(llm)
    // 注入 deslopService 作为第 8 个构造参数
    const service = new WriteService(ps, llm, undefined, undefined, undefined, undefined, undefined, deslopService)
    const result = await service.humanizeSegment(
      projectId,
      '他仿佛在想着什么，什么都没说。',
      '仿佛（书面比喻腔）'
    )
    // 走 deslop pipeline 后返回 rewritten
    expect(result.rewritten).toBe('他没接话，转身走了。')
    // reason 来自 changeSummary
    expect(result.reason).toContain('仿佛')
  })

  it('deslop pipeline 失败时返回错误 reason', async () => {
    const llm = {
      generateStream: vi.fn().mockRejectedValue(new Error('网络超时'))
    } as unknown as LlmService
    const deslopService = new DeslopService(llm)
    const service = new WriteService(ps, llm, undefined, undefined, undefined, undefined, undefined, deslopService)
    // "仿佛" 命中 Gate A，触发 deslop 改写 -> LLM 失败
    const result = await service.humanizeSegment(projectId, '他仿佛在想什么。', '仿佛')
    expect(result.rewritten).toBe('')
    expect(result.reason).toContain('网络超时')
  })

  it('空 snippet 仍返回空结果（走 deslop 路径前拦截）', async () => {
    const llm = mockLlm('ignored')
    const deslopService = new DeslopService(llm)
    const service = new WriteService(ps, llm, undefined, undefined, undefined, undefined, undefined, deslopService)
    const result = await service.humanizeSegment(projectId, '   ', 'something')
    expect(result.rewritten).toBe('')
    expect(result.reason).toContain('空')
  })
})
