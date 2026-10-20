import { describe, it, expect } from 'vitest'
import { parseOutlineDiffJson } from '../src/shared/parsers'
import { sanitizeOutlinePatch } from '../src/shared/outline-diff-apply'
import { needsDownstreamOutlineAdjustment, isVolumeLevelOutlineDiff } from '../src/main/data/write-service'

describe('真实十章测试：数字字数补丁', () => {
  it('第二轮真实第1章：已完成且未发现提前揭示，仍只是篇幅差异', () => {
    const diff = parseOutlineDiffJson(JSON.stringify([{type:5,priority:'P2',resolution:'review',
      outline:'本章字数要求为1200字；正文应不超过1560字。',
      actual:'正文篇幅超过1560字上限，构成字数偏离超过30%。核心事件及章末核对登记的决定均已完成，未发现核心事件替换或提前揭示内应身份。',
      suggestion:'压缩篇幅，或以正文更新字数要求。'}]),1).diffs[0]
    expect(needsDownstreamOutlineAdjustment(diff)).toBe(false)
    expect(needsDownstreamOutlineAdjustment({...diff,actual:diff.actual+'但改变人物身份。'})).toBe(true)
    expect(needsDownstreamOutlineAdjustment({...diff,actual:'核心事件已完成，但未发现必要伏笔，人物身份提前揭示。'})).toBe(true)
  })
  it('保留数字字数，不因“核心事件未改变”的措辞联动重写后章', () => {
    const report = parseOutlineDiffJson(JSON.stringify([{ type: 5, typeLabel: '结构性偏离', priority: 'P2', resolution: 'review',
      outline: '本章预计字数为1200字；按偏离超过30%的标准，正文长度上限为1560字。',
      actual: '正文约1900字，超过细纲预计字数的30%容差上限。核心事件及章末核对渡船登记的推进顺序未改变。',
      suggestion: '若保留现有对话展开，则以正文更新细纲的预计字数。', outlinePatch: { wordEstimate: 1900 } }]), 1)
    expect(report.diffs[0].outlinePatch).toEqual({ wordEstimate: '1900字' })
    expect(needsDownstreamOutlineAdjustment(report.diffs[0])).toBe(false)
    expect(isVolumeLevelOutlineDiff(report.diffs[0], 5)).toBe(false)
  })
  it('不把其他数值字段或无效计数当作可写正文计划', () => {
    expect(sanitizeOutlinePatch({ wordEstimate: -1, plotSummary: 1900 })).toBeUndefined()
    expect(sanitizeOutlinePatch({ wordEstimate: 1.5 })).toBeUndefined()
    expect(sanitizeOutlinePatch({ wordEstimate: 40001 })).toBeUndefined()
  })
  it('真实第7章：没有补丁但明确剧情任务已落实，不强制重写后三章', () => {
    const diff = parseOutlineDiffJson(JSON.stringify([{ type: 5, priority: 'P2', resolution: 'review',
      outline: '本章字数：1200字；按偏离不超过30%计算，上限为1560字。',
      actual: '正文篇幅为2000余字，明显超过1560字上限。核心事件及本章要求的伏笔任务均已落实，但篇幅构成结构性偏离。',
      suggestion: '压缩重复问答，保留陆宁读信确认身份、沈禾仍不知情。' }]), 7).diffs[0]
    expect(needsDownstreamOutlineAdjustment(diff)).toBe(false)
    expect(isVolumeLevelOutlineDiff(diff, 5)).toBe(false)
    expect(needsDownstreamOutlineAdjustment({ ...diff, actual: '核心事件未改变，但主线已经跑偏，提前救回母亲。' })).toBe(true)
    expect(needsDownstreamOutlineAdjustment({ ...diff, actual: '任务已落实，但新增人物并改变其身份，篇幅也超标。' })).toBe(true)
    expect(needsDownstreamOutlineAdjustment({ ...diff, actual: '任务已落实，但改变人物身份，篇幅也超标。' })).toBe(true)
    expect(needsDownstreamOutlineAdjustment({ ...diff, outlinePatch: { wordEstimate: '2000字' },
      actual: '篇幅2000字，但改变人物身份，主线提前进入决战。' })).toBe(true)
  })
})
