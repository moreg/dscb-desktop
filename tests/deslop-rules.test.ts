import { describe, it, expect } from 'vitest'
import {
  serializeDeslopRulesToMd,
  parseDeslopRulesFromMd,
  buildDeslopRuleEditPrompt,
  resolveDeslopTextOverrides,
  resolveDeslopBannedWords,
  DESLOP_RULE_SECTIONS,
  DESLOP_BANNED_WORDS_TITLE
} from '../src/main/data/skill-prompts/deslop/deslop-rules'
import { DESLOP_SYSTEM_PROMPT, GATE_METHODS } from '../src/main/data/skill-prompts/deslop/anti-ai-methods'
import { FLATTENED_LEVEL1 } from '../src/main/data/deslop/banned-words'

describe('DESLOP_RULE_SECTIONS 注册表', () => {
  it('包含系统铁律 + Gate A-G 共 8 节，默认文本来自 anti-ai-methods', () => {
    expect(DESLOP_RULE_SECTIONS).toHaveLength(8)
    const keys = DESLOP_RULE_SECTIONS.map((s) => s.key)
    expect(keys).toEqual([
      'systemPrompt', 'gateA', 'gateB', 'gateC', 'gateD', 'gateE', 'gateF', 'gateG'
    ])
    const sys = DESLOP_RULE_SECTIONS.find((s) => s.key === 'systemPrompt')!
    expect(sys.text).toBe(DESLOP_SYSTEM_PROMPT)
    const gateB = DESLOP_RULE_SECTIONS.find((s) => s.key === 'gateB')!
    expect(gateB.text).toBe(GATE_METHODS.B)
  })
})

describe('serializeDeslopRulesToMd', () => {
  it('无覆盖时输出 9 个二级标题（8 节 + 禁用词表），正文是内置默认', () => {
    const md = serializeDeslopRulesToMd({}, ['仿佛', '缓缓'])
    const headings = md.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toHaveLength(9)
    expect(headings[0]).toBe('## 系统铁律（改写总则）')
    expect(headings[1]).toBe('## Gate A：禁用词替换')
    expect(headings[8]).toBe(`## ${DESLOP_BANNED_WORDS_TITLE}`)
    // 禁用词正文按行排列
    expect(md).toContain('## ' + DESLOP_BANNED_WORDS_TITLE + '\n仿佛\n缓缓')
  })

  it('覆盖优先于默认正文', () => {
    const md = serializeDeslopRulesToMd(
      { gateA: '【自定义 Gate A 文本】' },
      []
    )
    expect(md).toContain('## Gate A：禁用词替换\n【自定义 Gate A 文本】')
    // 未覆盖的 Gate B 仍是默认
    expect(md).toContain(GATE_METHODS.B)
  })
})

