import { formatChapterProse } from '../src/shared/format-chapter-prose'
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
    const llm = mock((prompt, opts) => opts.meta?.feature === 'deslop:dialogue-review' ? JSON.stringify({passed:true,factsUnchanged:true,issues:[],expressionFindings:[]}) : opts.meta?.feature === 'deslop:scene-dialogue-review'
      ? JSON.stringify({ passed: false, assessment: '仍须整场修订', reviewedPassages: [{ excerpt: source, reason: '测试定位的问题' }],
        findings: [{ excerpt: source, reason: '测试定位的问题' }] })
      : JSON.stringify({ text: draft }))
    const output = await ensureDialogueQuality(source, source, llm, { mode: 'write', maxRepairs: 1 })
    expect(output.text).toBe(source)
    expect(output.report).toMatchObject({ passed: false, pendingDraft: formatChapterProse(draft) })
    expect(output.factsUnchanged).toBeUndefined()
  })

  it('整场修复完整应用，表达通过后不为占比再改一轮', async () => {
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
    expect(output.text).toBe(formatChapterProse(reorganized))
    expect(output.report).toMatchObject({ passed: true, attempts: 1, afterRatio: .65 })
  })

  it('比例不足时也先诊断整场，并将问题交给同一次修复而非先凑字数', async () => {
    const source = `“${'我'.repeat(40)}”\n${'他'.repeat(60)}。`
    const llm = mock((prompt, opts) => {
      if (opts?.meta?.feature === 'deslop:dialogue-review') return JSON.stringify({passed:true,factsUnchanged:true,issues:[],expressionFindings:[]})
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
      .toEqual(['deslop:dialogue-review', 'deslop:scene-dialogue-review', 'deslop:dialogue-repair'])
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

  describe('固定最初问题的修订验收', () => {
    const before = '“我怕他们等烦了”\n“你不用担心”\n“那我再试一次”\n“行，我给你找”'
    const after = '“我怕他们等烦了”\n“店里刚来电话，最后一件也卖了”\n她放下镜子，拨通店员的电话。'
    const baseline = { text: before, issues: ['反复以安慰回应担忧，交谈缺少推进。'] }
    const resolution = { id: 1, status: 'resolved', before, after,
      reason: '店员售罄的消息使角色从重复寻求安慰转为直接联系店员，原来两个安慰回合不再重复。' }
    const accepted = (baselineResolutions: unknown = [resolution]) => ({
      passed: true, assessment: '新信息改变行动，未再重复安慰回合。',
      reviewedPassages: [{ excerpt: after, reason: resolution.reason }], findings: [], baselineResolutions
    })

    it('逐项核对固定最初稿，与上轮稿和上轮问题分别提供，复用一次审核', async () => {
      const llm = mock(prompt => {
        expect(prompt).toContain('【固定最初被拒稿（只用于核对原问题与纠正误报）】\n\n' + before)
        expect(prompt).toContain(JSON.stringify([{ id: 1, issue: baseline.issues[0] }]))
        expect(prompt).toContain('【修订前正文（仅核对交流组织变化）】\n\n上轮另有新增问题的稿件')
        expect(prompt).toContain('上轮多写了结尾解释')
        expect(prompt).toContain('最初判断也可能误报')
        expect(prompt).toContain('不能仅改变空白、措辞或细节')
        return JSON.stringify(accepted())
      })
      expect(await reviewSceneDialogue(after, llm, { repairBaseline: baseline,
        previousText: '上轮另有新增问题的稿件', priorFindings: ['上轮多写了结尾解释'] }))
        .toEqual({ passed: true, valid: true, issues: [], baselineResolutions: [resolution] })
      expect(llm.generateStream).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['缺少原问题验收', undefined],
      ['漏掉原问题', []],
      ['使用范围外编号', [{ ...resolution, id: 2 }]],
      ['编号不是整数', [{ ...resolution, id: 1.5 }]],
      ['伪造最初稿引句', [{ ...resolution, before: '最初稿中没有这句。' }]],
      ['伪造当前稿引句', [{ ...resolution, after: '当前稿中没有这句。' }]],
      ['空的解释', [{ ...resolution, reason: '  ' }]],
      ['问题未解决仍然通过', [{ ...resolution, status: 'unresolved' }]]
    ])('%s 时不能通过', async (_name, resolutions) => {
      const verdict = { ...accepted(), baselineResolutions: resolutions }
      expect(await reviewSceneDialogue(after, mock(() => JSON.stringify(verdict)), { repairBaseline: baseline }))
        .toMatchObject({ passed: false, valid: false })
    })

    it('每项原问题必须有独立编号，重复编号不能掩盖遗漏', async () => {
      const verdict = accepted([resolution, resolution])
      expect(await reviewSceneDialogue(after, mock(() => JSON.stringify(verdict)), {
        repairBaseline: { text: before, issues: [...baseline.issues, '另一处重复交流问题。'] }
      })).toMatchObject({ passed: false, valid: false })
    })

    it.each([before, before.replace(/\n/g, '\n\n')])('相同内容或只改空白不能标记已解决', async current => {
      const verdict = { ...accepted([{ ...resolution, after: current }]),
        reviewedPassages: [{ excerpt: current, reason: '声称已经修复。' }] }
      expect(await reviewSceneDialogue(current, mock(() => JSON.stringify(verdict)), { repairBaseline: baseline }))
        .toMatchObject({ passed: false, valid: false })
    })

    it('原问题仍在时返回有证据的不通过，而非无效或放行', async () => {
      const unresolved = { ...resolution, status: 'unresolved', after: before,
        reason: '连续两个回合仍以安慰回应担忧，组织没有变化。' }
      const passage = { excerpt: before, reason: unresolved.reason }
      const verdict = { passed: false, assessment: unresolved.reason, reviewedPassages: [passage],
        findings: [passage], baselineResolutions: [unresolved] }
      expect(await reviewSceneDialogue(before, mock(() => JSON.stringify(verdict)), { repairBaseline: baseline }))
        .toEqual({ passed: false, valid: true, issues: [`${before}：${unresolved.reason}`],
          baselineResolutions: [unresolved] })
    })

    it('基于原文明确纠正最初误报，允许正文未改也通过', async () => {
      const unchangedText = '“用药编号相同，但还不能证明药物相同，先送检”\n“我去找制备的人，问清配方”'
      const originalError = { id: 1, status: 'original_error', before: unchangedText, after: unchangedText,
        reason: '原判断将第二句误读为重复强调编号不能证明成分；原文实际提出询问制备者以取得配方的新行动，并未再次解释编号。' }
      const verdict = { passed: true, assessment: originalError.reason,
        reviewedPassages: [{ excerpt: unchangedText, reason: originalError.reason }], findings: [],
        baselineResolutions: [originalError] }
      expect(await reviewSceneDialogue(unchangedText, mock(() => JSON.stringify(verdict)), {
        repairBaseline: { text: unchangedText, issues: ['编号不能证明成分的解释重复了两遍。'] }
      })).toEqual({ passed: true, valid: true, issues: [], baselineResolutions: [originalError] })
    })

    it('没有最初问题时保持旧结果格式兼容', async () => {
      const verdict = { ...accepted(), baselineResolutions: undefined }
      expect(await reviewSceneDialogue(after, mock(() => JSON.stringify(verdict)), {
        repairBaseline: { text: before, issues: [] }
      })).toEqual({ passed: true, valid: true, issues: [] })
    })
  })
})
