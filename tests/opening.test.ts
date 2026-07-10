import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  inferStrength,
  STRENGTH_TO_GENRES,
  STRENGTH_LABELS,
  OPENING_SYSTEM_PROMPT
} from '../src/main/data/skill-prompts/opening/topic-routing'
import { buildCoreSettingsPrompt } from '../src/main/data/skill-prompts/opening/core-settings'
import { buildVolumeOutlinePrompt } from '../src/main/data/skill-prompts/opening/volume-outline'
import { buildChapterOutlinePrompt, FIRST_CHAPTERS_BATCH } from '../src/main/data/skill-prompts/opening/chapter-outline'
import { splitByChapterMarker } from '../src/main/data/opening-service'
import { parseChapterTitle, sanitizeTitleForFilename } from '../src/main/data/opening-markdown'

describe('inferStrength 脑洞→优势推断', () => {
  it('脑洞类关键词 → brain', () => {
    expect(inferStrength('主角有个签到系统')).toBe('brain')
    expect(inferStrength('穿越异世界带金手指')).toBe('brain')
    expect(inferStrength('无限流的脑洞')).toBe('brain')
  })

  it('文笔类关键词 → writing', () => {
    expect(inferStrength('写一个文笔细腻的仙侠')).toBe('writing')
    expect(inferStrength('古风唯美修仙')).toBe('writing')
  })

  it('节奏类关键词 → rhythm', () => {
    expect(inferStrength('都市打脸爽文，节奏快')).toBe('rhythm')
    expect(inferStrength('热血战斗逆袭')).toBe('rhythm')
  })

  it('经验类关键词 → experience', () => {
    expect(inferStrength('医生职场行业文')).toBe('experience')
    expect(inferStrength('年代文种田日常')).toBe('experience')
  })

  it('无匹配默认 brain', () => {
    expect(inferStrength('一个普通的故事')).toBe('brain')
  })
})

describe('OpeningService volume outline continuation', () => {
  it('continues volume outline generation after token-limit truncation', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const generateStream = vi
      .fn()
      .mockImplementationOnce((_prompt: string, opts: { onToken?: (token: string) => void }) => {
        opts.onToken?.('partial-')
        throw new Error('LLM_OUTPUT_TRUNCATED')
      })
      .mockImplementationOnce((prompt: string, opts: { onToken?: (token: string) => void }) => {
        expect(prompt).toContain('CONTINUE_TRUNCATED_VOLUME_OUTLINE')
        expect(prompt).toContain('partial-')
        opts.onToken?.('done')
        return 'done'
      })

    const svc = new OpeningService(
      { getProjectData: async () => ({ targetChapters: 200, chapterWordCount: 2500 }) } as never,
      { generateStream } as never,
      undefined
    )
    const tokens: string[] = []

    const md = await svc.generateVolumeOutline('p1', 'core settings', {
      onToken: (token) => tokens.push(token)
    })

    expect(md).toBe('partial-done')
    expect(tokens.join('')).toBe('partial-done')
    expect(generateStream).toHaveBeenCalledTimes(2)
    const firstOpts = generateStream.mock.calls[0][1] as { maxTokens?: number }
    expect(firstOpts.maxTokens).toBeGreaterThan(8192)
  })
})

describe('STRENGTH_TO_GENRES / STRENGTH_LABELS 完整', () => {
  it('4 个优势齐全', () => {
    expect(Object.keys(STRENGTH_LABELS)).toHaveLength(4)
    for (const key of ['brain', 'writing', 'rhythm', 'experience'] as const) {
      expect(STRENGTH_TO_GENRES[key].length).toBeGreaterThan(0)
      expect(STRENGTH_LABELS[key]).toBeTruthy()
    }
  })
})

