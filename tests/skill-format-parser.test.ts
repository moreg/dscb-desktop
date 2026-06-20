import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  readText,
  parseBoldFields
} from '../src/main/data/skill-format/md-parser'
import { parseRhythmData } from '../src/main/data/skill-format/rhythm-html'
import { ProjectSkillRepo } from '../src/main/data/skill-format/project-skill-repo'
import { OutlineMdRepo } from '../src/main/data/skill-format/outline-md-repo'
import { CharacterCardMdRepo } from '../src/main/data/skill-format/character-card-md-repo'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { LocationMdRepo } from '../src/main/data/skill-format/location-md-repo'
import { WorldviewMdRepo } from '../src/main/data/skill-format/worldview-md-repo'
import { ForeshadowingMdRepo } from '../src/main/data/skill-format/foreshadowing-md-repo'
import { ChapterProgressMdRepo } from '../src/main/data/skill-format/chapter-progress-md-repo'
import { CorePlotMdRepo } from '../src/main/data/skill-format/core-plot-md-repo'

const SAMPLE = 'O:/book/测试写作'
const HAS = existsSync(join(SAMPLE, '大纲', '大纲.md'))
const itIf = HAS ? it : it.skip

describe('v3.2 解析器（真实样本 测试写作）', () => {
  itIf('ProjectSkillRepo 解析书名与基本信息', async () => {
    const data = await new ProjectSkillRepo(SAMPLE).read()
    expect(data).not.toBeNull()
    expect(data!.name).toBe('末日也要先领证')
    expect(data!.genre).toContain('末日生存')
    expect(data!.targetChapters).toBe(300)
    expect(data!.chapterWordCount).toBe(2500)
  })

  itIf('OutlineMdRepo 解析 10 卷结构', async () => {
    const read = await new OutlineMdRepo(SAMPLE).read()
    expect(read).not.toBeNull()
    expect(read!.volumes).toHaveLength(10)
    expect(read!.volumes[0]).toMatchObject({
      number: 1,
      name: '天降老婆',
      chapterStart: 1,
      chapterEnd: 30
    })
    expect(read!.main.mainLine).toContain('天降老婆')
  })

  itIf('OutlineMdRepo 逐章节奏回退表解析出 300 章', async () => {
    const read = await new OutlineMdRepo(SAMPLE).read()
    expect(read!.rhythmFallback).toHaveLength(300)
    expect(read!.rhythmFallback[0]).toMatchObject({
      chapter: 1,
      title: '困兽',
      emotion: 5,
      climax: 1,
      volume: 1,
      actualized: false
    })
    expect(read!.rhythmFallback[29]).toMatchObject({ chapter: 30, emotion: 10, climax: 4 })
  })

  itIf('rhythm-html 解析 300 条 rhythmData', async () => {
    const html = await readText(join(SAMPLE, '图解', '节奏图谱.html'))
    const entries = parseRhythmData(html)
    expect(entries).not.toBeNull()
    expect(entries).toHaveLength(300)
    expect(entries![29]).toMatchObject({
      chapter: 30,
      title: '变异兽王',
      emotion: 10,
      climax: 4,
      actualized: false
    })
  })

  itIf('CharacterCardMdRepo 解析至少 5 个角色 + 富字段', async () => {
    const list = await new CharacterCardMdRepo(SAMPLE).list()
    expect(list.length).toBeGreaterThanOrEqual(5)
    const suMing = list.find((c) => c.name === '苏铭')
    expect(suMing).toBeDefined()
    expect(suMing!.role).toContain('主角')
    expect(suMing!.identity).toContain('体育生')
    expect(suMing!.rawFields?.['行为习惯']).toBeDefined()
    expect(suMing!.rawFields?.['觉醒路线']).toBeDefined()
    expect(list.find((c) => c.name === '季渊')).toBeDefined()
  })

  itIf('DetailedOutlineMdRepo 解析第 1 卷 30 章富字段', async () => {
    const list = await new DetailedOutlineMdRepo(SAMPLE).listAll()
    expect(list).toHaveLength(30)
    const ch1 = list[0]
    expect(ch1).toMatchObject({ chapterNumber: 1, title: '困兽', emotion: 5, climax: 1 })
    expect(ch1.plotSummary).toContain('孢子灾害')
    expect(ch1.charactersAppearing!.length).toBeGreaterThan(0)
    expect(ch1.hook).toContain('窗外')
    const ch2 = list[1]
    expect(ch2.goldenLine).toBeDefined()
  })

  itIf('CharacterCardMdRepo.listRelationships 解析关系变更日志', async () => {
    const list = await new CharacterCardMdRepo(SAMPLE).listRelationships()
    expect(list.length).toBeGreaterThanOrEqual(5)
    // 苏铭↔老吴 的「亦师亦友」关系应在
    const rel = list.find((r) => r.description?.includes('亦师亦友'))
    expect(rel).toBeDefined()
    expect(rel!.relationType).toBe('亦师亦友')
  })

  itIf('LocationMdRepo 解析地点档案', async () => {
    const list = await new LocationMdRepo(SAMPLE).list()
    expect(list.length).toBeGreaterThanOrEqual(8)
    const lib = list.find((l) => l.name.includes('大学图书馆'))
    expect(lib).toBeDefined()
    expect(lib!.category).toContain('城市建筑')
    expect(lib!.rawFields?.['关联事件']).toBeDefined()
    expect(lib!.rawFields?.['关联角色']).toContain('苏铭')
  })

  itIf('WorldviewMdRepo 解析世界观各节', async () => {
    const list = await new WorldviewMdRepo(SAMPLE).list()
    expect(list.length).toBeGreaterThanOrEqual(3)
    const names = list.map((w) => w.name)
    expect(names.some((n) => n.includes('力量') || n.includes('境界'))).toBe(true)
    expect(names.some((n) => n.includes('势力'))).toBe(true)
    // 每节 notes 非空
    expect(list[0].notes).toBeTruthy()
  })

  itIf('ForeshadowingMdRepo 解析伏笔追踪表 + 状态映射', async () => {
    const list = await new ForeshadowingMdRepo(SAMPLE).list()
    expect(list.length).toBeGreaterThanOrEqual(15)
    const ring = list.find((f) => f.id === 'FB-001')
    expect(ring).toBeDefined()
    expect(ring!.content).toContain('未来婚戒')
    expect(ring!.status).toBe('pending')
    expect(ring!.plantChapter).toBe(3)
    expect(ring!.expectedCollect).toBe(282)
    // FB-004 北方科研所：状态列「已回收（140-150）」→ collected；预计回收 140-150 → 140
    // 注意：本样本实际回收列填的是「未回收」（作者把章号写在状态列），故 actualCollect=undefined
    const lab = list.find((f) => f.id === 'FB-004')
    expect(lab).toBeDefined()
    expect(lab!.status).toBe('collected')
    expect(lab!.expectedCollect).toBe(140)
    expect(lab!.actualCollect).toBeUndefined()
  })

  itIf('ChapterProgressMdRepo 解析章节进度（不含范围行污染）', async () => {
    const map = await new ChapterProgressMdRepo(SAMPLE).read()
    expect(map.size).toBeGreaterThan(0)
    expect(map.get(1)?.note).toContain('卷首')
    expect(map.get(2)?.note).toContain('徐昭昭登场')
    // 卷 3 摘要行「第 61-90 章」不应被误解析为单章 61
    expect(map.has(61)).toBe(false)
  })

  itIf('CorePlotMdRepo 把核心情节每章映射为剧情点实体', async () => {
    const list = await new CorePlotMdRepo(SAMPLE).list()
    expect(list.length).toBe(300)
    const ch1 = list.find((p) => p.name.startsWith('第1章'))
    expect(ch1).toBeDefined()
    expect(ch1!.notes).toContain('孢子灾害')
    expect(ch1!.category).toBe('核心情节')
  })

  it('md-parser 基础：parseBoldFields 多行子列表', () => {
    const body = [
      '- **姓名**：苏铭',
      '- **行为习惯**：',
      '  - 每天用本子记录物资消耗',
      '  - 紧张时会揉后颈',
      '- **金手指**：体能基础'
    ].join('\n')
    const { fields } = parseBoldFields(body)
    expect(fields.get('姓名')).toBe('苏铭')
    expect(fields.get('行为习惯')).toEqual([
      '每天用本子记录物资消耗',
      '紧张时会揉后颈'
    ])
    expect(fields.get('金手指')).toBe('体能基础')
  })
})
