import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkOpeningConsistency } from '../src/main/data/opening-postcheck'

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(dir, relPath)
  await fs.mkdir(join(fullPath, '..'), { recursive: true })
  await fs.writeFile(fullPath, content, 'utf-8')
}

describe('checkOpeningConsistency 逻辑自洽 6 项检查', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-postcheck-'))
  })

  describe('检查 1：章号格式', () => {
    it('检测到中文数字章号 → blocking 违规', async () => {
      await writeFile(dir, '细纲/细纲_第001章_测试.md', '## 第一章：测试\n- **核心事件**：测试\n')
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 1)
      expect(v).toBeDefined()
      expect(v!.severity).toBe('blocking')
      expect(v!.detail).toContain('第一章')
    })

    it('阿拉伯数字章号 → 通过', async () => {
      await writeFile(dir, '细纲/细纲_第001章_测试.md', '## 第 1 章：测试\n- **核心事件**：测试\n')
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 1)
      expect(v).toBeUndefined()
    })
  })

  describe('检查 3：伏笔编号合法', () => {
    it('FB 编号格式错误 → 违规', async () => {
      await writeFile(dir, '追踪/伏笔.md', '# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-1 | 测试 | 设定 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |\n')
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 3 && x.detail.includes('FB-1'))
      expect(v).toBeDefined()
      expect(v!.detail).toContain('FB-NNN')
    })

    it('FB 编号格式正确 + 枚举合法 → 通过', async () => {
      await writeFile(dir, '追踪/伏笔.md', '# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-001 | 测试 | 设定 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |\n')
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 3)
      expect(v).toBeUndefined()
    })

    it('伏笔类型不在枚举 → 违规', async () => {
      await writeFile(dir, '追踪/伏笔.md', '# 伏笔追踪\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-001 | 测试 | 其他 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |\n')
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 3 && x.detail.includes('其他'))
      expect(v).toBeDefined()
    })
  })

  describe('检查 6：卷终情绪 = 10', () => {
    it('卷终情绪值非 10 → 违规', async () => {
      // 大纲.md 定义卷结构
      await writeFile(
        dir,
        '大纲/大纲.md',
        '# 测试大纲\n\n## 主线剧情走向\n\n### 第1卷：测试（第1-30章）\n\n## 逐章节奏标注\n\n### 第1卷\n| 章节 | 标题 | 情绪值 | 爽点类型 | 卷 |\n|---|---|---|---|---|\n| 第 30 章 | 卷终 | 8 | 4 | 1 |\n'
      )
      // 节奏图谱 HTML 含 rhythmData（卷终情绪 8，应为 10）
      const html = makeRhythmHtml([
        { chapter: 30, title: '卷终', emotion: 8, climax: 4, volume: 1, actualized: false }
      ])
      await writeFile(dir, '图解/节奏图谱.html', html)
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 6)
      expect(v).toBeDefined()
      expect(v!.detail).toContain('8')
    })

    it('卷终情绪值 = 10 + climax = 4 → 通过', async () => {
      await writeFile(
        dir,
        '大纲/大纲.md',
        '# 测试大纲\n\n## 主线剧情走向\n\n### 第1卷：测试（第1-30章）\n\n## 逐章节奏标注\n\n### 第1卷\n| 章节 | 标题 | 情绪值 | 爽点类型 | 卷 |\n|---|---|---|---|---|\n| 第 30 章 | 卷终 | 10 | 4 | 1 |\n'
      )
      const html = makeRhythmHtml([
        { chapter: 30, title: '卷终', emotion: 10, climax: 4, volume: 1, actualized: false }
      ])
      await writeFile(dir, '图解/节奏图谱.html', html)
      const report = await checkOpeningConsistency(dir)
      const v = report.violations.find((x) => x.check === 6)
      expect(v).toBeUndefined()
    })
  })

  describe('整体报告', () => {
    it('无违规时 passed=true', async () => {
      await writeFile(dir, '细纲/细纲_第001章_测试.md', '## 第 1 章：测试\n')
      const report = await checkOpeningConsistency(dir)
      // 只检查是否有 blocking 违规（其他检查可能 advisory 但不应有 blocking）
      const blocking = report.violations.filter((v) => v.severity === 'blocking')
      expect(blocking.length).toBe(0)
    })

    it('stats 统计正确', async () => {
      await writeFile(dir, '细纲/细纲_第001章_测试.md', '## 第一章：测试\n')
      const report = await checkOpeningConsistency(dir)
      expect(report.stats.total).toBe(report.violations.length)
      expect(report.stats.blocking).toBeGreaterThan(0)
      expect(report.passed).toBe(false)
    })
  })
})

/** 构造包含 rhythmData 的节奏图谱 HTML（最小可用） */
function makeRhythmHtml(entries: Array<{ chapter: number; title: string; emotion: number; climax: number; volume: number; actualized: boolean }>): string {
  const lines = entries.map((e) =>
    `            { chapter: ${e.chapter}, title: ${JSON.stringify(e.title)}, emotion: ${e.emotion}, climax: ${e.climax}, volume: ${e.volume}, actualized: ${e.actualized} }`
  ).join(',\n')
  return `<html><script>
  const rhythmData = [
${lines}
  ];
  </script></html>`
}