describe('buildCoreSettingsPrompt 核心设定 prompt', () => {
  it('含脑洞内容', () => {
    const prompt = buildCoreSettingsPrompt('主角重生带系统', '脑洞好', undefined)
    expect(prompt).toContain('主角重生带系统')
  })

  it('含核心设定表骨架', () => {
    const prompt = buildCoreSettingsPrompt('test', 'test', undefined)
    expect(prompt).toContain('核心设定表')
    expect(prompt).toContain('一句话梗概')
    expect(prompt).toContain('世界观骨架')
    expect(prompt).toContain('核心冲突')
    expect(prompt).toContain('金手指')
    expect(prompt).toContain('设定/势力/{势力名}.md')
  })

  it('无对标时不注入召回段', () => {
    const prompt = buildCoreSettingsPrompt('t', 't', undefined)
    expect(prompt).not.toContain('对标书方法论召回')
  })

  it('有对标时注入召回段', () => {
    const prompt = buildCoreSettingsPrompt('t', 't', {
      bookNames: ['盘龙'],
      emotion: '打脸循环',
      rhythm: '每3000字一个爽点'
    })
    expect(prompt).toContain('对标书方法论召回')
    expect(prompt).toContain('《盘龙》')
    expect(prompt).toContain('打脸循环')
  })

  it('注入全员人设记忆点铁规', () => {
    const prompt = buildCoreSettingsPrompt('t', 't', undefined)
    expect(prompt).toContain('全员人设记忆点铁规')
    expect(prompt).toContain('核心配角')
    expect(prompt).toContain('标志性动作')
    expect(prompt).toContain('路人角色')
  })

  it('注入提示词质量自检清单', () => {
    const prompt = buildCoreSettingsPrompt('t', 't', undefined)
    expect(prompt).toContain('提示词质量自检')
    expect(prompt).toContain('基础爽点检查')
    expect(prompt).toContain('题材适配性检查')
    expect(prompt).toContain('逆袭起点')
  })

  it('角色卡模板含路人记忆点节', () => {
    const prompt = buildCoreSettingsPrompt('t', 't', undefined)
    expect(prompt).toContain('路人记忆点')
    expect(prompt).toContain('服务剧情')
  })
})

describe('buildVolumeOutlinePrompt 卷级大纲 prompt', () => {
  it('含核心设定和篇幅约束', () => {
    const prompt = buildVolumeOutlinePrompt('# 核心设定\n...', 200, 2500)
    expect(prompt).toContain('# 核心设定')
    expect(prompt).toContain('200 章')
    expect(prompt).toContain('2500 字')
  })

  it('含大纲四检', () => {
    const prompt = buildVolumeOutlinePrompt('cs', 100, 2000)
    expect(prompt).toContain('大纲四检')
    expect(prompt).toContain('交付什么情绪')
    expect(prompt).toContain('核心冲突')
    expect(prompt).toContain('伏笔')
  })

  it('含卷级大纲骨架', () => {
    const prompt = buildVolumeOutlinePrompt('cs', 100, 2000)
    expect(prompt).toContain('卷级大纲')
    expect(prompt).toContain('第一卷')
    expect(prompt).toContain('最终卷')
    expect(prompt).toContain('卷纲_第一卷.md')
  })

  it('注入爽文节奏公式（按卷长分级）', () => {
    const prompt = buildVolumeOutlinePrompt('cs', 100, 2000)
    expect(prompt).toContain('爽文节奏公式')
    expect(prompt).toContain('短卷')
    expect(prompt).toContain('长卷')
    expect(prompt).toContain('卷中决战')
    expect(prompt).toContain('卷终决战')
  })

  it('注入 6 类节奏违规自检', () => {
    const prompt = buildVolumeOutlinePrompt('cs', 100, 2000)
    expect(prompt).toContain('6 类节奏违规')
    expect(prompt).toContain('连续无爽点')
    expect(prompt).toContain('高潮拖沓')
    expect(prompt).toContain('开篇过曝')
    expect(prompt).toContain('卷中决战过早')
  })

  it('注入番茄章名风格规范', () => {
    const prompt = buildVolumeOutlinePrompt('cs', 100, 2000)
    expect(prompt).toContain('番茄小说章名风格规范')
    expect(prompt).toContain('三处标题一致性')
  })
})

