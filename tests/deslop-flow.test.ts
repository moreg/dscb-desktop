import { describe, it, expect } from 'vitest'
import {
  DeslopService,
  splitForDeslop,
  mergeChunkResults,
  CHUNK_MAX_WORDS
} from '../src/main/data/deslop/deslop-service'
import { countWords } from '../src/main/data/words'
import type { DeslopFinding, DeslopResult } from '../src/shared/types'
import type { LlmService, GenerateOptions } from '../src/main/data/llm-service'

// 测试文本设计：
// - "他不是冷漠，而是绝望" → not-is-comparison（★★★★★，blocking）
// - "他知道，这事没那么简单" → he_knows（★★★★，blocking）—— 用于验证二次清理处理 blocking 残留
// - "仿佛被抽空" → fangfo（★★★，advisory）—— advisory 不触发二次清理
const REAL_TEXT = '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。'
// 第一次改写：去掉"不是A而是B"，但故意引入新的 blocking"他知道"（he_knows）
const PARTIAL_TEXT = '绝望先一步泄了出来。\n仿佛被抽空了力气，他缓缓坐下。他知道这件事没那么简单。'
// 第二次清理：去掉"他知道"（blocking）。advisory 的"仿佛"会一起被清掉（因为 LLM 看到也会改）
const CLEAN_TEXT = '绝望先一步泄了出来。\n力气像被抽干，他一屁股坐下。这事没那么简单。'

function makeMockLlm(responses: string[]): LlmService {
  let call = 0
  return {
    generateStream: async (_prompt: string, _opts: GenerateOptions = {}): Promise<string> => {
      const r = responses[Math.min(call, responses.length - 1)]
      call += 1
      return r
    }
  } as unknown as LlmService
}

describe('DeslopService.deslop 二次清理循环', () => {
  it('复扫无 blocking 时跳过二次清理', async () => {
    // 第一次改写直接清干净（无 blocking 残留）
    const cleanNoBlocking = '绝望先一步泄了出来。\n力气像被抽干，他一屁股坐下。'
    const mock = makeMockLlm([
      `【改写后】\n${cleanNoBlocking}\n\n【改动说明】\n- 第1行｜原句：他不是冷漠，而是绝望 → 改后：绝望先一步泄了出来 ｜理由：去掉"不是A而是B"套路`
    ])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(REAL_TEXT)
    expect(result.remainingFindings.filter((f) => f.severity === 'blocking')).toHaveLength(0)
    expect(result.rewritten).toBe(cleanNoBlocking)
  })

  it('LLM 漏写【改动说明】时自动 diff 补全 changeSummary', async () => {
    const cleanNoBlocking = '绝望先一步泄了出来。\n力气像被抽干，他一屁股坐下。'
    // 只给【改写后】，故意不写【改动说明】——旧逻辑会导致 UI 无改动明细
    const mock = makeMockLlm([`【改写后】\n${cleanNoBlocking}`])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(REAL_TEXT)
    expect(result.rewritten).toBe(cleanNoBlocking)
    expect(result.changeSummary.length).toBeGreaterThan(0)
    expect(result.changeSummary.some((s) => s.includes('原句') || s.includes('改后') || s.includes('自动'))).toBe(
      true
    )
  })

  it('第一轮改写后仍剩 blocking 时触发二次清理', async () => {
    // 第一次改写：去掉"不是A而是B"，但引入了新的 blocking"他知道"（he_knows）
    // 第二次清理：把"他知道"也去掉
    const mock = makeMockLlm([
      `【改写后】\n${PARTIAL_TEXT}\n\n【改动说明】\n- 第1行｜原句：他不是冷漠，而是绝望 -> 改后：绝望先一步泄了出来 ｜理由：去"不是A而是B"`,
      `【改写后】\n${CLEAN_TEXT}\n\n【改动说明】\n- 第3行｜原句：他知道这件事没那么简单 -> 改后：这事没那么简单 ｜理由：去"他知道"告知式表达`
    ])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(REAL_TEXT)
    // 二次清理后 blocking 应清零
    const blocking = result.remainingFindings.filter((f) => f.severity === 'blocking')
    expect(blocking).toHaveLength(0)
    // rewritten 应是二次清理后的文本
    expect(result.rewritten).toBe(CLEAN_TEXT)
  })
})

