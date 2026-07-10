import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { OutlineRepository } from '../src/main/data/outline-repository'
import { CharacterRepository } from '../src/main/data/character-repository'
import { ForeshadowingRepository } from '../src/main/data/foreshadowing-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { WriteFlowService } from '../src/main/data/write-flow-service'
import type { LlmService, GenerateOptions } from '../src/main/data/llm-service'
import type { SettingsRepository } from '../src/main/data/settings-repository'

function mockLlm(reply: string): LlmService {
  return {
    generateStream: vi.fn().mockResolvedValue(reply)
  } as unknown as LlmService
}

const mockSettings = {
  getProjectsRoot: async (fallback: string) => fallback
} as unknown as SettingsRepository

describe('buildChapterPrompt (new system+user format)', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-bcp-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻修真' })).id
  })

  it('returns { system, user } with system embedding skill rules', async () => {
    const service = new WriteService(ps, mockLlm('正文'))
    const out = await service.buildChapterPrompt(projectId, 1)
    expect(out).toHaveProperty('system')
    expect(out).toHaveProperty('user')
    expect(out.system).toContain('章末结尾硬性原则')
    expect(out.system).toContain('禁用高频词')
    expect(out.system).toContain('顺序铁律')
  })

  it('system prompt voice matches genre', async () => {
    const svc1 = new WriteService(ps, mockLlm('正文'))
    const out1 = await svc1.buildChapterPrompt(projectId, 1)
    // 玄幻修真 → fantasy voice
    expect(out1.system).toContain('玄幻/修仙')

    // 新建一个古风项目验证语感切换
    const id2 = (await ps.create({ name: '剑无名', genre: '古风仙侠' })).id
    const out2 = await new WriteService(ps, mockLlm('正文')).buildChapterPrompt(id2, 1)
    expect(out2.system).toContain('古风/仙侠')
    expect(out2.system).toContain('勾了勾唇')
    expect(out2.system).not.toContain('他心里直骂娘')
  })

  it('user prompt assembles project name, synopsis, chapter detail', async () => {
    const dir = await ps.resolveDir(projectId)
    // 写 大纲/大纲.md（新格式真相源，覆盖项目创建时的「（待生成）」默认）
    const fs = await import('fs/promises')
    await fs.writeFile(
      path.join(dir, '大纲', '大纲.md'),
      '# 《青云志》大纲\n\n## 主线剧情走向\n\n少年修仙主线\n\n### 第1卷：初入仙门（第1-30章）\n'
    )
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远首次突破筑基',
      coolPoint: '打脸宗门长老',
      hook: '门外传来脚步声',
      goldenLine: '我不入轮回，谁入轮回',
      writingRequirements: '击败长老后不留活口'
    })
    await new CharacterRepository(dir).create({
      name: '林远',
      role: '主角',
      personality: '坚毅'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('青云志')
    expect(user).toContain('少年修仙主线')
    expect(user).toContain('林远首次突破筑基')
    expect(user).toContain('打脸宗门长老')
    expect(user).toContain('门外传来脚步声')
    expect(user).toContain('我不入轮回，谁入轮回')
    expect(user).toContain('击败长老后不留活口')
    expect(user).toContain('【本章硬性写作要求】')
    expect(user).toContain('以下要求必须全部落实到正文里')
    expect(user).toContain('下笔前先自检一次')
    expect(user).toContain('林远')
    // 未填细纲字数预估 → 兜底 2500，且为强约束"不少于"
    expect(user).toContain('正文不少于 2500 字')
    expect(user).not.toContain('约 2500 字')
  })

  it('falls back to outlines/main.json synopsis when 大纲.md has empty 主线剧情走向', async () => {
    // 项目创建时 大纲.md 默认「（待生成）」；若用户在 outlines/main.json 填了 synopsis，应回退取用
    const dir = await ps.resolveDir(projectId)
    // 大纲.md 已由 project-service.create 生成，内容为「（待生成）」
    await new OutlineRepository(dir).writeMain({
      schemaVersion: 1,
      updatedAt: 't',
      synopsis: '老项目主线（JSON 兜底）'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    // 大纲.md 的 synopsis 是「（待生成）」（非空但无意义），应回退读 JSON
    expect(user).toContain('老项目主线（JSON 兜底）')
    expect(user).not.toContain('（待生成）')
  })

  it('renders chapter writing requirements as a checklist', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远夜探山门',
      writingRequirements: '1. 开头强情绪\n- 结尾必须用对话收束\n人物对话要贴合角色'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('【本章硬性写作要求】')
    expect(user).toContain('- 开头强情绪')
    expect(user).toContain('- 结尾必须用对话收束')
    expect(user).toContain('- 人物对话要贴合角色')
  })

  it('combines selected requirement template with custom additions', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远试探师尊口风',
      writingRequirementTemplateId: 'dialogue-character-voice',
      writingRequirementCustomText: '结尾必须用一句试探意味很强的对话收束',
      writingRequirements:
        '人物对话要符合各自身份、性格和当下情绪\n台词尽量短促有来回，避免大段解释背景\n通过停顿、动作和反应补足潜台词，不要只靠直说\n关键情绪变化优先通过对话碰撞来体现\n结尾必须用一句试探意味很强的对话收束'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('- 人物对话要符合各自身份、性格和当下情绪')
    expect(user).toContain('- 台词尽量短促有来回，避免大段解释背景')
    expect(user).toContain('- 结尾必须用一句试探意味很强的对话收束')
  })

  it('user prompt includes prev chapter content tail when available', async () => {
    const dir = await ps.resolveDir(projectId)
    // 新数据源：上一章正文写入 ProseRepo
    const longPrev = '开头无关内容。'.repeat(200) + '上一章末尾的关键悬念。'
    await new ProseRepo(dir).write(1, longPrev)

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('上一章正文结尾')
    expect(user).toContain('上一章末尾的关键悬念')
    // 应当截尾，不会塞整段
    expect(user.length).toBeLessThan(longPrev.length + 5000)
  })

  it('gracefully degrades when no outline/prev chapter/foreshadowings present', async () => {
    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    expect(user).toContain('青云志')
    expect(user).toContain('（本章无细纲')
    expect(user).not.toContain('上一章正文结尾')
  })

  it('includes pending and due-now foreshadowings with section labels', async () => {
    const dir = await ps.resolveDir(projectId)
    await new ForeshadowingRepository(dir).create({
      content: '神秘玉佩的来历',
      expectedCollect: 5
    })
    const planted = await new ForeshadowingRepository(dir).create({
      content: '师父留下的字条',
      expectedCollect: 3
    })
    await new ForeshadowingRepository(dir).update(planted.id, {})
    // 模拟已埋设到第 1 章，预计第 3 章回收
    await new ForeshadowingRepository(dir).plant(planted.id, 1)

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 3)
    expect(user).toContain('师父留下的字条')
    expect(user).toContain('本章必须回收的伏笔')
    expect(user).toContain('神秘玉佩的来历')
    expect(user).toContain('建议本章铺垫的伏笔')
  })

  it('splits characters into appearing vs other based on chapter detail', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远遇到苏怜',
      charactersAppearing: ['林远', '苏怜']
    })
    await new CharacterRepository(dir).create({ name: '林远', role: '主角', personality: '坚毅' })
    await new CharacterRepository(dir).create({ name: '苏怜', role: '女主', personality: '冷淡' })
    await new CharacterRepository(dir).create({ name: '赵乾', role: '反派', personality: '阴险' })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 2)
    expect(user).toContain('本章出场角色')
    expect(user).toContain('其他已知角色')
    // 出场角色含人设细节，未出场只列名字
    const appearingIdx = user.indexOf('本章出场角色')
    const otherIdx = user.indexOf('其他已知角色')
    expect(appearingIdx).toBeGreaterThan(0)
    expect(otherIdx).toBeGreaterThan(appearingIdx)
    // 反派出现在"其他已知角色"区
    const otherSection = user.slice(otherIdx)
    expect(otherSection).toContain('赵乾')
  })

  it('parses wordEstimate from chapter detail into a hard minimum and exposes targetWords', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远突破筑基',
      wordEstimate: '约 3000 字'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user, system, targetWords } = await service.buildChapterPrompt(projectId, 2)

    // 细纲填了 3000 → 强约束用 3000，不再是兜底的 2500
    expect(targetWords).toBe(3000)
    expect(user).toContain('正文不少于 3000 字')
    expect(user).not.toContain('不少于 2500 字')
    // system prompt 不应再写死 2500（避免与 user prompt 的具体字数打架）
    expect(system).not.toContain('2500')
  })

  it('wordEstimate range "2500-3000" takes the upper bound', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远突破筑基',
      wordEstimate: '2500-3000'
    })
    const service = new WriteService(ps, mockLlm('正文'))
    const { user, targetWords } = await service.buildChapterPrompt(projectId, 2)
    expect(targetWords).toBe(3000)
    expect(user).toContain('正文不少于 3000 字')
  })
})

