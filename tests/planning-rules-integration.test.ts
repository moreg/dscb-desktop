import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { buildRhythmHtml } from '../src/main/data/rhythm-html-builder'
import { buildChapterOutlinePrompt } from '../src/main/data/skill-prompts/opening/chapter-outline'

describe('规划规则衔接', () => {
  it('图谱接受非固定节奏，仍检查预测和实际条目的结构错误', () => {
    const html = buildRhythmHtml([], '测试书', '2026-10-16', 4)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
    const start = script.indexOf('function checkRhythm(data)')
    const end = script.indexOf('// ========== ECharts 图表', start)
    const check = runInNewContext(`${script.slice(start, end)}; checkRhythm`, { logger: { info() {} } })
    const entry = (chapter: number, emotion: number, climax: number, actualized = false) =>
      ({ chapter, title: '已定章名', emotion, climax, volume: 1, actualized })
    expect(check([entry(1, 7, 4, true), entry(2, 4, 0), entry(3, 4, 0), entry(60, 7, 3.5)])).toHaveLength(0)
    expect(check([entry(1, 7, 1), entry(1, 7, 1)])).toHaveLength(1)
    expect(check([{ ...entry(2, 11, 9), actualized: 'false' }])).toHaveLength(3)
  })

  it('七猫细纲不套番茄长度，保留解析节奏、预算与多线结构', () => {
    const prompt = buildChapterOutlinePrompt('医师不能举刀', '药商封路', 4, 1, 2000, false,
      { platform: 'qimao', text: '目标平台：七猫\n章名策略：具体清楚' })
    expect(prompt).toContain('目标平台：七猫')
    expect(prompt).not.toContain('常规 4—8 字')
    expect(prompt).toContain('- **节奏标注**：')
    expect(prompt).toContain('## 字数预算契约')
    expect(prompt).toContain('## 章首/章尾钩子类型标注')
    expect(prompt).toContain('**事件线/任务线**')
    expect(prompt).not.toContain('大高潮之后必须有 1-2 章')
    expect(prompt).not.toContain('大纲/细纲_第XX卷.md')
  })
})