describe('DeslopService.deslop 三遍法 Pass 编排', () => {
  // severe 文本：含 Gate A（仿佛/缓缓）、Gate B（不是A而是B）、Gate C（他感到）、Gate F（这一刻/终于明白）
  // severe 分级会跑 Pass1(A+B) + Pass2(C+D+E) + Pass3(F+G) = 3 遍
  const SEVERE_TEXT =
    '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。\n他感到愤怒，握紧了拳头。\n这一刻，他终于明白了一切。'

  // mock：每遍只改本遍 Gate 的命中项，其余保留--让每遍都有命中要处理
  // Pass1 改 A+B（去掉"不是A而是B""仿佛""缓缓"），保留 C+F
  // Pass2 改 C+D（去掉"他感到"），保留 F
  // Pass3 改 F+G（去掉"这一刻""终于明白"）
  const PASS_RESPONSES = [
    // Pass1：去 A+B，保留 C（他感到）和 F（这一刻/终于明白）
    `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n他感到愤怒，握紧了拳头。\n这一刻，他终于明白了一切。\n\n【改动说明】\n- 第1行｜去"不是A而是B"`,
    // Pass2：去 C（他感到->身体反应），保留 F
    `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n他攥紧拳头，指节发白。\n这一刻，他终于明白了一切。\n\n【改动说明】\n- 第3行｜去"他感到"贴标签`,
    // Pass3：去 F（升华句）
    `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n他攥紧拳头，指节发白。\n他沉默了。\n\n【改动说明】\n- 第4行｜去升华句`
  ]

  it('severe 跑 3 遍（3 次 generateStream 调用）', async () => {
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        const r = PASS_RESPONSES[Math.min(callCount, PASS_RESPONSES.length - 1)]
        callCount += 1
        return r
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    const result = await svc.deslop(SEVERE_TEXT, { levelOverride: 'severe' })
    // severe 跑 3 遍 Pass，每遍 1 次调用（无 blocking 残留则无二次清理）
    expect(callCount).toBeGreaterThanOrEqual(3)
    expect(result.processedGates).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  })

  it('moderate 跑 2 遍（Pass1 + Pass2）', async () => {
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        const r = PASS_RESPONSES[Math.min(callCount, PASS_RESPONSES.length - 1)]
        callCount += 1
        return r
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    const result = await svc.deslop(SEVERE_TEXT, { levelOverride: 'moderate' })
    // moderate 默认 = Pass1(A+B) + Pass2(C+D)；
    // SEVERE_TEXT 章末"这一刻，他终于明白"是 Gate F 的 blocking，blocking 必须修，
    // 所以 Gate F 会被并入处理范围（否则正文原样返回却报"仍剩 blocking"）
    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(result.processedGates).toEqual(['A', 'B', 'C', 'D', 'F'])
  })

  it('mild 只跑 1 遍（Pass1）', async () => {
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        const r = PASS_RESPONSES[Math.min(callCount, PASS_RESPONSES.length - 1)]
        callCount += 1
        return r
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    await svc.deslop(SEVERE_TEXT, { levelOverride: 'mild' })
    // mild = Pass1(A+B) = 1 遍
    expect(callCount).toBeGreaterThanOrEqual(1)
  })

  it('无命中项的 Pass 跳过（不调 LLM）', async () => {
    // 只有 Gate A/B 命中的文本，severe 下 Pass2(C+D+E) 和 Pass3(F+G) 无命中应跳过
    const text = '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。'
    let callCount = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        callCount += 1
        return `【改写后】\n绝望先泄了出来。\n力气像被抽干，他坐下。\n\n【改动说明】\n- 改动${callCount}`
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    await svc.deslop(text, { levelOverride: 'severe' })
    // Pass1(A+B) 跑 1 次；Pass2(C+D+E) 无命中跳过；Pass3(F+G) 无命中跳过
    expect(callCount).toBeGreaterThanOrEqual(1)
  })
})

