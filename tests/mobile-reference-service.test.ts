import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MobileReferenceService } from '../src/main/mobile/mobile-reference-service'
import type { ProjectService } from '../src/main/data/project-service'

describe('MobileReferenceService', () => {
  let dir: string
  let service: MobileReferenceService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-mobile-reference-'))
    service = new MobileReferenceService({ resolveDir: async () => dir } as unknown as ProjectService)
    await Promise.all(['正文', '细纲', '图解', '大纲'].map((folder) => mkdir(join(dir, folder))))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds unwritten chapter titles and prefers their current detailed outline title', async () => {
    await Promise.all([
      writeFile(join(dir, '图解', '节奏图谱.html'),
        `<script>const rhythmData = [
          { chapter: 1, title: '旧标题', emotion: 3, climax: 1, volume: 1, actualized: false },
          { chapter: 2, title: '月下寻人', emotion: 4, climax: 2, volume: 1, actualized: false },
          { chapter: 3, title: '荒城', emotion: 5, climax: 1, volume: 1, actualized: false }
        ];</script>`),
      writeFile(join(dir, '细纲', '第01卷.md'),
        '# 第一卷\n\n## 第 1 章：月下相逢\n- **核心事件**：见面\n'),
      writeFile(join(dir, '正文', '003.md'), '月下。远处灯火亮起，又一个月下。')
    ])

    const results = await service.search('project-1', '月下')
    expect(results).toMatchObject([
      { chapterNumber: 1, title: '月下相逢', snippet: '标题匹配', occurrences: 1 },
      { chapterNumber: 2, title: '月下寻人', snippet: '标题匹配', occurrences: 1 },
      { chapterNumber: 3, title: '荒城', occurrences: 2 }
    ])
    expect(results[2].snippet).toContain('月下')
    expect(await service.search('project-1', '旧标题')).toEqual([])
  })

  it('uses the outline chapter table when no rhythm diagram exists', async () => {
    await writeFile(join(dir, '大纲', '大纲.md'),
      '# 测试大纲\n\n## 逐章节奏标注\n\n' +
      '| 章节 | 标题 | 情绪值 | 爽点类型 |\n|---|---|---|---|\n' +
      '| 1 | 月下归来 | 6 | 2 |\n| 2 | 荒城重逢 | 7 | 1 |\n')

    await expect(service.search('project-1', '月下')).resolves.toMatchObject([
      { chapterNumber: 1, title: '月下归来', snippet: '标题匹配', occurrences: 1 }
    ])
  })

  it('reads the requested chapter detail and keeps case-insensitive prose search literal', async () => {
    await Promise.all([
      writeFile(join(dir, '细纲', '第01卷.md'),
        '# 第一卷\n\n## 第 1 章：相逢\n- **核心事件**：初见\n\n' +
        '## 第 2 章：失踪\n- **核心事件**：寻找失踪者\n'),
      writeFile(join(dir, '正文', '002.md'), 'Signal [A+B]，又一个 [a+b]。')
    ])

    await expect(service.getChapterDetail('project-1', 2)).resolves.toMatchObject({
      chapterNumber: 2, title: '失踪', plotSummary: '寻找失踪者'
    })
    await expect(service.search('project-1', '[A+B]')).resolves.toMatchObject([
      { chapterNumber: 2, occurrences: 2 }
    ])
    await expect(service.search('project-1', '   ')).resolves.toEqual([])
  })
})