describe('buildChapterOutlinePrompt 细纲 prompt', () => {
  it('含章节范围和字数', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 10, 2500, true)
    expect(prompt).toContain('第 1-10 章')
    expect(prompt).toContain('2500 字')
  })

  it('黄金三章加载额外法则（isGolden=true）', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 3, 2500, true)
    expect(prompt).toContain('黄金三章法则')
    expect(prompt).toContain('开篇钩子')
    expect(prompt).toContain('章末悬念')
  })

  it('非黄金三章不加载法则（isGolden=false）', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 11, 5, 2500, false)
    expect(prompt).not.toContain('黄金三章法则')
  })

  it('含五段式和字数预算', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 10, 2500, true)
    expect(prompt).toContain('内容概括（五段式）')
    expect(prompt).toContain('字数预算')
    expect(prompt).toContain('预算合计')
    expect(prompt).toContain('追踪/')
  })

  it('FIRST_CHAPTERS_BATCH 默认 10', () => {
    expect(FIRST_CHAPTERS_BATCH).toBe(10)
  })

  it('注入番茄章名风格规范', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 10, 2500, true)
    expect(prompt).toContain('番茄小说章名风格规范')
    expect(prompt).toContain('三处标题一致性')
    expect(prompt).toContain('七禁七必自检')
    expect(prompt).toContain('8 大爆款结构')
    expect(prompt).toContain('12-20 字')
  })

  it('注入完整细纲必填字段', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 10, 2500, true)
    expect(prompt).toContain('目标情绪')
    expect(prompt).toContain('章首钩子')
    expect(prompt).toContain('情绪变化曲线')
    expect(prompt).toContain('内容概括（五段式）')
    expect(prompt).toContain('情节安排（多线）')
    expect(prompt).toContain('人物关系和出场顺序')
    expect(prompt).toContain('情节细化')
    expect(prompt).toContain('代价兑现')
    expect(prompt).toContain('结尾设定和钩子')
    expect(prompt).toContain('写作禁区')
    expect(prompt).toContain('章首/章尾钩子类型标注')
    expect(prompt).toContain('字数预算契约')
    expect(prompt).toContain('追踪关联')
  })

  it('注入卡文处理流程', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 10, 2500, true)
    expect(prompt).toContain('卡文处理流程')
    expect(prompt).toContain('检查节奏图谱')
    expect(prompt).toContain('参考伏笔清单')
    expect(prompt).toContain('用户介入')
  })

  it('强调三处标题一致性', () => {
    const prompt = buildChapterOutlinePrompt('cs', 'vo', 1, 10, 2500, true)
    expect(prompt).toContain('三处标题一致性')
    expect(prompt).toContain('细纲_第NNN章_标题.md')
  })
})

describe('splitByChapterMarker 多章细纲解析', () => {
  it('按 === 第N章 === 分隔', () => {
    const md =
      '=== 第1章 ===\n第一章内容\n\n' +
      '=== 第2章 ===\n第二章内容\n\n' +
      '=== 第3章 ===\n第三章内容'
    const chapters = splitByChapterMarker(md)
    expect(chapters).toHaveLength(3)
    expect(chapters[0].chapterNumber).toBe(1)
    expect(chapters[0].content).toContain('第一章内容')
    expect(chapters[1].chapterNumber).toBe(2)
    expect(chapters[2].chapterNumber).toBe(3)
  })

  it('空章节号被跳过', () => {
    const md = '=== 第1章 ===\n内容'
    const chapters = splitByChapterMarker(md)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].chapterNumber).toBe(1)
  })

  it('无标记返回空数组', () => {
    expect(splitByChapterMarker('普通文本无标记')).toHaveLength(0)
  })

  it('支持 === 第10章 === 两位数', () => {
    const md = '=== 第10章 ===\n第十章'
    const chapters = splitByChapterMarker(md)
    expect(chapters[0].chapterNumber).toBe(10)
  })

  it('解析越界大章号（M1 防御测试：解析层不拦截，由 persistChapterOutlines 拦截）', () => {
    const md = '=== 第99999章 ===\n越界'
    const chapters = splitByChapterMarker(md)
    expect(chapters[0].chapterNumber).toBe(99999)
  })

  it('支持标准 markdown 标题 ### 第N章', () => {
    const md = '### 第1章：起航\n第一章内容\n\n### 第2章：重逢\n第二章内容'
    const chapters = splitByChapterMarker(md)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].chapterNumber).toBe(1)
    expect(chapters[0].content).toContain('### 第1章：起航')
    expect(chapters[0].content).toContain('第一章内容')
    expect(chapters[1].chapterNumber).toBe(2)
    expect(chapters[1].content).toContain('### 第2章：重逢')
    expect(chapters[1].content).toContain('第二章内容')
  })

  it('首章没有分隔符但直接开始写内容，后续章有分隔符', () => {
    const md = '### 第1章：起航\n第一章内容\n\n=== 第2章 ===\n第二章内容'
    const chapters = splitByChapterMarker(md)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].chapterNumber).toBe(1)
    expect(chapters[0].content).toContain('### 第1章：起航')
    expect(chapters[1].chapterNumber).toBe(2)
  })
})