describe('parseDeslopRulesFromMd（serialize→parse 往返）', () => {
  it('无覆盖往返：解析结果应无覆盖（全等于默认，不进 overrides）', () => {
    const original = serializeDeslopRulesToMd({}, ['仿佛', '缓缓', '微微'])
    const parsed = parseDeslopRulesFromMd(original)
    // 未覆盖时节正文 == 默认，resolveDeslopTextOverrides 会过滤掉，但 parse 本身会原样回填
    expect(parsed.bannedWords).toEqual(['仿佛', '缓缓', '微微'])
    expect(parsed.overrides.gateA).toBe(GATE_METHODS.A)
    expect(parsed.overrides.systemPrompt).toBe(DESLOP_SYSTEM_PROMPT)
  })

  it('覆盖往返：自定义文本被正确切节回填', () => {
    const customA = '【自定义 A】\n- 第一条\n- 第二条'
    const customB = 'Gate B 改写内容'
    const original = serializeDeslopRulesToMd({ gateA: customA, gateB: customB }, ['眼眸', '凝视'])
    const parsed = parseDeslopRulesFromMd(original)
    expect(parsed.overrides.gateA).toBe(customA)
    expect(parsed.overrides.gateB).toBe(customB)
    expect(parsed.bannedWords).toEqual(['眼眸', '凝视'])
  })

  it('未知标题节被丢弃，不污染 overrides', () => {
    const md = `## Gate A：禁用词替换
默认 A 正文

## 这是一个不存在的节标题
垃圾内容

## ${DESLOP_BANNED_WORDS_TITLE}
词1
词2`
    const parsed = parseDeslopRulesFromMd(md)
    expect(parsed.overrides.gateA).toBe('默认 A 正文')
    expect(Object.keys(parsed.overrides)).not.toContain('这是一个不存在的节标题')
    expect(parsed.bannedWords).toEqual(['词1', '词2'])
  })

  it('禁用词去空、去重', () => {
    const md = `## ${DESLOP_BANNED_WORDS_TITLE}
仿佛

缓缓
仿佛
  带空白  
`
    const parsed = parseDeslopRulesFromMd(md)
    expect(parsed.bannedWords).toEqual(['仿佛', '缓缓', '带空白'])
  })

  it('缺禁用词表节时 bannedWords 为空数组', () => {
    const md = `## 系统铁律（改写总则）
${DESLOP_SYSTEM_PROMPT}`
    const parsed = parseDeslopRulesFromMd(md)
    expect(parsed.bannedWords).toEqual([])
    expect(parsed.overrides.systemPrompt).toBe(DESLOP_SYSTEM_PROMPT)
  })

  it('节正文含 "## " 行内文本时不被误切（仅行首 ## 才切节）', () => {
    const bodyWithHashInLine = '正文里提到 ## 这个符号但不在行首'
    const md = `## Gate C：心理描写外化
${bodyWithHashInLine}
后续行`
    const parsed = parseDeslopRulesFromMd(md)
    expect(parsed.overrides.gateC).toBe(`${bodyWithHashInLine}\n后续行`)
  })
})

describe('resolveDeslopTextOverrides', () => {
  it('与默认相同的覆盖被剔除（不生效，回落内置）', () => {
    const resolved = resolveDeslopTextOverrides({
      gateA: GATE_METHODS.A, // 与默认相同 → 剔除
      gateB: '【自定义 B】'   // 与默认不同 → 保留
    })
    expect(resolved.gates.A).toBeUndefined()
    expect(resolved.gates.B).toBe('【自定义 B】')
    expect(resolved.systemPrompt).toBeUndefined()
  })

  it('systemPrompt 覆盖单独提取', () => {
    const resolved = resolveDeslopTextOverrides({
      systemPrompt: '【自定义系统铁律】'
    })
    expect(resolved.systemPrompt).toBe('【自定义系统铁律】')
    expect(Object.keys(resolved.gates)).toHaveLength(0)
  })

  it('空覆盖表返回空 gates，systemPrompt undefined', () => {
    const resolved = resolveDeslopTextOverrides({})
    expect(resolved.systemPrompt).toBeUndefined()
    expect(resolved.gates).toEqual({})
  })
})

describe('resolveDeslopBannedWords', () => {
  it('undefined 返回 undefined（表示未配置，下游用默认）', () => {
    expect(resolveDeslopBannedWords(undefined)).toBeUndefined()
  })

  it('空数组返回空数组（用户显式清空）', () => {
    expect(resolveDeslopBannedWords([])).toEqual([])
  })

  it('非空数组原样返回', () => {
    expect(resolveDeslopBannedWords(['仿佛', '缓缓'])).toEqual(['仿佛', '缓缓'])
  })
})

describe('buildDeslopRuleEditPrompt', () => {
  it('包含当前规则 MD 与用户指令', () => {
    const currentMd = serializeDeslopRulesToMd({}, FLATTENED_LEVEL1)
    const prompt = buildDeslopRuleEditPrompt(currentMd, '把 Gate B 改得更严格')
    expect(prompt).toContain('把 Gate B 改得更严格')
    expect(prompt).toContain(currentMd)
    // 强调保持 9 个二级标题
    expect(prompt).toContain('9')
    expect(prompt).toMatch(/二级标题/)
  })

  it('空指令时给出兜底说明（整体优化措辞）', () => {
    const prompt = buildDeslopRuleEditPrompt('## x\ny', '')
    expect(prompt).toMatch(/整体优化措辞/)
  })
})