describe('generateChapterStream passes systemPrompt to llm', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-gcs-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻' })).id
  })

  it('calls llm.generateStream with systemPrompt option', async () => {
    const generateStream = vi.fn().mockResolvedValue('正文')
    const llm = { generateStream } as unknown as LlmService

    const service = new WriteService(ps, llm)
    await service.generateChapterStream(projectId, 1)

    expect(generateStream).toHaveBeenCalledTimes(1)
    const [userPrompt, opts] = (generateStream as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      GenerateOptions
    ]
    expect(userPrompt).toContain('青云志')
    expect(opts.systemPrompt).toBeDefined()
    expect(opts.systemPrompt).toContain('章末结尾硬性原则')
    expect(opts.meta?.feature).toBe('chapter')
    // 默认目标 2500 → 反算 maxTokens 应高于旧的硬编码 4096
    expect(opts.maxTokens).toBeDefined()
    expect(opts.maxTokens!).toBeGreaterThan(4096)
  })

  it('derives maxTokens from wordEstimate so longer chapters are not truncated', async () => {
    const dir = await ps.resolveDir(projectId)
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 2,
      plotSummary: '林远突破筑基',
      wordEstimate: '约 4000 字'
    })
    const generateStream = vi.fn().mockResolvedValue('正文')
    const llm = { generateStream } as unknown as LlmService

    const service = new WriteService(ps, llm)
    await service.generateChapterStream(projectId, 2)

    const opts = (generateStream as ReturnType<typeof vi.fn>).mock.calls[0][1] as GenerateOptions
    // 4000 字 × 1.7 × 1.3 ≈ 8840
    expect(opts.maxTokens).toBeGreaterThanOrEqual(8800)
  })
})