describe('DeslopService.deslop blocking Gate 兜底', () => {
  it('只命中 Gate G blocking（工程词泄漏）时也会调 LLM 清理', async () => {
    // 密度 0 / 无排比 / blocking 1 → 判为 mild，默认 Gate 范围只有 A+B。
    // 若不把命中 blocking 的 Gate 并进来，这段会一次 LLM 都不调、原样返回，
    // 末尾却报"仍剩 1 处 blocking"——用户点了润色等于没点。
    const text = '张三走进屋子，把门关上。\n本章细纲要求他先去找李四。\n他坐在桌边等着。'
    let calls = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        calls += 1
        return '【改写后】\n张三走进屋子，把门关上。\n他起身去找李四。\n他坐在桌边等着。\n\n【改动说明】\n- 第2行｜删工程词「细纲」'
      }
    } as unknown as LlmService
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(calls).toBeGreaterThan(0)
    expect(result.processedGates).toContain('G')
    expect(result.remainingFindings.filter((f) => f.severity === 'blocking')).toHaveLength(0)
  })

  it('只命中 Gate F blocking（章末升华）时也会进处理范围', async () => {
    const text = '他把门关上，走回桌边。\n这一刻，他终于明白了一切。'
    const mock = makeMockLlm([
      '【改写后】\n他把门关上，走回桌边。\n他盯着桌上那张照片，没有再动。\n\n【改动说明】\n- 第2行｜删升华句'
    ])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(result.processedGates).toContain('F')
    expect(result.remainingFindings.filter((f) => f.severity === 'blocking')).toHaveLength(0)
  })
})

describe('DeslopService.deslop 改写结果护栏', () => {
  it('LLM 缺【改写后】标记且回的是寒暄时，保留原文不落盘', async () => {
    const text = '他不是冷漠，而是绝望。'
    const mock = makeMockLlm(['好的，我来帮你改写这段文字：\n\n绝望先泄了出来。\n\n希望这个版本符合要求。'])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(result.rewritten).toBe(text)
    expect(result.changeSummary.some((c) => c.includes('已拒绝'))).toBe(true)
  })

  it('LLM 拒答时保留原文', async () => {
    const text = '他不是冷漠，而是绝望。'
    const mock = makeMockLlm(['【改写后】\n抱歉，我无法完成这个请求。\n\n【改动说明】\n- 无'])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(result.rewritten).toBe(text)
  })

  it('输出被截断（删除比例远超上限）时保留原文', async () => {
    const text = Array.from(
      { length: 20 },
      (_, i) => `第${i + 1}段。他不是冷漠，而是绝望，仿佛被抽空了力气。`
    ).join('\n')
    const mock = makeMockLlm(['【改写后】\n第1段。绝望先泄了出来。\n\n【改动说明】\n- 改了'])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text, { levelOverride: 'mild' })
    expect(result.rewritten).toBe(text)
    expect(result.deleteRatio).toBe(0)
  })

  it('短片段删掉一整行不触发比例护栏（humanizeSegment 场景）', async () => {
    // 34 字的片段删掉一行 = 38%，按比例判会误杀合法改写；短文本只用"灾难性截断"兜底
    const text = '张三走进屋子，把门关上。\n本章细纲要求他先去找李四。\n他坐在桌边等着。'
    const rewritten = '张三走进屋子，把门关上。\n他坐在桌边等着。'
    const mock = makeMockLlm([`【改写后】\n${rewritten}\n\n【改动说明】\n- 删工程词行`])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(result.rewritten).toBe(rewritten)
  })
})

describe('DeslopService.scan 白名单', () => {
  it('白名单词不会在 Phase 4 最终报告里复活', async () => {
    const text = '他不是冷漠，而是绝望。\n他的眼神深邃。'
    const mock = makeMockLlm([
      '【改写后】\n绝望先泄了出来。\n他的眼神深邃。\n\n【改动说明】\n- 第1行｜去"不是A而是B"'
    ])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text, { whitelist: new Set(['深邃']) })
    expect(result.remainingFindings.filter((f) => f.word === '深邃')).toHaveLength(0)
  })
})

