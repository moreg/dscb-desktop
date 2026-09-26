import { describe, expect, it } from 'vitest'
import {
  findOverwriteRisks,
  resolveBatchDefaultRange
} from '../src/renderer/src/ChapterListPage'

describe('批量续写默认区间：定位真正的未写起点', () => {
  it('没有未写章节时退回旧逻辑：最大章号之后接着写', () => {
    // 从没导入过细纲，或细纲已全部写完——这时唯一合理的起点就是接着往后写
    expect(resolveBatchDefaultRange([], 300, 10)).toEqual({ from: 301, to: 310 })
  })

  it('未写章节紧跟在最大章号后面时，结果与旧逻辑一致', () => {
    // 最常见情况：连续写作，没有缺口
    expect(resolveBatchDefaultRange([301, 302, 303], 300, 10)).toEqual({ from: 301, to: 310 })
  })

  it('中间有缺口时取第一个未写章节，不是 maxChapter+1', () => {
    // 回归：细纲整卷导入后连续写了 1-300，287 章当时失败/跳过没写，
    // 300 章之后又接着写到了 300——此时最大章号是 300，但 287 仍然是空的。
    // 旧逻辑 maxChapter+1=301 会直接跳过这个缺口，永远补不上。
    expect(resolveBatchDefaultRange([287, 301, 302], 300, 10)).toEqual({ from: 287, to: 296 })
  })

  it('结束章号 = 起点 + 章数 - 1，与「写几章」快捷按钮的算法一致', () => {
    expect(resolveBatchDefaultRange([50], 100, 1)).toEqual({ from: 50, to: 50 })
    expect(resolveBatchDefaultRange([50], 100, 20)).toEqual({ from: 50, to: 69 })
  })

  it('章数给 0 或负数时至少写 1 章，不会算出 to < from', () => {
    expect(resolveBatchDefaultRange([50], 100, 0)).toEqual({ from: 50, to: 50 })
  })

  it('缺口后有已写正文时缩短预设，避免一键入口默认覆盖正文', () => {
    expect(resolveBatchDefaultRange([287, 301], 300, 10, new Set([290, 288, 289])))
      .toEqual({ from: 287, to: 287 })
  })

  it('默认范围沿用全链路的单批 100 章上限', () => {
    expect(resolveBatchDefaultRange([50], 100, 1000)).toEqual({ from: 50, to: 149 })
  })
})

describe('批量续写覆盖风险：区间内混进已写章节', () => {
  it('没有已写章节混入时返回空数组', () => {
    expect(findOverwriteRisks(301, 310, new Set([1, 2, 3]))).toEqual([])
  })

  it('列出区间内已写的章号，用于提醒会被静默覆盖', () => {
    // 回归：批量续写落盘前不检查该章是否已有正文，选中区间若混进已写章节
    // 会被直接覆盖且没有任何提示
    expect(findOverwriteRisks(285, 290, new Set([287, 289]))).toEqual([287, 289])
  })

  it('最多只报 20 条，用来提醒即可，不需要穷举整个区间', () => {
    const drafted = new Set(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(findOverwriteRisks(1, 100, drafted)).toHaveLength(20)
  })

  it('巨大输入区间也检查已有正文，且不遍历每个数字卡住页面', () => {
    expect(findOverwriteRisks(1, Number.MAX_SAFE_INTEGER, new Set([900, 2, 5000])))
      .toEqual([2, 900, 5000])
  })
})
