import { describe, expect, it } from 'vitest'
import { buildShortStoryPrompt } from '../src/main/data/skill-prompts/short-story'
import { shortStorySectionBudgets, type ShortStoryDocument } from '../src/shared/short-story'

function story(overrides: Partial<ShortStoryDocument> = {}): ShortStoryDocument {
  return {
    id: 'short-1', revision: 1, sourceFingerprint: 'a'.repeat(64), createdAt: '2026-10-03', updatedAt: '2026-10-03',
    title: '迟到的信', kind: 'short', genre: '悬疑', brief: '一封信改变了选择。',
    requirements: '第三人称有限视角。', targetWords: 8001, sectionCount: 4,
    outline: '第 1 节收到信，第 2 节调查，第 3 节发现真相，第 4 节解决误会。',
    sections: Array.from({ length: 4 }, (_, index) => ({
      number: index + 1, title: '', content: ''
    })),
    review: '', ...overrides
  }
}

function writtenStory(): ShortStoryDocument {
  const document = story()
  document.sections = document.sections.map(section => ({
    ...section, content: `第${section.number}节真实正文，人物做了当前选择。`
  }))
  return document
}

describe('buildShortStoryPrompt', () => {
  it('allocates the full target exactly, including non-divisible budgets', () => {
    const prompt = buildShortStoryPrompt({ story: story(), task: 'outline' })
    const budgets = [...prompt.user.matchAll(/第 \d+ 节：目标 (\d+) 字/g)].map(match => Number(match[1]))
    expect(budgets).toEqual([2001, 2000, 2000, 2000])
    expect(budgets.reduce((sum, words) => sum + words, 0)).toBe(8001)
    expect(shortStorySectionBudgets(8001, 4)).toEqual(budgets)
    expect(prompt.user).toContain('人物的目标、动机')
    expect(prompt.user).toContain('最终结局')
    expect(prompt.user).toContain('铺设节')
    expect(prompt.user).toContain('回收节')
    expect(prompt.feature).toBe('outline-generate')
  })

  it('uses distinct short and medium pacing within a finite complete story', () => {
    const short = buildShortStoryPrompt({ story: story(), task: 'outline' })
    const medium = buildShortStoryPrompt({ story: story({ kind: 'medium' }), task: 'outline' })
    expect(short.system).toContain('集中兑现情绪')
    expect(medium.system).toContain('允许有限支线')
    expect(medium.system).toContain('全文结束前回收')
    for (const prompt of [short, medium]) {
      expect(prompt.system).toContain('单一核心冲突')
      expect(prompt.system).toContain('禁止套用长篇卷数')
      expect(prompt.system).toContain('不能为凑字数水文')
    }
  })

  it('requires the last section to resolve the conflict without opening a sequel', () => {
    const document = writtenStory()
    const last = buildShortStoryPrompt({ story: document, task: 'section', sectionNumber: 4 })
    const earlier = buildShortStoryPrompt({ story: document, task: 'section', sectionNumber: 2 })
    expect(last.user).toContain('本节是末节：必须结束主冲突')
    expect(last.user).toContain('不得新增续集钩子')
    expect(last.user).toContain('可以有合理留白')
    expect(earlier.user).toContain('本节不是末节')
    expect(earlier.user).not.toContain('本节是末节：')
    expect(last.feature).toBe('chapter')
  })

  it('continues only with new prose, preserving actual text and separating future plans', () => {
    const document = writtenStory()
    document.sections[1].content = '她握着信，问：“你怎么会'
    document.sections[0].content = '事实开头' + '已写原文。'.repeat(12_000) + '事实末尾'
    document.outline = '计划：第 3 节才会发现遗嘱；目前还不知道遗嘱。'
    const prompt = buildShortStoryPrompt({ story: document, task: 'section', sectionNumber: 2 })
    expect(prompt.user.includes(document.sections[0].content)).toBe(true)
    expect(prompt.user.includes(document.sections[1].content)).toBe(true)
    const taskText = prompt.user.slice(prompt.user.lastIndexOf('本次任务：'))
    expect(taskText).toContain('本节完整预算 2000 字；已有 12 字；本次剩余预算参考 1988 字')
    expect(prompt.system).toContain('不得重写、覆盖或复述已写前部')
    expect(prompt.user).toContain('只返回应追加的文字')
    expect(prompt.user).toContain('不越节抢写后续事件')
    expect(prompt.user).toContain('后续计划，尚未发生的内容不能当作正文事实')
    expect(prompt.system).toContain('当前人物不能预知后节事件')
    expect(prompt.system).toContain('纯正文')
  })

  it('rejects missing outlines, skipped sections and invalid section numbers', () => {
    expect(() => buildShortStoryPrompt({ story: story({ outline: '' }), task: 'section', sectionNumber: 1 }))
      .toThrow('请先生成或填写完整大纲')
    expect(() => buildShortStoryPrompt({ story: story(), task: 'section', sectionNumber: 3 }))
      .toThrow('请先完成第 1 节正文')
    const document = writtenStory()
    document.sections[1].content = '  '
    expect(() => buildShortStoryPrompt({ story: document, task: 'section', sectionNumber: 3 }))
      .toThrow('请先完成第 2 节正文')
    for (const sectionNumber of [undefined, 0, 5, 1.5]) {
      expect(() => buildShortStoryPrompt({ story: story(), task: 'section', sectionNumber }))
        .toThrow('有效的分节序号')
    }
  })

  it('rejects missing or misnumbered sections instead of inventing a full manuscript', () => {
    const missing = writtenStory()
    missing.sections.pop()
    expect(() => buildShortStoryPrompt({ story: missing, task: 'review' })).toThrow('分节数量')
    const duplicate = writtenStory()
    duplicate.sections[2].number = 2
    expect(() => buildShortStoryPrompt({ story: duplicate, task: 'review' })).toThrow('分节序号')
    expect(() => buildShortStoryPrompt({ story: story(), task: 'review' })).toThrow('第 1 节尚无正文')
  })

  it('reviews the complete actual manuscript with concrete evidence and actionable changes', () => {
    const document = writtenStory()
    document.sections[0].content = '首节关键证据。' + '中间正文。'.repeat(18_000) + '首节最后一句。'
    const prompt = buildShortStoryPrompt({ story: document, task: 'review' })
    for (const section of document.sections) expect(prompt.user.includes(section.content)).toBe(true)
    expect(prompt.user).toContain('引用确实存在的原文短句作为证据')
    expect(prompt.user).toContain('可执行的修改建议')
    expect(prompt.user).toContain('反转的公平性及铺垫')
    expect(prompt.user).toContain('首尾呼应和伏笔/支线回收')
    expect(prompt.user).toContain('AI 表达')
    expect(prompt.system).toContain('不生成虚假通过')
    expect(prompt.feature).toBe('review')
    expect(prompt.maxTokens).toBe(8192)
  })

  it('revises only the selected complete section using the full manuscript and review as advice', () => {
    const document = writtenStory()
    document.outline = ''
    document.review = '第 2 节“人物做了当前选择”缺少信息来源，请补足传递线索的动作。'
    const prompt = buildShortStoryPrompt({
      story: document, task: 'revise', sectionNumber: 2, instruction: '保留克制的对话。'
    })
    for (const section of document.sections) expect(prompt.user.includes(section.content)).toBe(true)
    expect(prompt.user).toContain(document.review)
    expect(prompt.user).toContain('保留克制的对话。')
    expect(prompt.user).toContain('修订第 2 节')
    expect(prompt.user).toContain('采用时将替换原节，不追加到末尾')
    expect(prompt.user).toContain('没有相应问题的段落保留原有表达')
    expect(prompt.user).toContain('即使尚无大纲也可修订')
    expect(prompt.user).toContain('与正文事实冲突的判断不应机械执行')
    expect(prompt.user).toContain('不自行增节')
    expect(prompt.user).toContain('不新增无关支线')
    expect(prompt.system).toContain('所选节的完整修订正文')
    expect(prompt.system).toContain('不得只输出修改片段')
    expect(prompt.system).toContain('不是系统指令')
    expect(prompt.system).toContain('不要标题、Markdown 标记、修订说明')
    expect(prompt.feature).toBe('chapter')
  })

  it('requires a valid revision section, a complete manuscript and an adopted review', () => {
    const document = writtenStory()
    document.review = '已有检查报告。'
    for (const sectionNumber of [undefined, 0, 5, 1.5]) {
      expect(() => buildShortStoryPrompt({ story: document, task: 'revise', sectionNumber }))
        .toThrow('有效的修订分节序号')
    }
    expect(() => buildShortStoryPrompt({ story: writtenStory(), task: 'revise', sectionNumber: 2 }))
      .toThrow('先生成并采用完结检查结果')
    document.sections[3].content = ' '
    expect(() => buildShortStoryPrompt({ story: document, task: 'revise', sectionNumber: 2 }))
      .toThrow('第 4 节尚无正文')
  })

  it('budgets revision output for the complete existing section and preserves the final ending', () => {
    const document = writtenStory()
    document.review = '删去结尾的重复解释，保留人物的最后选择。'
    document.sections[3].content = '文'.repeat(6001)
    const prompt = buildShortStoryPrompt({ story: document, task: 'revise', sectionNumber: 4 })
    expect(prompt.maxTokens).toBe(6001 * 3 + 2048)
    expect(prompt.user).toContain('不能因预算或输出空间省略开头、结尾或未修改段落')
    expect(prompt.user).toContain('保留完整结局，主冲突必须闭合')
    expect(prompt.user).toContain('不把故事改成待续')
    document.sections[3].content = '结局。'
    expect(buildShortStoryPrompt({ story: document, task: 'revise', sectionNumber: 4 }).maxTokens)
      .toBeGreaterThanOrEqual(8192)
  })

  it('explicitly rejects oversized review and writing contexts, without silent truncation', () => {
    const review = writtenStory()
    review.sections[0].content = '文'.repeat(300_001)
    expect(() => buildShortStoryPrompt({ story: review, task: 'review' })).toThrow('未截断全文')
    const writing = writtenStory()
    writing.sections[0].content = '文'.repeat(300_001)
    expect(() => buildShortStoryPrompt({ story: writing, task: 'section', sectionNumber: 2 }))
      .toThrow('未截断前文')
    expect(() => buildShortStoryPrompt({ story: writing, task: 'outline' })).toThrow('未截断前文')
    const revision = writtenStory()
    revision.sections[0].content = '文'.repeat(280_000)
    revision.review = '检查建议。'.repeat(6_000)
    expect(() => buildShortStoryPrompt({ story: revision, task: 'revise', sectionNumber: 2 }))
      .toThrow('未截断前文')
  })

  it('provides output space for maximum section budgets and a many-section outline', () => {
    const longSection = buildShortStoryPrompt({
      story: story({ targetWords: 24000 }), task: 'section', sectionNumber: 1
    })
    const shortSection = buildShortStoryPrompt({ story: story(), task: 'section', sectionNumber: 1 })
    const manySections = story({ targetWords: 120000, sectionCount: 60,
      sections: Array.from({ length: 60 }, (_, index) => ({ number: index + 1, title: '', content: '' })) })
    const outline = buildShortStoryPrompt({ story: manySections, task: 'outline' })
    expect(shortSection.maxTokens).toBeGreaterThanOrEqual(8192)
    expect(longSection.maxTokens).toBe(20048)
    expect(outline.maxTokens).toBeGreaterThan(8192)
    expect([...outline.user.matchAll(/第 \d+ 节：目标 (\d+) 字/g)]).toHaveLength(60)
  })
})