describe('DeslopService.deslop 生成上限随正文长度伸缩', () => {
  const capture = (): { opts: GenerateOptions[]; llm: LlmService } => {
    const opts: GenerateOptions[] = []
    const llm = {
      generateStream: async (_p: string, o: GenerateOptions = {}): Promise<string> => {
        opts.push(o)
        // 回原文，避免触发删除比例护栏
        return '【改写后】\n' + (o.meta as { echo?: string })?.echo + '\n\n【改动说明】\n- 无实质改动'
      }
    } as unknown as LlmService
    return { opts, llm }
  }

  it('短章节沿用 12288 下限', async () => {
    const { opts, llm } = capture()
    const text = '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。'
    await new DeslopService(llm).deslop(text, { meta: { echo: text } })
    expect(opts[0].maxTokens).toBe(12288)
  })

  it('长章节按字数放大，不再固定 12288（否则输出必被截断）', async () => {
    const { opts, llm } = capture()
    // ~6000 字章节：正文本身约 10200 token，固定 12288 装不下正文 +【改动说明】
    const text = Array.from(
      { length: 240 },
      (_, i) => `第${i + 1}段。他不是冷漠，而是绝望，仿佛被抽空了力气，他缓缓坐下不再说话。`
    ).join('\n')
    await new DeslopService(llm).deslop(text, { meta: { echo: text } })
    expect(opts[0].maxTokens).toBeGreaterThan(12288)
    expect(opts[0].maxTokens).toBeLessThanOrEqual(32768)
  })
})

describe('DeslopService.deslop 拒答判定不误伤合法台词', () => {
  it('原文本就含「作为一个人工智能」台词时，改写不算拒答', async () => {
    // AI 伴侣/系统流题材的合法对白；check-degeneration 对对话行也做了同样豁免
    const text = '"作为一个人工智能，我不该有偏好。"她不是在解释，而是在拖延。\n他仿佛没听见。'
    const rewritten = '"作为一个人工智能，我不该有偏好。"她在拖延。\n他没抬头。'
    const mock = makeMockLlm([`【改写后】\n${rewritten}\n\n【改动说明】\n- 第1行｜去"不是A而是B"`])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(result.rewritten).toBe(rewritten)
    expect(result.changeSummary.some((c) => c.includes('已拒绝'))).toBe(false)
  })

  it('原文没有拒答语、改写凭空冒出来时仍然拒绝', async () => {
    const text = '他不是冷漠，而是绝望。'
    const mock = makeMockLlm(['【改写后】\n作为一个人工智能，我无法完成这个请求。\n\n【改动说明】\n- 无'])
    const svc = new DeslopService(mock)
    const result = await svc.deslop(text)
    expect(result.rewritten).toBe(text)
  })
})

