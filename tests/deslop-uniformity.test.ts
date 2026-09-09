import { describe, it, expect } from 'vitest'
import {
  computeUniformity,
  countUniformSignals,
  describeUniformity,
  coefficientOfVariation,
  UNIFORMITY_THRESHOLDS,
  MIN_SENTENCES,
  MIN_PARAGRAPHS,
  MIN_DIALOGUES
} from '../src/main/data/deslop/check-uniformity'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { LlmService } from '../src/main/data/llm-service'

const noopLlm = {} as unknown as LlmService

/** 每段两句、每句都是同一长度 —— 极端均匀，模拟 AI 稿的窄峰分布 */
function uniformText(paragraphs = 14): string {
  const s = '他把账本翻到最后一页又合上放回原处'
  return Array.from({ length: paragraphs }, () => `${s}。${s}。`).join('\n')
}

/** 长短句拉开、段落长短不一 —— 模拟人写的长尾分布 */
function variedText(): string {
  const long =
    '他把账本翻到最后一页，又翻回来，从头一栏一栏地对，对到第三栏的时候停下来，用指甲在纸上刻了一道，那道印子后来一直没消'
  const mid = '窗外有人在喊，喊的什么听不清'
  const short = '不。'
  const lines: string[] = []
  for (let i = 0; i < 14; i++) {
    if (i % 3 === 0) lines.push(long)
    else if (i % 3 === 1) lines.push(`${mid}。${short}${long}。`)
    else lines.push(short)
  }
  return lines.join('\n')
}

/** 台词长度全部接近 */
function uniformDialogue(): string {
  return Array.from({ length: 12 }, (_, i) => `“这件事我早就跟你说过了${i % 10}。”`).join('\n')
}

/** 台词长度长短悬殊 */
function variedDialogue(): string {
  const lines: string[] = []
  for (let i = 0; i < 12; i++) {
    lines.push(
      i % 2 === 0
        ? '“嗯。”'
        : `“这件事我早就跟你说过，你当时不听，现在再来问我也没有用，账是你自己记的${i}。”`
    )
  }
  return lines.join('\n')
}

describe('check-uniformity: 变异系数', () => {
  it('全等样本 CV = 0', () => {
    expect(coefficientOfVariation([10, 10, 10, 10])).toBe(0)
  })

  it('离散样本 CV > 0，且离散越大 CV 越大', () => {
    const near = coefficientOfVariation([9, 10, 11])
    const far = coefficientOfVariation([1, 10, 30])
    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
  })

  it('空样本与全零样本返回 0，不产生 NaN', () => {
    expect(coefficientOfVariation([])).toBe(0)
    expect(coefficientOfVariation([0, 0, 0])).toBe(0)
  })
})

describe('check-uniformity: 样本量下限', () => {
  it('句子/段落/对白不足下限时返回 null，而不是 0', () => {
    const m = computeUniformity('他走了。\n她没说话。')
    expect(m.sentenceLengthCv).toBeNull()
    expect(m.paragraphLengthCv).toBeNull()
    expect(m.dialogueLengthCv).toBeNull()
  })

  it('null 不计入均匀信号（短文不会被误判成"极均匀"）', () => {
    const m = computeUniformity('他走了。\n她没说话。')
    expect(countUniformSignals(m)).toBe(0)
    expect(describeUniformity(m)).toBeNull()
  })

  it('下限常量与实现一致：刚好达到下限时开始出数', () => {
    const m = computeUniformity(uniformText(MIN_PARAGRAPHS))
    expect(m.paragraphLengthCv).not.toBeNull()
    expect(MIN_SENTENCES).toBeGreaterThan(0)
    expect(MIN_DIALOGUES).toBeGreaterThan(0)
  })
})

describe('check-uniformity: 均匀 vs 长尾', () => {
  it('句长全等的文本 CV ≈ 0，判为过于均匀', () => {
    const m = computeUniformity(uniformText())
    expect(m.sentenceLengthCv).not.toBeNull()
    expect(m.sentenceLengthCv!).toBeLessThan(UNIFORMITY_THRESHOLDS.sentenceLengthCv)
    expect(m.paragraphLengthCv!).toBeLessThan(UNIFORMITY_THRESHOLDS.paragraphLengthCv)
    expect(countUniformSignals(m)).toBeGreaterThanOrEqual(2)
  })

  it('长短句拉开的文本不判均匀', () => {
    const m = computeUniformity(variedText())
    expect(m.sentenceLengthCv!).toBeGreaterThan(UNIFORMITY_THRESHOLDS.sentenceLengthCv)
    expect(countUniformSignals(m)).toBe(0)
  })

  it('对白长度接近时命中，长短悬殊时不命中', () => {
    const uniform = computeUniformity(uniformDialogue())
    const varied = computeUniformity(variedDialogue())
    expect(uniform.dialogueLengthCv!).toBeLessThan(UNIFORMITY_THRESHOLDS.dialogueLengthCv)
    expect(varied.dialogueLengthCv!).toBeGreaterThan(UNIFORMITY_THRESHOLDS.dialogueLengthCv)
  })

  it('直角引号「」与双引号“”都能取到台词', () => {
    const zh = computeUniformity(uniformDialogue())
    const jp = computeUniformity(uniformDialogue().replace(/“/g, '「').replace(/”/g, '」'))
    expect(jp.dialogueLengthCv).toBeCloseTo(zh.dialogueLengthCv!, 5)
  })

  it('describeUniformity 只描述真正命中的项', () => {
    const note = describeUniformity(computeUniformity(uniformText()))
    expect(note).toContain('句长过于均匀')
    expect(describeUniformity(computeUniformity(variedText()))).toBeNull()
  })
})

