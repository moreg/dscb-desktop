import { describe, it, expect } from 'vitest'
import {
  splitByFileMarker,
  parseStructureCounts
} from '../src/main/data/teardown/teardown-service'

describe('splitByFileMarker 多文件输出解析', () => {
  it('按「=== 文件：path ===」分隔多文件', () => {
    const md =
      '=== 文件：剧情/节奏.md ===\n节奏内容\n\n' +
      '=== 文件：剧情/情绪模块.md ===\n情绪内容'
    const result = splitByFileMarker(md)
    expect(result).toHaveLength(2)
    expect(result[0].path).toBe('剧情/节奏.md')
    expect(result[0].content).toContain('节奏内容')
    expect(result[1].path).toBe('剧情/情绪模块.md')
    expect(result[1].content).toContain('情绪内容')
  })

  it('支持半角冒号', () => {
    const md = '=== 文件: 设定/背景.md ===\n背景内容'
    const result = splitByFileMarker(md)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('设定/背景.md')
  })

  it('无标记时返回空数组', () => {
    expect(splitByFileMarker('普通文本无标记')).toEqual([])
  })

  it('单文件', () => {
    const md = '=== 文件：拆文报告.md ===\n报告内容'
    const result = splitByFileMarker(md)
    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('报告内容')
  })
})

describe('parseStructureCounts 结构计数解析', () => {
  it('解析 camelCase JSON', () => {
    const json = JSON.stringify({
      beats: 5,
      hooks: 4,
      setupClues: 3,
      characterArchetypes: 3,
      reusableStructures: 4,
      reversalType: '视角反转'
    })
    const counts = parseStructureCounts(json)
    expect(counts.beats).toBe(5)
    expect(counts.hooks).toBe(4)
    expect(counts.setupClues).toBe(3)
    expect(counts.characterArchetypes).toBe(3)
    expect(counts.reusableStructures).toBe(4)
    expect(counts.reversalType).toBe('视角反转')
  })

  it('解析 snake_case JSON（LLM 可能输出此格式）', () => {
    const json = JSON.stringify({
      beats: 5,
      hooks: 4,
      setup_clues: 3,
      character_archetypes: 3,
      reusable_structures: 4,
      reversal_type: '身份反转'
    })
    const counts = parseStructureCounts(json)
    expect(counts.setupClues).toBe(3)
    expect(counts.characterArchetypes).toBe(3)
    expect(counts.reusableStructures).toBe(4)
    expect(counts.reversalType).toBe('身份反转')
  })

  it('从 markdown 代码块中提取 JSON', () => {
    const md = '```json\n{"beats": 5, "hooks": 3}\n```'
    const counts = parseStructureCounts(md)
    expect(counts.beats).toBe(5)
    expect(counts.hooks).toBe(3)
  })

  it('空字符串返回全 0', () => {
    const counts = parseStructureCounts('')
    expect(counts.beats).toBe(0)
    expect(counts.hooks).toBe(0)
    expect(counts.setupClues).toBe(0)
  })

  it('非法 JSON 返回全 0', () => {
    const counts = parseStructureCounts('not a json')
    expect(counts.beats).toBe(0)
  })

  it('字符串数值被转换', () => {
    const json = JSON.stringify({
      beats: '5',
      hooks: '3',
      setupClues: '4',
      characterArchetypes: '2',
      reusableStructures: '3'
    })
    const counts = parseStructureCounts(json)
    expect(counts.beats).toBe(5)
    expect(counts.hooks).toBe(3)
  })

  it('缺字段补 0', () => {
    const json = JSON.stringify({ beats: 5 })
    const counts = parseStructureCounts(json)
    expect(counts.beats).toBe(5)
    expect(counts.hooks).toBe(0)
    expect(counts.reversalType).toBeUndefined()
  })
})