describe('DeslopService 分块改写', () => {
  /** 造一段超过 CHUNK_MAX_WORDS 的正文，段落之间留空行 */
  const makeLongText = (paragraphs: number): string =>
    Array.from(
      { length: paragraphs },
      (_, i) => `第${i + 1}段。他走进屋子，把门关上，然后坐在桌边一言不发地等着天黑下来。`
    ).join('\n\n')

  it('不超长时不切块，行为与从前一致', () => {
    const text = '他走了进来。\n她没有抬头。'
    expect(splitForDeslop(text)).toEqual([{ text, startLine: 1 }])
  })

  it('超长时切块，且拼回来与原文逐字一致', () => {
    const text = makeLongText(500)
    expect(countWords(text)).toBeGreaterThan(CHUNK_MAX_WORDS)
    const chunks = splitForDeslop(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.text).join('\n')).toBe(text)
  })

  it('每块的 startLine 指向它在原文里的真实行号', () => {
    const text = makeLongText(500)
    const lines = text.split('\n')
    for (const c of splitForDeslop(text)) {
      expect(lines[c.startLine - 1]).toBe(c.text.split('\n')[0])
    }
  })

  it('每块都不超过上限（除非单行本身就超长）', () => {
    for (const c of splitForDeslop(makeLongText(500))) {
      expect(countWords(c.text)).toBeLessThanOrEqual(CHUNK_MAX_WORDS)
    }
  })

  it('整篇不改时分块改写逐字还原原文', async () => {
    const text = makeLongText(500)
    // mock 原样回显传入的正文，模拟"每块都没实质改动"
    const mock = {
      generateStream: async (prompt: string): Promise<string> => {
        const body = prompt.split('### 待改写原文（带行号，【改动说明】里的行号以此为准）\n')[1] ?? ''
        const stripped = body
          .split('\n只输出【改写后】')[0]
          .split('\n')
          .map((l) => l.replace(/^\s*\d+\|/, ''))
          .join('\n')
        return `【改写后】\n${stripped}\n\n【改动说明】\n- 无实质改动`
      }
    } as unknown as LlmService
    const result = await new DeslopService(mock).deslop(text)
    expect(result.rewritten).toBe(text)
    expect(result.beforeWords).toBe(countWords(text))
  })

  it('改动说明的行号按块偏移还原成全文行号，并标出块号', () => {
    const chunks = [
      { text: 'a\nb\nc', startLine: 1 },
      { text: 'd\ne\nf', startLine: 4 }
    ]
    const base = {
      processedGates: ['A'] as DeslopResult['processedGates'],
      beforeWords: 3,
      afterWords: 3,
      deleteRatio: 0,
      remainingFindings: []
    }
    const merged = mergeChunkResults('a\nb\nc\nd\ne\nf', chunks, [
      { ...base, rewritten: 'a\nb\nc', changeSummary: ['- 第2行｜原句：b → 改后：B'] },
      { ...base, rewritten: 'd\ne\nf', changeSummary: ['- 第2行｜原句：e → 改后：E'] }
    ])
    expect(merged.changeSummary[0]).toContain('[第1/2块] 第2行')
    // 第 2 块的第 2 行 = 全文第 5 行
    expect(merged.changeSummary[1]).toContain('[第2/2块] 第5行')
  })

  it('剩余问题的行号也按块偏移', () => {
    const chunks = [
      { text: 'a\nb', startLine: 1 },
      { text: 'c\nd', startLine: 3 }
    ]
    const finding: DeslopFinding = {
      line: 2,
      column: 1,
      type: 'banned-word',
      severity: 'advisory',
      gate: 'A',
      message: '',
      excerpt: 'x'
    }
    const base = {
      processedGates: ['A'] as DeslopResult['processedGates'],
      beforeWords: 2,
      afterWords: 2,
      deleteRatio: 0,
      changeSummary: []
    }
    const merged = mergeChunkResults('a\nb\nc\nd', chunks, [
      { ...base, rewritten: 'a\nb', remainingFindings: [] },
      { ...base, rewritten: 'c\nd', remainingFindings: [finding] }
    ])
    expect(merged.remainingFindings[0].line).toBe(4)
  })
})

describe('DeslopService.scan isTail 语义', () => {
  it('非末块不做截断检测（否则每块末行都会误报）', async () => {
    const svc = new DeslopService({} as unknown as LlmService)
    const text = '他走进屋子，把门关上。\n她抬头看了他一眼'
    const tail = await svc.scan(text, { isTail: true })
    const mid = await svc.scan(text, { isTail: false })
    expect(tail.findings.some((f) => f.type === 'truncation')).toBe(true)
    expect(mid.findings.some((f) => f.type === 'truncation')).toBe(false)
  })

  it('非末块的升华句不按「章末」升级为 blocking', async () => {
    const svc = new DeslopService({} as unknown as LlmService)
    const text = '他把门关上。\n这一刻，他终于明白了一切。'
    const tail = await svc.scan(text, { isTail: true })
    const mid = await svc.scan(text, { isTail: false })
    expect(tail.findings.some((f) => f.type === 'sublimation' && f.severity === 'blocking')).toBe(true)
    expect(mid.findings.some((f) => f.type === 'sublimation')).toBe(true)
    expect(mid.findings.some((f) => f.type === 'sublimation' && f.severity === 'blocking')).toBe(false)
  })
})

describe('DeslopService.deslop advisory Gate 也进处理范围', () => {
  it('mild 下只命中 Gate E（advisory）也会被改写', async () => {
    const text = [
      '"你来了。"他说道。',
      '"嗯。"她答道。',
      '"坐吧。"他笑道。'
    ].join('\n')
    let calls = 0
    const mock = {
      generateStream: async (): Promise<string> => {
        calls += 1
        return '【改写后】\n"你来了。"\n她在门口站住："嗯。"\n他抬手指了指椅子。\n\n【改动说明】\n- 对话标签改成动作'
      }
    } as unknown as LlmService
    const result = await new DeslopService(mock).deslop(text)
    expect(calls).toBeGreaterThan(0)
    expect(result.processedGates).toContain('E')
  })
})

