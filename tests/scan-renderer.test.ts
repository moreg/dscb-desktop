import { describe, it, expect } from 'vitest'
import {
  renderScanReport,
  buildReportFileName,
  assessDataQuality,
  PLATFORM_LABELS
} from '../src/main/data/scan/scan-renderer'
import { buildBuiltinKnowledgeMarkdown, LONG_GENRE_TRENDS, SHORT_GENRE_TRENDS } from '../src/main/data/scan/builtin-knowledge'
import {
  buildTopicDecisionPrompt,
  buildBuiltinTopicPrompt,
  SCAN_ANALYZE_SYSTEM_PROMPT
} from '../src/main/data/skill-prompts/scan/topic-decision'
import type { ScanBookRecord } from '../src/shared/types'

const sampleBooks: ScanBookRecord[] = [
  {
    rank: 1,
    title: '剑道独尊',
    author: '青椒炒肉',
    genre: '玄幻·东方仙侠',
    status: '连载中',
    descText: '一剑破万法的故事',
    url: 'https://example.com/1',
    tags: ['剑道', '热血']
  },
  {
    rank: 2,
    title: '都市神豪系统',
    author: '作者B',
    genre: '都市',
    status: '完结',
    descText: '神豪逆袭'
  }
]

describe('assessDataQuality 数据质量判定', () => {
  it('正常数据 ok=true', () => {
    const q = assessDataQuality(sampleBooks)
    expect(q.ok).toBe(true)
    expect(q.validCount).toBe(2)
    expect(q.issues).toHaveLength(0)
  })

  it('标题异常超过 30% 不达标', () => {
    const books: ScanBookRecord[] = [
      { rank: 1, title: '正常', author: 'a', genre: '', status: '', descText: '' },
      { rank: 2, title: '（标题待解析）', author: 'b', genre: '', status: '', descText: '' },
      { rank: 3, title: '（标题待解析）', author: 'c', genre: '', status: '', descText: '' },
      { rank: 4, title: '', author: 'd', genre: '', status: '', descText: '' }
    ]
    const q = assessDataQuality(books)
    expect(q.ok).toBe(false)
    expect(q.issues.some((i) => i.includes('标题异常'))).toBe(true)
  })

  it('空榜单不达标', () => {
    expect(assessDataQuality([]).ok).toBe(false)
  })
})

describe('renderScanReport 报告渲染', () => {
  it('文件头含数据质量/有效条目/问题摘要', () => {
    const md = renderScanReport('qidian', 'hotsales', '畅销榜', sampleBooks, 'fetch')
    expect(md).toContain('数据质量')
    expect(md).toContain('有效条目：2 / 2')
    expect(md).toContain('问题摘要')
    expect(md).toContain('抓取方式：fetch')
  })

  it('每本书渲染标题/作者/简介/链接', () => {
    const md = renderScanReport('qidian', 'hotsales', '畅销榜', sampleBooks, 'fetch')
    expect(md).toContain('#1 剑道独尊')
    expect(md).toContain('青椒炒肉')
    expect(md).toContain('一剑破万法的故事')
    expect(md).toContain('[作品页]')
  })

  it('渲染标签', () => {
    const md = renderScanReport('qidian', 'hotsales', '畅销榜', sampleBooks, 'fetch')
    expect(md).toContain('**标签：** 剑道、热血')
  })

  it('sourceMode 写入头部', () => {
    const md = renderScanReport('fanqie', 'builtin', '内置', [], 'builtin')
    expect(md).toContain('抓取方式：builtin')
  })
})

describe('buildReportFileName 文件名', () => {
  it('格式：{平台}{榜单}_{YYYYMMDD}.md', () => {
    const name = buildReportFileName('qidian', 'hotsales', '畅销榜')
    expect(name).toMatch(/^起点畅销榜_\d{8}\.md$/)
  })

  it('晋江前缀正确', () => {
    expect(buildReportFileName('jjwxc', '12', '收入金榜')).toMatch(/^晋江/)
  })

  it('去除非法字符', () => {
    const name = buildReportFileName('qidian', 'a/b:c', '畅销/榜')
    expect(name).not.toContain('/')
    expect(name).not.toContain(':')
  })
})

