import { describe, it, expect } from 'vitest'
import {
  buildStructureJudgePrompt,
  parseStructureJudgeOutput,
  structureDimensionName,
  STRUCTURE_DIMENSIONS
} from '../src/main/data/skill-prompts/deslop/structure-judge'
import { DeslopService, CHUNK_MAX_WORDS } from '../src/main/data/deslop/deslop-service'
import type { LlmService, GenerateOptions } from '../src/main/data/llm-service'

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: 'cognitive-blindspot',
    line: 2,
    excerpt: '他知道她在撒谎',
    why: '人物的判断永远正确，没有误判的余地',
    suggestion: '让他判断错一次：他以为她在撒谎，其实她说的是实话',
    ...over
  }
}

/** 按 prompt 里的行号回一份 findings；prompt 变了也能自动对齐分块偏移 */
function makeJudgeLlm(respond: (firstLine: number, prompt: string) => string): LlmService {
  return {
    generateStream: async (prompt: string, _opts: GenerateOptions = {}): Promise<string> => {
      const m = /^(\d+)\| /m.exec(prompt)
      return respond(m ? Number(m[1]) : 1, prompt)
    }
  } as unknown as LlmService
}

describe('structure-judge: prompt', () => {
  it('正文带全局行号，分块时从 startLine 开始编号', () => {
    const prompt = buildStructureJudgePrompt('第一行\n第二行', 41)
    expect(prompt).toContain('41| 第一行')
    expect(prompt).toContain('42| 第二行')
  })

  it('五个维度全部写进 prompt，id 与常量表一致', () => {
    const prompt = buildStructureJudgePrompt('正文', 1)
    for (const d of STRUCTURE_DIMENSIONS) {
      expect(prompt).toContain(d.id)
      expect(prompt).toContain(d.name)
    }
    expect(STRUCTURE_DIMENSIONS).toHaveLength(5)
  })

  it('明确要求不查用词标点（那是第一层的活）', () => {
    expect(buildStructureJudgePrompt('正文', 1)).toContain('不要查用词')
  })

  it('支持传入细纲与目标上下文，注入剧情规划参考', () => {
    const prompt = buildStructureJudgePrompt('正文', 1, {
      outlineSummary: '主角在宗门大比反杀赵执事',
      chapterGoal: '引爆情绪高潮'
    })
    expect(prompt).toContain('细纲与剧情规划参考')
    expect(prompt).toContain('主角在宗门大比反杀赵执事')
    expect(prompt).toContain('引爆情绪高潮')
  })
})

describe('structure-judge: 输出解析', () => {
  it('解析纯 JSON 数组', () => {
    const out = parseStructureJudgeOutput(JSON.stringify([finding()]), 1, 10)
    expect(out).not.toBeNull()
    expect(out).toHaveLength(1)
    expect(out![0].dimension).toBe('cognitive-blindspot')
    expect(out![0].line).toBe(2)
  })

  it('容忍前后解释文字与代码块围栏', () => {
    const wrapped = '好的，我看完了。\n```json\n' + JSON.stringify([finding()]) + '\n```\n以上。'
    expect(parseStructureJudgeOutput(wrapped, 1, 10)).toHaveLength(1)
  })

  it('空数组返回 []（体检通过），不是 null', () => {
    expect(parseStructureJudgeOutput('[]', 1, 10)).toEqual([])
  })

  it('完全不是 JSON 返回 null（要计入 unparsedChunks，不能当成体检通过）', () => {
    expect(parseStructureJudgeOutput('这段正文我觉得没什么问题。', 1, 10)).toBeNull()
    expect(parseStructureJudgeOutput('', 1, 10)).toBeNull()
  })

  it('截断的 JSON 返回 null，不吐半条', () => {
    expect(parseStructureJudgeOutput('[{"dimension":"fake-obstacle","line":3,', 1, 10)).toBeNull()
  })

  it('丢弃未知维度', () => {
    const out = parseStructureJudgeOutput(JSON.stringify([finding({ dimension: '编的维度' })]), 1, 10)
    expect(out).toEqual([])
  })

  it('丢弃越界行号（模型自己数行经常越界）', () => {
    const out = parseStructureJudgeOutput(
      JSON.stringify([finding({ line: 999 }), finding({ line: 0 }), finding({ line: 5 })]),
      1,
      10
    )
    expect(out).toHaveLength(1)
    expect(out![0].line).toBe(5)
  })

  it('分块时按该块的行号区间过滤', () => {
    const body = JSON.stringify([finding({ line: 3 }), finding({ line: 45 })])
    expect(parseStructureJudgeOutput(body, 41, 60)).toHaveLength(1)
    expect(parseStructureJudgeOutput(body, 41, 60)![0].line).toBe(45)
  })

  it('丢弃缺 why / suggestion 的条目（没有行动价值）', () => {
    const out = parseStructureJudgeOutput(
      JSON.stringify([finding({ why: '' }), finding({ suggestion: '  ' }), finding({ excerpt: '' })]),
      1,
      10
    )
    expect(out).toEqual([])
  })

  it('excerpt 截到 80 字', () => {
    const out = parseStructureJudgeOutput(JSON.stringify([finding({ excerpt: '字'.repeat(200) })]), 1, 10)
    expect(out![0].excerpt).toHaveLength(80)
  })

  it('条目数封顶，模型刷屏也不会撑爆面板', () => {
    const many = Array.from({ length: 50 }, (_, i) => finding({ line: (i % 9) + 1 }))
    expect(parseStructureJudgeOutput(JSON.stringify(many), 1, 10)!.length).toBeLessThanOrEqual(12)
  })

  it('非数组 JSON 返回 null', () => {
    expect(parseStructureJudgeOutput('{"dimension":"fake-obstacle"}', 1, 10)).toBeNull()
  })

  it('维度中文名可查，未知 id 原样返回', () => {
    expect(structureDimensionName('fake-obstacle')).toBe('阻力虚张声势（假危机）')
    expect(structureDimensionName('npc-explainer')).toBe('配角/反派交底说明书')
    expect(structureDimensionName('closed-unit')).toBe('每段自带收束（旧）')
  })
})