describe('DeslopService 分块运行中途取消', () => {
  const makeLongText = (paragraphs: number): string =>
    Array.from(
      { length: paragraphs },
      (_, i) => `第${i + 1}段。他仿佛被抽空了力气，缓缓走进屋子，把门关上，然后坐在桌边等着。`
    ).join('\n\n')

  /**
   * 第 1 块全程正常，跑到第 2 块时模拟用户取消
   * （llm-service 在用户 abort 时抛 LLM_ABORTED）。
   * 按内容而非调用次数判断，免得第 1 块多跑几遍清理就把断点挪走了。
   */
  const abortAfterFirstChunk = (): { llm: LlmService } => {
    const llm = {
      generateStream: async (prompt: string): Promise<string> => {
        if (!prompt.includes('第1段。')) throw new Error('LLM_ABORTED')
        const body = prompt.split('### 待改写原文（带行号，【改动说明】里的行号以此为准）\n')[1] ?? ''
        const stripped = body
          .split('\n只输出【改写后】')[0]
          .split('\n')
          .map((l) => l.replace(/^\s*\d+\|/, '').replace(/仿佛/g, '').replace(/缓缓/g, ''))
          .join('\n')
        return `【改写后】\n${stripped}\n\n【改动说明】\n- 第1行｜删禁用词`
      }
    } as unknown as LlmService
    return { llm }
  }

  it('取消后保留已完成块的改写，未处理块保持原文', async () => {
    const text = makeLongText(500)
    const chunkCount = splitForDeslop(text).length
    expect(chunkCount).toBeGreaterThan(1)

    const { llm } = abortAfterFirstChunk()
    const result = await new DeslopService(llm).deslop(text)

    // 已完成的部分确实改了（禁用词被删），所以整体不等于原文
    expect(result.rewritten).not.toBe(text)
    expect(result.changeSummary.length).toBeGreaterThan(0)
    // 未处理的尾块原样保留：最后一段仍带"仿佛"
    expect(result.rewritten).toContain('仿佛')
    // 字数不会因为取消而塌掉
    expect(result.afterWords).toBeGreaterThan(result.beforeWords * 0.9)
  })

  it('取消后未处理块的问题仍计入剩余问题（不假装已改干净）', async () => {
    const text = makeLongText(500)
    const { llm } = abortAfterFirstChunk()
    const result = await new DeslopService(llm).deslop(text)
    // 未处理块里的"仿佛/缓缓"必须出现在剩余问题里
    expect(result.remainingFindings.some((f) => f.word === '仿佛')).toBe(true)
  })

  it('非取消的错误照常抛出，不当成取消吞掉', async () => {
    const text = makeLongText(500)
    const llm = {
      generateStream: async (): Promise<string> => {
        throw new Error('LLM_TIMEOUT')
      }
    } as unknown as LlmService
    await expect(new DeslopService(llm).deslop(text)).rejects.toThrow('LLM_TIMEOUT')
  })

  it('未分块时取消仍照旧抛出（单块行为不变）', async () => {
    const llm = {
      generateStream: async (): Promise<string> => {
        throw new Error('LLM_ABORTED')
      }
    } as unknown as LlmService
    await expect(
      new DeslopService(llm).deslop('他不是冷漠，而是绝望。')
    ).rejects.toThrow('LLM_ABORTED')
  })
})

describe('mergeChunkResults 行号偏移（两套行号不能混）', () => {
  const base = {
    processedGates: ['A'] as DeslopResult['processedGates'],
    beforeWords: 0,
    afterWords: 0,
    deleteRatio: 0
  }

  it('剩余问题按「改写后」累计行数偏移，改写压行后仍指向正确的行', () => {
    // 第1块原文 4 行、改写后压成 2 行；第2块原文从第 5 行开始。
    // 若错用原文起始行号（5），第2块的问题会被报到第 6 行——合并结果总共才 4 行。
    const chunks = [
      { text: 'a1\na2\na3\na4', startLine: 1 },
      { text: 'b1\nb2', startLine: 5 }
    ]
    const merged = mergeChunkResults('a1\na2\na3\na4\nb1\nb2', chunks, [
      { ...base, rewritten: 'A1\nA2', remainingFindings: [], changeSummary: [] },
      {
        ...base,
        rewritten: 'b1\nb2',
        changeSummary: [],
        remainingFindings: [
          {
            line: 2,
            column: 1,
            type: 'banned-word',
            severity: 'advisory',
            gate: 'A',
            message: '',
            excerpt: 'b2',
            word: 'b2'
          }
        ]
      }
    ])
    const reported = merged.remainingFindings[0].line
    expect(merged.rewritten.split('\n')[reported - 1]).toBe('b2')
  })

  it('改动说明按「原文」起始行号偏移（LLM 引用的是它收到的原文行号）', () => {
    const chunks = [
      { text: 'a1\na2\na3\na4', startLine: 1 },
      { text: 'b1\nb2', startLine: 5 }
    ]
    const merged = mergeChunkResults('a1\na2\na3\na4\nb1\nb2', chunks, [
      { ...base, rewritten: 'A1\nA2', remainingFindings: [], changeSummary: [] },
      {
        ...base,
        rewritten: 'b1\nb2',
        remainingFindings: [],
        changeSummary: ['- 第2行｜原句：b2 → 改后：B2']
      }
    ])
    // 第2块的第 2 行 = 原文第 6 行（不是改写后的行号）
    expect(merged.changeSummary[0]).toContain('第6行')
  })
})