describe('parseChapterTitle 章节标题解析', () => {
  it('解析 ## 第 N 章：标题', () => {
    expect(parseChapterTitle('## 第 1 章：反派以为她好拿捏\n- **核心事件**：测试')).toBe('反派以为她好拿捏')
  })

  it('解析 ### 第 N 章：标题', () => {
    expect(parseChapterTitle('### 第 5 章：她让全班看他出丑\n内容')).toBe('她让全班看他出丑')
  })

  it('支持英文冒号', () => {
    expect(parseChapterTitle('## 第 1 章: 觉醒\n')).toBe('觉醒')
  })

  it('无标题行返回空串', () => {
    expect(parseChapterTitle('- **核心事件**：无标题')).toBe('')
  })

  it('标题含特殊字符时保留（清洗由 sanitize 处理）', () => {
    expect(parseChapterTitle('## 第 1 章：一巴掌？打回原形！\n')).toBe('一巴掌？打回原形！')
  })
})

describe('sanitizeTitleForFilename 文件名清洗', () => {
  it('去除文件系统非法字符并折叠空白', () => {
    expect(sanitizeTitleForFilename('反派/ secretly: bad*')).toBe('反派 secretly bad')
  })

  it('去除反斜杠和管道符', () => {
    expect(sanitizeTitleForFilename('他\\她|大家')).toBe('他她大家')
  })

  it('截断到 30 字', () => {
    const long = '一二三四五六七八九十'.repeat(10) // 100 字
    expect(sanitizeTitleForFilename(long)).toHaveLength(30)
  })

  it('去除末尾点号', () => {
    expect(sanitizeTitleForFilename('觉醒...')).toBe('觉醒')
  })

  it('空标题返回空串', () => {
    expect(sanitizeTitleForFilename('')).toBe('')
    expect(sanitizeTitleForFilename('   ')).toBe('')
  })

  it('正常番茄风标题保留', () => {
    expect(sanitizeTitleForFilename('反派以为她好拿捏，结果她读心了三秒')).toBe('反派以为她好拿捏，结果她读心了三秒')
  })
})