describe('buildChapterPrompt with structured prev ending state (Phase 12 Task 1)', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-p12t1-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '青云志', genre: '玄幻修真' })).id
  })

  it('injects structured prev ending state into user prompt', async () => {
    const dir = await ps.resolveDir(projectId)
    // 新数据源：上一章正文写入 ProseRepo
    await new ProseRepo(dir).write(1, '林远在客栈打坐。门外传来脚步声。')

    // mock LLM：extractEndingState 调用返回结构化 JSON
    const endingJson = JSON.stringify({
      characterPositions: [{ name: '林远', location: '客栈', action: '打坐' }],
      characterStates: [{ name: '林远', emotion: '警觉', body: '无伤', items: '长剑' }],
      timePoint: '深夜',
      unfinished: ['门外脚步声未确认身份'],
      suspense: '门外脚步声',
      props: ['师父留下的玉佩']
    })
    const flow = new WriteFlowService(mockLlm(endingJson))
    const service = new WriteService(ps, mockLlm('正文'), flow)
    const { user } = await service.buildChapterPrompt(projectId, 2)

    expect(user).toContain('上一章结尾状态')
    expect(user).toContain('林远')
    expect(user).toContain('客栈')
    expect(user).toContain('深夜')
    expect(user).toContain('门外脚步声')
    expect(user).toContain('师父留下的玉佩')
    expect(user).toContain('本章必须回应')
    expect(user).toContain('本章必须处理')
  })

  it('omits structured state section when prevTail is empty', async () => {
    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    expect(user).not.toContain('上一章结尾状态')
  })
})