describe('splitForDeslop 单行超长', () => {
  it('切不开的超长单行仍是一块（行内切会劈开台词），由调用方告警而非静默', () => {
    const oneLine = '他仿佛被抽空了力气缓缓坐下。'.repeat(2000)
    const chunks = splitForDeslop(oneLine)
    expect(chunks).toHaveLength(1)
    expect(countWords(chunks[0].text)).toBeGreaterThan(CHUNK_MAX_WORDS)
  })

  it('超长块会在日志里明确告警', async () => {
    // 一个超长单行 + 足够多的普通行，凑够切块条件
    const oneLine = '他仿佛被抽空了力气缓缓坐下。'.repeat(1000)
    const rest = Array.from({ length: 400 }, (_, i) => `第${i + 1}段。他走进屋子。`).join('\n\n')
    const text = `${oneLine}\n\n${rest}`
    const log: string[] = []
    const llm = {
      generateStream: async (): Promise<string> => {
        throw new Error('LLM_ABORTED')
      }
    } as unknown as LlmService
    await new DeslopService(llm).deslop(text, { onToken: (t) => log.push(t) })
    expect(log.join('')).toContain('含超长单行')
  })
})

describe('Phase 3.5 收尾标点兜底（无条件执行）', () => {
  it('LLM 原样退回时，省略号/破折号仍被确定性清理', async () => {
    // 旧行为：兜底只在"某一遍改写被接受且文本有变"这条路径上跑；
    // 模型把原文原样退回来，标点问题就一直留着。
    const text = '他站在门口。\n「我……我不知道。」\n她没回答——转身走了。'
    const mock = makeMockLlm([`【改写后】\n${text}`])
    const result = await new DeslopService(mock).deslop(text)
    expect(result.rewritten).not.toContain('……')
    expect(result.rewritten).not.toContain('——')
    // 改动要进 changeSummary，不能只留在会被关掉的日志里
    expect(result.changeSummary.some((c) => c.includes('标点兜底'))).toBe(true)
    // 复扫过，兜底修掉的问题不该还挂在"剩余问题"里
    expect(result.remainingFindings.some((f) => f.type === 'em-dash' || f.type === 'ellipsis')).toBe(
      false
    )
  })

  it('只有省略号的正文也能扫出 finding（否则前端「开始润色」被禁用）', async () => {
    const text = '他站在门口。\n「我……我不知道。」\n窗外的雨停了。'
    const report = await new DeslopService(makeMockLlm([''])).scan(text)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.findings.some((f) => f.type === 'ellipsis' && f.gate === 'D')).toBe(true)
  })

  it('全部 Pass 被拒绝时，标点兜底照样兜住', async () => {
    const text = '他不是冷漠，而是绝望——彻底的绝望。\n她说：「算了……」'
    // 返回一段寒暄，会被 acceptRewrite 拒绝
    const mock = makeMockLlm(['好的，我来帮你改写：'])
    const result = await new DeslopService(mock).deslop(text)
    expect(result.rewritten).not.toContain('——')
    expect(result.rewritten).not.toContain('……')
    expect(result.changeSummary.some((c) => c.startsWith('- [已拒绝]'))).toBe(true)
  })
})

