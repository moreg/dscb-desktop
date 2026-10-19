import { describe, expect, it, vi } from 'vitest'
import { reviewSceneDialogue } from '../src/main/data/scene-dialogue-review'
import { ensureDialogueQuality } from '../src/main/data/dialogue-quality'
import { DIALOGUE_VITALITY_RULES } from '../src/main/data/skill-prompts/scene-naturalness'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'

const text = '“我怕他们等烦了”\n“你不用担心”\n“那我再试一次”\n“行，我给你找”\n她们仍在镜子前。'
const evidence = { excerpt: text, reason: '连续回合仍由一人提出担忧，另一人宽慰安排，反复处理相似问题' }
const mock = (reply: (prompt: string, options: GenerateOptions) => string): LlmService =>
  ({ generateStream: vi.fn(reply) }) as unknown as LlmService

describe('独立整场对白复核', () => {
  it('预算耗尽保留原稿并单独返回待复核候选，不能丢掉修稿成果或颁发通过', async () => {
    const source = `“${'我'.repeat(40)}”\n${'他'.repeat(60)}。`
    const draft = source.replace('我', '你')
    const llm = mock((prompt, opts) => opts.meta?.feature === 'deslop:scene-dialogue-review'
      ? JSON.stringify({ passed: false, assessment: '仍须整场修订', reviewedPassages: [{ excerpt: source, reason: '测试定位的问题' }],
        findings: [{ excerpt: source, reason: '测试定位的问题' }] })
      : JSON.stringify({ text: draft }))
    const output = await ensureDialogueQuality(source, source, llm, { mode: 'write', maxRepairs: 1 })
    expect(output.text).toBe(source)
    expect(output.report).toMatchObject({ passed: false, pendingDraft: draft })
    expect(output.factsUnchanged).toBeUndefined()
  })

  it('整场语义替换不被数字筛选拆散，中间比例暂时偏离仍重新修复后验收', async () => {
    const original = `“${'我'.repeat(70)}”\n${'他'.repeat(30)}。`
    const reorganized = `“${'你'.repeat(65)}”\n${'她'.repeat(35)}。`
    const accepted = `“${'你'.repeat(70)}”\n${'她'.repeat(30)}。`
    const llm = mock((prompt, opts) => {
      if (opts.meta?.feature === 'deslop:dialogue-review') return JSON.stringify({ passed: true, factsUnchanged: true, issues: [], expressionFindings: [] })
      if (opts.meta?.feature === 'deslop:scene-dialogue-review') {
        const current = prompt.split('【待审核稿】\n\n').at(-1)!
        const bad = current === original
        const passage = { excerpt: current, reason: bad ? '必须整场重组' : '模拟已检查重组后的连续回合' }
        return JSON.stringify({ passed: !bad, assessment: passage.reason, reviewedPassages: [passage], findings: bad ? [passage] : [] })
      }
      const before = prompt.split('【本次正文】\n\n').at(-1)!
      return JSON.stringify({ patches: [{ before, after: before === original ? reorganized : accepted }] })
    })
    const output = await ensureDialogueQuality(original, original, llm, { mode: 'write' })
    expect(output.text).toBe(accepted)
    expect(output.report).toMatchObject({ passed: true, attempts: 2, afterRatio: .7 })
  })

  it('比例不足时也先诊断整场，并将问题交给同一次修复而非先凑字数', async () => {
    const source = `“${'我'.repeat(40)}”\n${'他'.repeat(60)}。`
    const llm = mock((prompt, opts) => {
      if (opts?.meta?.feature === 'deslop:scene-dialogue-review') return JSON.stringify({ passed: false,
        assessment: '必须重组整场重复接话', reviewedPassages: [{ excerpt: source, reason: '多个回合重复同一功能' }],
        findings: [{ excerpt: source, reason: '多个回合重复同一功能' }] })
      expect(prompt).toContain('多个回合重复同一功能')
      expect(prompt).toContain('一处可覆盖完整的连续场景')
      return '{}'
    })
    const result = await ensureDialogueQuality(source, source, llm, { mode: 'write', maxRepairs: 1 })
    expect(result.report.passed).toBe(false)
    expect(vi.mocked(llm.generateStream).mock.calls.map(([,opts]) => opts?.meta?.feature))
      .toEqual(['deslop:scene-dialogue-review', 'deslop:dialogue-repair'])
  })

  it.each([
    { passed: true, issues: [] },
    { passed: true, assessment: '通过', reviewedPassages: [], findings: [] },
    { passed: true, assessment: '只看单句就放行', reviewedPassages: [{ excerpt: '“你不用担心”', reason: '这句合理' }], findings: [] },
    { passed: true, assessment: '通过', reviewedPassages: [{ excerpt: '并不存在的台词', reason: '合理' }], findings: [] },
    { passed: true, assessment: '仍有机械组织', reviewedPassages: [evidence], findings: [evidence] },
    { passed: false, assessment: '有问题', reviewedPassages: [evidence], findings: [] }
  ])('无证据或矛盾结果不能通过：%j', async verdict => {
    expect(await reviewSceneDialogue(text, mock(() => JSON.stringify(verdict))))
      .toMatchObject({ passed: false, valid: false })
  })

  it('复核必须看本次要求、修订前全文和上轮问题，不能只看新句子', async () => {
    const llm = mock(prompt => {
      expect(prompt).toContain('【本次作者修订要求（审核约束）】\n\n保留语气但重组整场')
      expect(prompt).toContain('【修订前正文（仅核对交流组织变化）】\n\n旧的完整场景')
      expect(prompt).toContain('配角仍在轮流配合')
      return JSON.stringify({ passed: false, assessment: evidence.reason, reviewedPassages: [evidence], findings: [evidence] })
    })
    await reviewSceneDialogue(text, llm, { previousText: '旧的完整场景', instruction: '保留语气但重组整场',
      priorFindings: ['配角仍在轮流配合'] })
  })

  it('真实连续段落的负面结论必须阻止通过，复核收到共享整场规则', async () => {
    const llm = mock(prompt => {
      expect(prompt).toContain(DIALOGUE_VITALITY_RULES)
      expect(prompt).toContain('不负责算对白比例')
      return JSON.stringify({ passed: false, assessment: evidence.reason, reviewedPassages: [evidence], findings: [evidence] })
    })
    expect(await reviewSceneDialogue(text, llm)).toEqual({ passed: false, valid: true, issues: [`${text}：${evidence.reason}`] })
  })

  it('联合检查通过后仍须独立复核，独立失败不能颁发验收凭据', async () => {
    const source = `“${'我'.repeat(70)}”\n${'他'.repeat(30)}。`
    const llm = mock((_prompt, opts) => opts?.meta?.feature === 'deslop:dialogue-review'
      ? JSON.stringify({ passed: true, factsUnchanged: true, issues: [], expressionFindings: [] })
      : JSON.stringify({ passed: false, assessment: '按上下文识别仍在机械重复',
        reviewedPassages: [{ excerpt: source, reason: '测试中明确指出仍需整场修订' }],
        findings: [{ excerpt: source, reason: '测试中明确指出仍需整场修订' }] }))
    const output = await ensureDialogueQuality(source, source, llm, { mode: 'write', maxRepairs: 0 })
    expect(output.report.passed).toBe(false)
    expect(output.factsUnchanged).toBeUndefined()
    expect(vi.mocked(llm.generateStream).mock.calls.map(([, opts]) => opts?.meta?.feature))
      .toEqual(['deslop:dialogue-review', 'deslop:scene-dialogue-review'])
  })
})
