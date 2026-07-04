import { describe, it, expect } from 'vitest'
import { recallBenchmark, mergeRecalls } from '../src/main/data/teardown/benchmark-recall'
import type { BenchmarkArtifacts } from '../src/main/data/teardown/benchmark-resolver'

const sampleEmotionMd = `# 情绪模块：盘龙

## 读者需求 / 情绪引擎
| 读者需求 | 本书满足方式 | 证据章节 |
|---|---|---|
| 优越感 | 实力碾压 | 第5章 |

## 可复现模块卡

### EM-001 打脸循环
| 字段 | 内容 |
|---|---|
| 读者想看什么 | 被轻视者用结果反证 |
| 情绪链 | 被轻视 → 加压 → 三招击败 → 围观震惊 |
| 戏剧单元 | 公开场合被嘲讽后用实力打脸 |
| 复现步骤 | 1.建缺口 2.加反应层 3.控制爆发点 4.立新钩子 |

## 重组与复现指南
1. 先选读者需求，再选模块卡。
2. 保留情绪链，替换素材。`

const sampleRhythmMd = `# 节奏索引：盘龙

## 爽点循环索引
| 循环ID | 章节范围 | 铺垫层 | 释放层 |
| RH-001 | 第1-5章 | 被嘲讽 | 三招击败 |

## 爆发节奏总结
- 爆发密度：每 3000 字一个情绪节点
- 爆发形态：递进
- 长间隔风险：第 10-15 章触动点过稀
- 下游写作提醒：每章安排一个小触动点`

const sampleStyleMd = `# 盘龙 文风

## 整体语感
- 句长分布：短句 40%，中句 35%，长句 25%
- confidence: high
- 标点习惯：句号断句为主，少破折号

## 对话技法
- 潜台词模式：问非所答
- confidence: med

## 原文锚点片段
### 片段 A — 基调：紧张
林雷握紧了拳头，目光如电。
（300字原文示例）`

const sampleReportMd = `# 拆文报告：盘龙

## 可借鉴套路
1. 打脸循环（EM-001）
2. 反应层递进

## 写法技巧
1. 跨章回扣
2. 延迟揭示`

const fullArtifacts: BenchmarkArtifacts = {
  bookName: '盘龙',
  resolvedDir: '/tmp/teardown-library/盘龙',
  emotionModuleMd: sampleEmotionMd,
  rhythmMd: sampleRhythmMd,
  styleMd: sampleStyleMd,
  reportMd: sampleReportMd
}

describe('recallBenchmark 单本召回', () => {
  const recall = recallBenchmark(fullArtifacts)

  it('情绪召回含读者需求 + 模块卡 + 重组指南', () => {
    expect(recall.emotionRecall).toContain('读者需求')
    expect(recall.emotionRecall).toContain('EM-001')
    expect(recall.emotionRecall).toContain('重组')
  })

  it('节奏召回含爆发节奏总结 + 爽点循环', () => {
    expect(recall.rhythmRecall).toContain('爆发节奏')
    expect(recall.rhythmRecall).toContain('爽点循环')
  })

  it('文风召回含整体语感 + 对话技法', () => {
    expect(recall.styleRecall).toContain('整体语感')
    expect(recall.styleRecall).toContain('对话技法')
  })

  it('写法召回含可借鉴套路 + 写法技巧', () => {
    expect(recall.techniqueRecall).toContain('可借鉴套路')
    expect(recall.techniqueRecall).toContain('写法技巧')
  })

  it('召回长度受控（不爆 token）', () => {
    expect(recall.emotionRecall.length).toBeLessThan(2000)
    expect(recall.rhythmRecall.length).toBeLessThan(1200)
    expect(recall.styleRecall.length).toBeLessThan(1500)
    expect(recall.techniqueRecall.length).toBeLessThan(800)
  })
})

describe('recallBenchmark 缺失产物降级', () => {
  it('缺情绪模块时 emotionRecall 为空', () => {
    const recall = recallBenchmark({ ...fullArtifacts, emotionModuleMd: undefined })
    expect(recall.emotionRecall).toBe('')
    // 其他类不受影响
    expect(recall.rhythmRecall).toBeTruthy()
  })

  it('全缺时全空', () => {
    const recall = recallBenchmark({
      bookName: '空',
      resolvedDir: '/tmp'
    })
    expect(recall.emotionRecall).toBe('')
    expect(recall.rhythmRecall).toBe('')
    expect(recall.styleRecall).toBe('')
    expect(recall.techniqueRecall).toBe('')
  })
})

describe('mergeRecalls 多本合并', () => {
  it('空数组返回全空', () => {
    const merged = mergeRecalls([])
    expect(merged.emotion).toBe('')
    expect(merged.bookNames).toEqual([])
  })

  it('单本合并含书名标注', () => {
    const merged = mergeRecalls([recallBenchmark(fullArtifacts)])
    expect(merged.emotion).toContain('《盘龙》')
    expect(merged.rhythm).toContain('《盘龙》')
    expect(merged.bookNames).toEqual(['盘龙'])
  })

  it('多本用 --- 分隔', () => {
    const a = recallBenchmark(fullArtifacts)
    const b = recallBenchmark({ ...fullArtifacts, bookName: '诛仙' })
    const merged = mergeRecalls([a, b])
    expect(merged.emotion).toContain('《盘龙》')
    expect(merged.emotion).toContain('《诛仙》')
    expect(merged.emotion).toContain('---')
    expect(merged.bookNames).toEqual(['盘龙', '诛仙'])
  })

  it('某本某类为空不影响其他本', () => {
    const a = recallBenchmark(fullArtifacts)
    const b = recallBenchmark({ ...fullArtifacts, bookName: '无节奏', rhythmMd: undefined })
    const merged = mergeRecalls([a, b])
    // rhythm 只剩盘龙
    expect(merged.rhythm).toContain('《盘龙》')
    expect(merged.rhythm).not.toContain('《无节奏》')
  })
})

describe('recallBenchmark 提取边界', () => {
  it('无对应标题时该类为空（不报错）', () => {
    const recall = recallBenchmark({
      bookName: 'x',
      resolvedDir: '/tmp',
      emotionModuleMd: '# 无关标题\n\n没有情绪模块内容'
    })
    expect(recall.emotionRecall).toBe('')
  })

  it('标题含关键词即匹配（部分匹配）', () => {
    const recall = recallBenchmark({
      bookName: 'x',
      resolvedDir: '/tmp',
      rhythmMd: '## 爽点循环索引（详细）\n内容'
    })
    expect(recall.rhythmRecall).toContain('爽点循环')
  })
})