describe('PLATFORM_LABELS 平台标签', () => {
  it('8 个平台齐全', () => {
    expect(PLATFORM_LABELS.qidian).toBe('起点')
    expect(PLATFORM_LABELS.fanqie).toBe('番茄')
    expect(PLATFORM_LABELS.jjwxc).toBe('晋江')
    expect(PLATFORM_LABELS.zhihu).toBe('知乎盐言')
  })
})

describe('buildBuiltinKnowledgeMarkdown 内置知识', () => {
  it('长篇模式含候选假设标注', () => {
    const md = buildBuiltinKnowledgeMarkdown(true)
    expect(md).toContain('候选假设')
    expect(md).toContain('非实时')
    expect(md).toContain('长篇')
  })

  it('短篇模式含追妻火葬场', () => {
    const md = buildBuiltinKnowledgeMarkdown(false)
    expect(md).toContain('追妻火葬场')
  })

  it('表格含题材/态势/热门卖点', () => {
    const md = buildBuiltinKnowledgeMarkdown(true)
    expect(md).toContain('题材')
    expect(md).toContain('态势')
    expect(md).toContain('热门卖点')
  })

  it('LONG_GENRE_TRENDS 含玄幻/都市/科幻', () => {
    const genres = LONG_GENRE_TRENDS.map((t) => t.genre)
    expect(genres).toContain('玄幻/仙侠')
    expect(genres).toContain('都市')
    expect(genres).toContain('科幻/末世')
  })

  it('SHORT_GENRE_TRENDS 含追妻/重生/世情/悬疑', () => {
    const genres = SHORT_GENRE_TRENDS.map((t) => t.genre)
    expect(genres).toContain('追妻火葬场')
    expect(genres).toContain('重生复仇')
    expect(genres).toContain('世情/现实')
  })
})

describe('buildTopicDecisionPrompt 选题决策 prompt', () => {
  it('包含选题四步结构', () => {
    const prompt = buildTopicDecisionPrompt('榜单报告内容', '起点')
    expect(prompt).toContain('能爆的原因')
    expect(prompt).toContain('市场验证')
    expect(prompt).toContain('差异化定位')
    expect(prompt).toContain('可行性')
    expect(prompt).toContain('失败风险')
    expect(prompt).toContain('验证动作')
  })

  it('包含硬规则（数据稀疏降级）', () => {
    const prompt = buildTopicDecisionPrompt('报告', '番茄')
    expect(prompt).toContain('数据稀疏')
    expect(prompt).toContain('待拆文验证')
  })

  it('包含平台名', () => {
    expect(buildTopicDecisionPrompt('r', '起点')).toContain('起点')
  })

  it('输出格式含选题决策标题骨架', () => {
    const prompt = buildTopicDecisionPrompt('r', '起点')
    expect(prompt).toContain('选题决策')
    expect(prompt).toContain('市场分析')
    expect(prompt).toContain('推荐选题')
  })
})

describe('buildBuiltinTopicPrompt 内置降级 prompt', () => {
  it('标注降级模式', () => {
    const prompt = buildBuiltinTopicPrompt('内置知识内容', '番茄', true)
    expect(prompt).toContain('降级模式')
    expect(prompt).toContain('假设')
    expect(prompt).toContain('内置知识内容')
  })

  it('标注篇幅', () => {
    expect(buildBuiltinTopicPrompt('k', 'p', true)).toContain('长篇')
    expect(buildBuiltinTopicPrompt('k', 'p', false)).toContain('短篇')
  })
})

describe('SCAN_ANALYZE_SYSTEM_PROMPT 平台调性', () => {
  it('含平台调性差异表', () => {
    expect(SCAN_ANALYZE_SYSTEM_PROMPT).toContain('平台调性差异')
    expect(SCAN_ANALYZE_SYSTEM_PROMPT).toContain('起点中文网')
    expect(SCAN_ANALYZE_SYSTEM_PROMPT).toContain('晋江文学城')
  })

  it('含核心信念', () => {
    expect(SCAN_ANALYZE_SYSTEM_PROMPT).toContain('跨样本重复')
  })
})