describe('persistChapterOutlines 细纲落盘路径（技能规范对齐）', () => {
  it('有标题时写入 细纲/细纲_第NNN章_标题.md', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-title-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(projectServiceMock as never, {} as never, undefined)

    const res = await svc.persistOpening(
      'p1',
      '=== 设定/题材定位.md ===\n# 题材定位',
      '=== 大纲/大纲.md ===\n# 大纲',
      '=== 第1章 ===\n## 第 1 章：反派以为她好拿捏\n- **核心事件**：测试',
      1
    )

    expect(res.chapterFiles).toContain('细纲/细纲_第001章_反派以为她好拿捏.md')
    const content = await fs.readFile(
      join(tempDir, '细纲', '细纲_第001章_反派以为她好拿捏.md'),
      'utf-8'
    )
    expect(content).toContain('## 第 1 章：反派以为她好拿捏')
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('标题含非法字符时清洗后落盘', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-sanitize-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(projectServiceMock as never, {} as never, undefined)

    const res = await svc.persistOpening(
      'p1',
      '设定',
      '大纲',
      '=== 第1章 ===\n## 第 1 章：他/她的秘密：真相\n- **核心事件**：测试',
      1
    )

    // 标题「他/她的秘密：真相」→ 清洗掉 / 和 : → 「他她的秘密真相」
    expect(res.chapterFiles[0]).toBe('细纲/细纲_第001章_他她的秘密真相.md')
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})

describe('persistOpening 落盘校验（M2 防御）', () => {
  it('空核心设定抛错', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    // 用最小 mock：projectService.resolveDir 抛错即可触发前置校验前的检查
    const svc = new OpeningService(
      { resolveDir: async () => '/tmp' } as never,
      {} as never,
      undefined
    )
    await expect(
      svc.persistOpening('p1', '', '大纲', '细纲', 1)
    ).rejects.toThrow('核心设定为空')
    await expect(
      svc.persistOpening('p1', '设定', '', '细纲', 1)
    ).rejects.toThrow('卷级大纲为空')
    await expect(
      svc.persistOpening('p1', '设定', '大纲', '', 1)
    ).rejects.toThrow('细纲为空')
  })

  it('成功落盘并支持细纲格式容错兜底', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-test-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(
      projectServiceMock as never,
      {} as never,
      undefined
    )

    // 细纲没有任何 === 第N章 === 标记，触发容错兜底，全文作为第 1 章保存
    const res = await svc.persistOpening(
      'p1',
      '核心设定表内容',
      '卷级大纲表内容',
      '- **发展**: 陈洛在此醒来\n- **结尾**: 顺利结束',
      1
    )

    expect(res.settingsFile).toBe('设定/题材定位.md')
    expect(res.outlineFile).toBe('大纲/大纲.md')
    // 技能规范：细纲逐章独立文件 细纲/细纲_第NNN章.md（无标题时不带 _标题 后缀）
    expect(res.chapterFiles).toEqual(['细纲/细纲_第001章.md'])

    // 校验写入的文件内容
    const settingsContent = await fs.readFile(join(tempDir, res.settingsFile), 'utf-8')
    const outlineContent = await fs.readFile(join(tempDir, res.outlineFile), 'utf-8')
    const chapterContent = await fs.readFile(join(tempDir, res.chapterFiles[0]), 'utf-8')

    expect(settingsContent).toBe('核心设定表内容')
    expect(outlineContent).toBe('卷级大纲表内容')
    expect(chapterContent).toBe('- **发展**: 陈洛在此醒来\n- **结尾**: 顺利结束')

    // 清理临时目录
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('兜底容错时智能排除越界章号并提取范围内章号', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-test-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(
      projectServiceMock as never,
      {} as never,
      undefined
    )

    // 细纲包含越界章号（第99章）和合法章号（第3章），兜底时应正确提取第3章
    const res = await svc.persistOpening(
      'p1',
      '设定',
      '大纲',
      '在第99章我们会揭秘，但现在看第3章细纲内容',
      1 // fromChapter=1, maxAllowed=51
    )

    expect(res.chapterFiles).toEqual(['细纲/细纲_第003章.md'])
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('卷纲中文数字命名会标准化并生成别名文件', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-test-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(
      projectServiceMock as never,
      {} as never,
      undefined
    )

    await svc.persistOpening(
      'p1',
      '=== 设定/题材定位.md ===\n# 题材定位',
      '=== 大纲/大纲.md ===\n# 《测试》大纲\n\n## 伏笔清单\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n| FB-001 | 测试伏笔 | 设定 | 第 1 章 | 第 10 章 | 未回收 | 已埋设 |\n\n=== 大纲/卷纲_第一卷.md ===\n# 第一卷',
      '=== 第1章 ===\n## 第 1 章：起手\n- **核心事件**：测试',
      1
    )

    const normalizedExists = await fs
      .access(join(tempDir, '大纲', '卷纲_第1卷.md'))
      .then(() => true)
      .catch(() => false)
    const aliasExists = await fs
      .access(join(tempDir, '大纲', '卷纲_第一卷.md'))
      .then(() => true)
      .catch(() => false)

    expect(normalizedExists).toBe(true)
    expect(aliasExists).toBe(true)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('注入 DeslopService 时落盘前去 AI 味', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-deslop-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    // mock DeslopService：把"AI味词"替换掉，返回 rewritten
    const deslopServiceMock = {
      deslop: vi.fn().mockImplementation(async (text: string) => ({
        rewritten: text.replace(/眼神中闪过一丝冷意/g, '他眯了眯眼'),
        processedGates: ['A', 'B', 'G'] as never,
        beforeWords: 100,
        afterWords: 95,
        deleteRatio: 0.05,
        remainingFindings: [],
        changeSummary: ['替换 AI 味词 1 处']
      }))
    }
    const svc = new OpeningService(
      projectServiceMock as never,
      {} as never,
      undefined,
      deslopServiceMock as never
    )

    const res = await svc.persistOpening(
      'p1',
      '=== 设定/题材定位.md ===\n# 题材定位\n\n主角眼神中闪过一丝冷意。',
      '=== 大纲/大纲.md ===\n# 大纲\n\n## 伏笔清单\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n',
      '=== 第1章 ===\n## 第 1 章：测试\n眼神中闪过一丝冷意',
      1
    )

    // deslop 应被调用（设定 + 大纲 + 细纲）
    expect(deslopServiceMock.deslop).toHaveBeenCalled()
    // 落盘的题材定位应已替换 AI 味词
    const settingsContent = await fs.readFile(join(tempDir, '设定', '题材定位.md'), 'utf-8')
    expect(settingsContent).not.toContain('眼神中闪过一丝冷意')
    expect(settingsContent).toContain('他眯了眯眼')
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('未注入 DeslopService 时降级为原文（不阻塞）', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-nodeslop-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(projectServiceMock as never, {} as never, undefined, undefined)

    const res = await svc.persistOpening(
      'p1',
      '=== 设定/题材定位.md ===\n# 题材定位\n眼神中闪过一丝冷意',
      '=== 大纲/大纲.md ===\n# 大纲\n\n## 伏笔清单\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|---|---|---|---|---|---|---|\n',
      undefined,
      undefined
    )

    // 无 deslop 时原文直接落盘
    const settingsContent = await fs.readFile(join(tempDir, '设定', '题材定位.md'), 'utf-8')
    expect(settingsContent).toContain('眼神中闪过一丝冷意')
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})

describe('OPENING_SYSTEM_PROMPT 开书系统 prompt', () => {
  it('含核心方法和题材调性', () => {
    expect(OPENING_SYSTEM_PROMPT).toContain('情绪驱动')
    expect(OPENING_SYSTEM_PROMPT).toContain('优势匹配')
    expect(OPENING_SYSTEM_PROMPT).toContain('对标借鉴')
    expect(OPENING_SYSTEM_PROMPT).toContain('调性差异')
  })
})

describe('generateRhythmHtml 节奏图谱独立生成', () => {
  it('从卷级大纲生成 HTML（含 rhythmData 条目）', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const tempDir = await mkdtemp(join(tmpdir(), 'aw-opening-rhythm-'))
    const projectServiceMock = {
      resolveDir: async () => tempDir,
      getProjectData: async () => ({ name: '测试书', targetChapters: 30 })
    }
    const svc = new OpeningService(projectServiceMock as never, {} as never, undefined)

    const volumeOutline = [
      '=== 大纲/大纲.md ===',
      '# 《测试书》大纲',
      '',
      '## 逐章节奏标注',
      '',
      '### 第1卷',
      '| 章节 | 标题 | 情绪值 | 爽点类型 | 卷 |',
      '|---|---|---|---|---|',
      '| 第 1 章 | 反派以为她好拿捏 | 5 | 1 | 1 |',
      '| 第 2 章 | 全员震惊 | 7 | 2 | 1 |',
      '| 第 30 章 | 卷终决战 | 10 | 4 | 1 |',
      ''
    ].join('\n')

    const html = await svc.generateRhythmHtml('p1', volumeOutline)

    // HTML 含模板填充结果
    expect(html).toContain('《测试书》节奏图谱')
    expect(html).toContain('rhythmData')
    // 含三条 rhythmData 条目
    expect(html).toContain("chapter: 1")
    expect(html).toContain("chapter: 2")
    expect(html).toContain("chapter: 30")
    expect(html).toContain('反派以为她好拿捏')
    expect(html).toContain('卷终决战')

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('空大纲抛错', async () => {
    const { OpeningService } = await import('../src/main/data/opening-service')
    const projectServiceMock = {
      resolveDir: async () => '/tmp',
      getProjectData: async () => ({})
    }
    const svc = new OpeningService(projectServiceMock as never, {} as never, undefined)
    await expect(svc.generateRhythmHtml('p1', '')).rejects.toThrow('卷级大纲为空')
  })
})