describe('DeslopService.judgeStructure', () => {
  const text = '第一行正文。\n第二行正文。\n第三行正文。'

  it('正常返回清单，chunks=1 且无解析失败', async () => {
    const svc = new DeslopService(makeJudgeLlm(() => JSON.stringify([finding({ line: 2 })])))
    const report = await svc.judgeStructure(text)
    expect(report.chunks).toBe(1)
    expect(report.unparsedChunks).toBe(0)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].suggestion).toContain('判断错一次')
  })

  it('模型没吐出 JSON 时计入 unparsedChunks，而不是报「体检通过」', async () => {
    const svc = new DeslopService(makeJudgeLlm(() => '我觉得这段写得挺好的。'))
    const report = await svc.judgeStructure(text)
    expect(report.unparsedChunks).toBe(1)
    expect(report.findings).toEqual([])
  })

  it('同维度同一行只留一条', async () => {
    const svc = new DeslopService(
      makeJudgeLlm(() => JSON.stringify([finding({ line: 2 }), finding({ line: 2 }), finding({ line: 3 })]))
    )
    const report = await svc.judgeStructure(text)
    expect(report.findings).toHaveLength(2)
  })

  it('按行号排序', async () => {
    const svc = new DeslopService(
      makeJudgeLlm(() =>
        JSON.stringify([finding({ line: 3 }), finding({ line: 1, dimension: 'closed-unit' }), finding({ line: 2 })])
      )
    )
    const lines = (await svc.judgeStructure(text)).findings.map((f) => f.line)
    expect(lines).toEqual([1, 2, 3])
  })

  it('长文分块送检，行号按 startLine 校正回全局', async () => {
    // 超过 CHUNK_MAX_WORDS 才会切块；每块都报它自己的第一行
    const long = Array.from({ length: CHUNK_MAX_WORDS }, (_, i) => `第${i}行的正文内容。`).join('\n')
    const svc = new DeslopService(
      makeJudgeLlm((firstLine) => JSON.stringify([finding({ line: firstLine })]))
    )
    const report = await svc.judgeStructure(long)
    expect(report.chunks).toBeGreaterThan(1)
    expect(report.unparsedChunks).toBe(0)
    // 每块一条，行号各不相同且递增 —— 没做偏移的话会全部挤在第 1 行
    expect(report.findings.length).toBe(report.chunks)
    const lines = report.findings.map((f) => f.line)
    expect(new Set(lines).size).toBe(lines.length)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
    expect(Math.max(...lines)).toBeGreaterThan(1)
  })

  it('部分块解析失败不影响其余块', async () => {
    const long = Array.from({ length: CHUNK_MAX_WORDS }, (_, i) => `第${i}行的正文内容。`).join('\n')
    let call = 0
    const svc = new DeslopService(
      makeJudgeLlm((firstLine) => {
        call += 1
        return call === 1 ? '没问题。' : JSON.stringify([finding({ line: firstLine })])
      })
    )
    const report = await svc.judgeStructure(long)
    expect(report.unparsedChunks).toBe(1)
    expect(report.findings.length).toBe(report.chunks - 1)
  })
})