describe('DeslopService.classify: 结构均匀度不参与分级', () => {
  const svc = new DeslopService(noopLlm)
  const noHits = { blocking: 0, advisory: 0 }
  const lexicalMild = { bannedWordDensity: 0, parallelismCount: 0 }

  // 曾经「2 项以上过于均匀」会把 mild 升成 moderate，语料实测后撤掉：
  // 三个 CV 在真人稿 vs 未润色 AI 稿上 AUC 分别是 0.468 / 0.285(反向) / 0.486，没有判别力。
  // 这条测试锁住「不再升档」，防止有人凭直觉把它加回来。见 FINDINGS.md。
  it('三项全部极均匀也不升档（判据已按语料实测撤除）', () => {
    const level = svc.classify(
      { ...lexicalMild, sentenceLengthCv: 0.05, paragraphLengthCv: 0.05, dialogueLengthCv: 0.05 },
      noHits
    )
    expect(level).toBe('mild')
  })

  it('CV 极高同样不影响判档（只上调不下调的旧逻辑也一并移除）', () => {
    const level = svc.classify(
      { ...lexicalMild, sentenceLengthCv: 2, paragraphLengthCv: 2, dialogueLengthCv: 2 },
      noHits
    )
    expect(level).toBe('mild')
  })

  it('样本不足（全 null）时行为与加指标前完全一致', () => {
    const m = { ...lexicalMild, sentenceLengthCv: null, paragraphLengthCv: null, dialogueLengthCv: null }
    expect(svc.classify(m, noHits)).toBe('mild')
    expect(svc.classify({ ...m, bannedWordDensity: 8 }, noHits)).toBe('moderate')
    expect(svc.classify({ ...m, bannedWordDensity: 20 }, noHits)).toBe('severe')
  })

  it('均匀度只上调不下调：词表判重度的稿子不因句长有起伏被放行', () => {
    const level = svc.classify(
      { bannedWordDensity: 20, parallelismCount: 0, sentenceLengthCv: 1.5, paragraphLengthCv: 1.5, dialogueLengthCv: 1.5 },
      noHits
    )
    expect(level).toBe('severe')
  })

  it('均匀度不会把中度推到重度（删除比例上限不被纯分布指标放大）', () => {
    const level = svc.classify(
      { bannedWordDensity: 8, parallelismCount: 0, sentenceLengthCv: 0.05, paragraphLengthCv: 0.05, dialogueLengthCv: 0.05 },
      noHits
    )
    expect(level).toBe('moderate')
  })
})

describe('DeslopService.scan: 指标仍然计算并带出（只是不参与判档）', () => {
  it('三项 CV 照常算出来供面板展示', async () => {
    const report = await new DeslopService(noopLlm).scan(uniformText())
    expect(report.metrics.sentenceLengthCv).not.toBeNull()
    expect(report.metrics.paragraphLengthCv).not.toBeNull()
  })
})

describe('DeslopService.scan: 指标进入扫描报告', () => {
  it('CV 照常算出并带出报告', async () => {
    const report = await new DeslopService(noopLlm).scan(uniformText())
    expect(report.metrics.bannedWordDensity).toBe(0)
    expect(report.metrics.sentenceLengthCv).not.toBeNull()
  })

  // 直接锁住「CV 不影响判档」这条性质：同一份 metrics，把三项 CV 抹成 null 再判一次，
  // 档位必须完全一致。比断言具体档位稳——那份 fixture 的档位还受重复检测等其它 Gate 影响。
  it('把三项 CV 抹掉后判档结果不变', async () => {
    const svc = new DeslopService(noopLlm)
    const report = await svc.scan(uniformText())
    const withoutCv = svc.classify(
      { ...report.metrics, sentenceLengthCv: null, paragraphLengthCv: null, dialogueLengthCv: null },
      report.counts
    )
    expect(withoutCv).toBe(report.level)
  })
})