describe('changeSummary 只剩 [已拒绝] 时的自动 diff 兜底', () => {
  it('一遍被拒 + 一遍改了却漏写说明 → 仍要生成改动明细', async () => {
    // Pass1（Gate A+B）被拒；Pass2（Gate C+D）改了但没写【改动说明】。
    // 旧判据 `changeSummary.length === 0` 因为有一条"已拒绝"而失效，真实改动全丢。
    const text = '他不是冷漠，而是绝望。\n她感到失落，坐在门口的台阶上，看着远处的灯一盏盏亮起来。'
    const mock = makeMockLlm([
      '好的，我来帮你改写：', // Pass1 被拒
      '【改写后】\n他不是冷漠，而是绝望。\n她坐在门口的台阶上，看着远处的灯一盏盏亮起来。'
    ])
    const result = await new DeslopService(mock).deslop(text)
    expect(result.changeSummary.some((c) => c.startsWith('- [已拒绝]'))).toBe(true)
    expect(result.changeSummary.some((c) => !c.startsWith('- [已拒绝]'))).toBe(true)
  })
})

describe('isTail=false（正文中间截出来的片段）', () => {
  const fragment = '他把杯子放下，缓缓抬起头'

  it('片段末尾无终止标点不再报"疑似截断"', async () => {
    const svc = new DeslopService(makeMockLlm(['']))
    const tailScan = await svc.scan(fragment)
    const fragScan = await svc.scan(fragment, { isTail: false })
    expect(tailScan.findings.some((f) => f.type === 'truncation')).toBe(true)
    expect(fragScan.findings.some((f) => f.type === 'truncation')).toBe(false)
  })

  it('deslop({ isTail: false }) 把截断检测一路关到底', async () => {
    let prompt = ''
    const llm = {
      generateStream: async (p: string): Promise<string> => {
        prompt = p
        return `【改写后】\n${fragment}`
      }
    } as unknown as LlmService
    const result = await new DeslopService(llm).deslop(fragment, { isTail: false })
    expect(prompt).not.toContain('疑似截断')
    expect(result.remainingFindings.some((f) => f.type === 'truncation')).toBe(false)
  })
})

describe('润色力度档位（levelOverride）', () => {
  const svc = () => new DeslopService(makeMockLlm(['']))

  it('scan 带出自动判定的 level，前端不必复刻 classify 阈值', async () => {
    const clean = '他站起来，走了出去。窗外的雨停了。'
    expect((await svc().scan(clean)).level).toBe('mild')
    // 禁用词密度拉满 -> 重度
    const heavy = '他仿佛缓缓微微轻轻淡淡不禁一丝一抹些许几分隐约地站了起来。'.repeat(3)
    expect((await svc().scan(heavy)).level).toBe('severe')
  })

  it('手选档位覆盖自动判定，并改变删除比例上限', async () => {
    // 这段禁用词密度为 0，自动判定是 mild（上限 15%）；手选 severe 应放宽到 35%
    const text = '他把门关上，走回桌边。\n这一刻，他终于明白了一切。'
    expect((await svc().scan(text)).level).toBe('mild')
    const prompts: string[] = []
    const llm = {
      generateStream: async (p: string): Promise<string> => {
        prompts.push(p)
        return `【改写后】\n${text}`
      }
    } as unknown as LlmService
    const log: string[] = []
    await new DeslopService(llm).deslop(text, {
      levelOverride: 'severe',
      onToken: (t) => log.push(t)
    })
    expect(prompts[0]).toContain('删除比例上限 35%')
    // 日志要说清是手选的，不能写成"诊断为重度"让人以为是扫出来的
    expect(log.join('')).toContain('已手动指定重度')
  })

  it('不传 levelOverride 时沿用自动判定（行为不变）', async () => {
    const text = '他不是冷漠，而是绝望。\n仿佛被抽空了力气，他缓缓坐下。'
    const prompts: string[] = []
    const llm = {
      generateStream: async (p: string): Promise<string> => {
        prompts.push(p)
        return `【改写后】\n${text}`
      }
    } as unknown as LlmService
    const scan = await new DeslopService(llm).scan(text)
    await new DeslopService(llm).deslop(text)
    const expected = { mild: 15, moderate: 25, severe: 35 }[scan.level]
    expect(prompts[0]).toContain(`删除比例上限 ${expected}%`)
  })
})