describe('buildChapterPrompt with new skill-format context (outline md / tracking / settings / foreshadowing dual-path)', () => {
  let root: string
  let projectId: string
  let ps: ProjectService

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aw-sf-ctx-'))
    const library = new LibraryRepository(path.join(root, 'library.json'))
    ps = new ProjectService(path.join(root, 'projects'), library, mockSettings)
    projectId = (await ps.create({ name: '民国老六', genre: '历史' })).id
  })

  it('injects outline from 大纲/大纲.md (new OutlineMdRepo) when outlines/main.json absent', async () => {
    const dir = await ps.resolveDir(projectId)
    // 写 大纲/大纲.md（新格式，顶层表格，无「主线剧情走向」H2 节）
    await import('fs/promises').then((fs) => fs.mkdir(path.join(dir, '大纲'), { recursive: true }))
    await import('fs/promises').then((fs) =>
      fs.writeFile(
        path.join(dir, '大纲', '大纲.md'),
        '# 大纲\n\n| 章节 | 标题 | 情绪值 | 爽点 | 卷 |\n|------|------|--------|------|-----|\n| 第 1 章 | 痞子跪地喊我爷 | 7 | 2 | 1 |\n'
      )
    )

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    // 大纲表能被解析（rhythmFallback），但 synopsis 为空（无「主线剧情走向」节）→ 不应注入空总纲
    // 关键：不再因 outlines/main.json 不存在而报错
    expect(user).toContain('民国老六')
  })

  it('reads foreshadowings from 追踪/伏笔.md when 记忆系统/伏笔追踪.md is empty', async () => {
    const dir = await ps.resolveDir(projectId)
    await import('fs/promises').then((fs) => fs.mkdir(path.join(dir, '追踪'), { recursive: true }))
    await import('fs/promises').then((fs) =>
      fs.writeFile(
        path.join(dir, '追踪', '伏笔.md'),
        '# 伏笔追踪表\n\n## 主线伏笔\n\n| 伏笔编号 | 伏笔内容 | 伏笔类型 | 埋设章节 | 预计回收章节 | 实际回收章节 | 状态 |\n|----------|----------|----------|----------|-------------|-------------|------|\n| FB-001 | 罗盘来历 | 道具 | 第 1 章 | 第 400 章 | 未回收 | 未回收 |\n| FB-101 | 三日血光之灾 | 势力 | 第 1 章 | 第 6 章 | 未回收 | 已埋设 |\n'
      )
    )
    // 同时细纲指定第 6 章（让 FB-101 expectedCollect=6 命中 dueNow）
    await new OutlineRepository(dir).upsertDetailed({
      chapterNumber: 6,
      plotSummary: '刘三刀三日血光应验'
    })

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 6)
    // FB-101 应该作为「本章必须回收的伏笔」注入
    expect(user).toContain('三日血光之灾')
    expect(user).toContain('本章必须回收的伏笔')
    // FB-001 应该作为「已埋设但未到本章回收」注入
    expect(user).toContain('罗盘来历')
  })

  it('injects tracking context (character states + progress + issues)', async () => {
    const dir = await ps.resolveDir(projectId)
    await import('fs/promises').then((fs) => fs.mkdir(path.join(dir, '追踪'), { recursive: true }))
    await import('fs/promises').then((fs) =>
      fs.writeFile(
        path.join(dir, '追踪', '角色状态.md'),
        '# 角色状态快照\n\n## 当前状态\n\n| 角色 | 当前实力 | 当前立场 | 当前目标 | 关键道具 | 关系快照 | 更新章节 |\n|------|----------|----------|----------|----------|----------|----------|\n| 苏九 | 暗劲；铁罗盘 Lv.1 | 中立偏苟 | 解决威胁 | 运势罗盘 | 沈清秋：房东 | 第 10 章 |\n'
      )
    )
    await import('fs/promises').then((fs) =>
      fs.writeFile(
        path.join(dir, '追踪', '上下文.md'),
        '# 日更进度摘要\n\n| 日期 | 章节 | 进度摘要 | 下一章目标 | 阻塞点 |\n|------|------|----------|-----------|--------|\n| 2026-07-05 | 第11章 | 完成第11章 | 第12章 | 时间线冲突 |\n'
      )
    )
    await import('fs/promises').then((fs) =>
      fs.writeFile(
        path.join(dir, '追踪', '问题记录.md'),
        '# 问题记录\n\n| 日期 | 问题描述 | 原因分析 | 修正方案 | 状态 |\n|------|----------|----------|----------|------|\n| 2026-07-03 | 精神力账目不一致 | 第5章多算消耗 | 回退数值 | 待处理 |\n'
      )
    )

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 12)
    expect(user).toContain('角色状态追踪')
    expect(user).toContain('苏九')
    expect(user).toContain('暗劲')
    expect(user).toContain('近期写作进度')
    expect(user).toContain('时间线冲突')
    expect(user).toContain('待处理问题')
    expect(user).toContain('精神力账目不一致')
  })

  it('injects settings context (genre positioning + worldview + custom rules)', async () => {
    const dir = await ps.resolveDir(projectId)
    const fs = await import('fs/promises')
    await fs.mkdir(path.join(dir, '设定', '世界观'), { recursive: true })
    await fs.mkdir(path.join(dir, '设定', '势力'), { recursive: true })
    await fs.writeFile(
      path.join(dir, '设定', '题材定位.md'),
      '# 题材定位\n\n## 核心梗\n民国乱世，重生武术传奇凭运势罗盘摆摊算命。\n'
    )
    await fs.writeFile(
      path.join(dir, '设定', '世界观', '金手指.md'),
      '# 金手指\n\n## 限制\n每次使用消耗精神力，连续 3-5 次后头痛。\n'
    )
    await fs.writeFile(
      path.join(dir, '设定', '罗盘指认功能规则.md'),
      '# 罗盘指认功能规则\n\n转一半就停 = 残余势力暗中观察。\n'
    )

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    expect(user).toContain('项目设定')
    expect(user).toContain('题材定位')
    expect(user).toContain('运势罗盘')
    expect(user).toContain('世界观')
    expect(user).toContain('金手指')
    expect(user).toContain('规则文档')
    expect(user).toContain('转一半就停')
  })

  it('injects volume outline (卷核心/情绪弧线) from 大纲/第N卷_卷名.md', async () => {
    const dir = await ps.resolveDir(projectId)
    const fs = await import('fs/promises')
    await fs.mkdir(path.join(dir, '大纲'), { recursive: true })
    // 大纲.md 含卷结构（让 OutlineMdRepo 能找到卷 1 的范围 1-30）
    await fs.writeFile(
      path.join(dir, '大纲', '大纲.md'),
      '# 大纲\n\n## 主线剧情走向\n\n### 第1卷：码头神算（第1-30章）\n码头开局。\n'
    )
    // 卷纲文件
    await fs.writeFile(
      path.join(dir, '大纲', '第1卷_码头神算.md'),
      '# 卷纲：第1卷 码头神算（第1-30章）\n\n## 卷核心\n- 卷名：码头神算\n- 章节范围：第1-30章\n- 核心冲突：苏九重生归来建立神算子名声\n\n## 情绪弧线\n1-2章（压抑铺垫）→ 3-9章（小打脸循环）→ 25-30章（卷终决战）\n'
    )

    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 5)
    expect(user).toContain('卷级定位')
    expect(user).toContain('码头神算')
    expect(user).toContain('核心冲突')
    expect(user).toContain('情绪弧线')
  })

  it('gracefully degrades when 追踪/ and 设定/ do not exist (old projects)', async () => {
    const service = new WriteService(ps, mockLlm('正文'))
    const { user } = await service.buildChapterPrompt(projectId, 1)
    // 不应出现新注入段的标题
    expect(user).not.toContain('角色状态追踪')
    expect(user).not.toContain('项目设定')
    expect(user).not.toContain('卷级定位')
    // 基本功能仍正常
    expect(user).toContain('民国老六')
  })
})

