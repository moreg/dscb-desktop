import { describe, it, expect } from 'vitest'
import { renderAdjustUserPrompt, parseAdjustPlanCompliance } from '../src/main/data/write-service'
import type { AdjustRenderInput } from '../src/main/data/write-service'

function baseInput(over: Partial<AdjustRenderInput> = {}): AdjustRenderInput {
  return {
    projectName: '测试书',
    genre: '玄幻',
    chapterNumber: 3,
    instruction: '把铺垫压短；加强女主反击；结尾改成对话钩子。',
    content: '这是当前正文的测试内容。',
    prevTail: '',
    characters: [],
    foreshadowings: [],
    ...over
  }
}

describe('renderAdjustUserPrompt 优先级语义', () => {
  it('无 confirmedPlan 时：用户追问要求为最高优先级', () => {
    const prompt = renderAdjustUserPrompt(baseInput())
    expect(prompt).toContain('用户追问要求是最高优先级')
    expect(prompt).toContain('## 用户追问要求（最高优先级，必须逐条落实到上方正文）')
    expect(prompt).not.toContain('落笔要点是最高优先级')
  })

  it('有 confirmedPlan 时：落笔要点为最高优先级，用户追问要求降级为背景参考', () => {
    const prompt = renderAdjustUserPrompt(
      baseInput({ confirmedPlan: '## 用户勾选的落笔要点\n1. 加强女主反击\n2. 结尾改成对话钩子' })
    )
    expect(prompt).toContain('「用户已确认的修改方案」中的落笔要点是最高优先级')
    expect(prompt).toContain('## 用户追问要求（背景参考；与已确认落笔要点冲突时以落笔要点为准')
    expect(prompt).not.toContain('用户追问要求是最高优先级')
    // 只落实方案点名的内容，不擅自扩大改动范围
    expect(prompt).toContain('只落实上列落笔要点')
    expect(prompt).toContain('方案未点名的内容一律保持原貌')
    expect(prompt).toContain('请基于上述「用户已确认的修改方案」')
  })

  it('有 confirmedPlan 时：confirmedPlan 内容原样进入 prompt', () => {
    const confirmedPlan =
      '## 用户勾选的落笔要点（仅执行以下条目；未勾选条目一律不要改）\n1. 加强女主反击\n\n' +
      '**硬性约束**：只落实上方编号条目。完整建议里出现但未勾选的内容，禁止改动对应正文。'
    const prompt = renderAdjustUserPrompt(baseInput({ confirmedPlan }))
    expect(prompt).toContain('仅执行以下条目；未勾选条目一律不要改')
    expect(prompt).toContain('完整建议里出现但未勾选的内容，禁止改动对应正文')
  })
})

describe('parseAdjustPlanCompliance 落笔要点达成度解析', () => {
  const items = ['加强女主反击', '删掉旁白解释', '结尾改成对话钩子']

  it('按 index 对位，ok 落位正确', () => {
    const raw = JSON.stringify({
      results: [
        { index: 0, ok: true, detail: '第 4 段加入反击动作' },
        { index: 1, ok: false, detail: '旁白仍在' },
        { index: 2, ok: true }
      ]
    })
    const r = parseAdjustPlanCompliance(raw, items)
    expect(r.failCount).toBe(1)
    expect(r.results).toEqual([
      { text: items[0], ok: true, detail: '第 4 段加入反击动作' },
      { text: items[1], ok: false, detail: '旁白仍在' },
      { text: items[2], ok: true, detail: undefined }
    ])
  })

  it('缺项按未落实处理，不出现空洞', () => {
    const raw = '{"results":[{"index":0,"ok":true}]}'
    const r = parseAdjustPlanCompliance(raw, items)
    expect(r.failCount).toBe(2)
    expect(r.results[0].ok).toBe(true)
    expect(r.results[1].ok).toBe(false)
    expect(r.results[2].ok).toBe(false)
  })

  it('解析失败整份判未落实', () => {
    const r = parseAdjustPlanCompliance('不是 JSON 的内容', items)
    expect(r.failCount).toBe(3)
    expect(r.results.every((x) => !x.ok)).toBe(true)
  })

  it('空要点列表直接返回空结果', () => {
    expect(parseAdjustPlanCompliance('{}', [])).toEqual({ results: [], failCount: 0 })
  })
})
