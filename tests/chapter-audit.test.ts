import { describe, it, expect } from 'vitest'
import { auditChapter, violationKey, pruneHumanizeMap } from '../src/main/data/chapter-audit'
import { flattenForbiddenPatterns, FORBIDDEN_WORD_CATEGORIES } from '../src/main/data/skill-prompts/forbidden-words'

/** 拼一段合法的"中段+对话/事件结尾"正文（基线） */
function makeValidContent(ending = '"我不会让你——"她头也不回地冲了出去'): string {
  return `林远握紧手中的剑，一言不发。\n\n` +
    `屋里没人说话。\n\n` +
    `他盯着门外，脚步声渐近。\n\n` +
    ending
}

describe('chapter-audit (PR2 baseline)', () => {
  it('passes for valid content with dialogue ending', () => {
    const report = auditChapter(makeValidContent())
    const errors = report.violations.filter((v) => v.severity === 'error')
    expect(errors).toEqual([])
    expect(report.passed.ending).toBe(true)
  })

  it('flags chapter ending with AI-style preach', () => {
    const content = makeValidContent('故事才刚刚开始，未来可期。')
    const report = auditChapter(content)
    const endingErr = report.violations.find(
      (v) => v.category === 'ending' && v.severity === 'error'
    )
    expect(endingErr).toBeDefined()
    expect(endingErr?.offset).toBeGreaterThanOrEqual(0)
  })

  it('flags missing dialogue and event keywords at ending', () => {
    const content = makeValidContent('他躺下，睡着了，梦里什么都没有。')
    const report = auditChapter(content)
    const err = report.violations.find((v) => v.category === 'ending' && v.severity === 'error')
    expect(err?.message).toContain('章末未发现')
  })

  it('flags forbidden word "似乎"', () => {
    const content = makeValidContent() + '\n\n他似乎想起了什么。'
    const report = auditChapter(content)
    const hit = report.violations.find((v) => v.category === 'forbidden_word' && v.word === '似乎')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
    expect(hit?.offset).toBeGreaterThanOrEqual(0)
  })

  it('flags word_count below minWords', () => {
    const report = auditChapter('太短了。')
    const wc = report.violations.find((v) => v.category === 'word_count')
    expect(wc).toBeDefined()
    expect(wc?.severity).toBe('warn')
  })
})

describe('chapter-audit (zh-humanizer rules 1-16)', () => {
  it('rule 7: flags "不仅…而且…" negative conjunction', () => {
    const content = makeValidContent() + '\n\n他不仅剑术高强，而且内功深厚。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-7-neg-conjunction'
    )
    expect(hit).toBeDefined()
  })

  it('rule 7: flags "不是…而是…" negative conjunction', () => {
    const content = makeValidContent() + '\n\n他不是退缩，而是观望。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-7-not-but'
    )
    expect(hit).toBeDefined()
  })

  it('rule 10: flags dash abuse (double em-dash)', () => {
    const content = makeValidContent() + '\n\n他开口——声音很大——在屋里回响。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-10-dash-abuse'
    )
    expect(hit).toBeDefined()
  })

  it('rule 12: flags emoji in body', () => {
    const content = makeValidContent() + '\n\n他笑了一下 😀。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-12-emoji'
    )
    expect(hit).toBeDefined()
  })

  it('rule 13: flags chat residual "好问题"', () => {
    const content = makeValidContent() + '\n\n好问题，我们继续。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-13-chat-residual'
    )
    expect(hit).toBeDefined()
  })

  it('rule 14: flags over-flattery', () => {
    const content = makeValidContent() + '\n\n你说得太对了，我完全同意。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-14-over-flattery'
    )
    expect(hit).toBeDefined()
  })

  it('rule 15: flags filler phrase (info severity)', () => {
    const content = makeValidContent() + '\n\n事实上，他确实来了。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-15-filler-phrase'
    )
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('info')
  })

  it('rule 16: flags hollow ending "未来可期"', () => {
    const content = makeValidContent() + '\n\n他的路还很长，未来可期。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-16-hollow-ending'
    )
    expect(hit).toBeDefined()
  })

  it('rule 4: flags ad copy "卓越/顶级"', () => {
    const content = makeValidContent() + '\n\n他的剑术卓越，无人能敌。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-4-ad-copy'
    )
    expect(hit).toBeDefined()
  })

  it('rule 6: flags three-part enumeration', () => {
    const content = makeValidContent() + '\n\n他看了一眼，又看一眼。'
    // 三段式需要 X、X、X 模式
    const content2 = makeValidContent() + '\n\n厅里摆设整齐、装饰华丽、灯火通明。'
    const report = auditChapter(content2)
    const hit = report.violations.find(
      (v) => v.category === 'rule' && v.ruleId === 'rule-6-three-part'
    )
    expect(hit).toBeDefined()
  })
})

describe('chapter-audit (genre-aware exceptions)', () => {
  it('urban genre: "渐渐" is warn', () => {
    const content = makeValidContent() + '\n\n天渐渐暗下来。'
    const report = auditChapter(content, { genre: '现代都市' })
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '渐渐'
    )
    expect(hit?.severity).toBe('warn')
  })

  it('xianxia genre: "渐渐" is info (genre-allowed)', () => {
    const content = makeValidContent() + '\n\n天渐渐暗下来。'
    const report = auditChapter(content, { genre: '古风仙侠' })
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '渐渐'
    )
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('info')
  })

  it('xianxia genre: "此刻" is info (genre-allowed)', () => {
    const content = makeValidContent() + '\n\n此刻，他拔剑出鞘。'
    const report = auditChapter(content, { genre: '古风' })
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '此刻'
    )
    expect(hit?.severity).toBe('info')
  })

  it('urban genre: "似乎" is warn (not genre-allowed)', () => {
    const content = makeValidContent() + '\n\n他似乎听到了什么。'
    const report = auditChapter(content, { genre: '现代都市' })
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '似乎'
    )
    expect(hit?.severity).toBe('warn')
  })

  it('provides genre-specific replacement suggestion', () => {
    const content = makeValidContent() + '\n\n她嘴角带了点弧度。'
    const report = auditChapter(content, { genre: '现代都市' })
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '嘴角带了点弧度'
    )
    // 命中"嘴角_上扬变体"模式后，suggestion 查 urban 表
    const cornerHit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.wordCategory === '表情动作模板'
    )
    expect(cornerHit?.suggestion).toBeDefined()
    expect(cornerHit?.suggestion).toMatch(/都市|现代|笑了一下/)
  })
})

describe('chapter-audit (嘴角+弧度 底层模式)', () => {
  it('catches 嘴角带了点弧度', () => {
    const content = makeValidContent() + '\n\n她嘴角带了点弧度。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '嘴角_弧度_底层模式'
    )
    expect(hit).toBeDefined()
    expect(hit?.message).toContain('底层模式')
  })

  it('catches 嘴角微微上扬', () => {
    const content = makeValidContent() + '\n\n他嘴角微微上扬。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '嘴角_上扬变体'
    )
    expect(hit).toBeDefined()
  })

  it('catches 嘴角弯了弯', () => {
    const content = makeValidContent() + '\n\n他嘴角弯了弯。'
    const report = auditChapter(content)
    const hit = report.violations.find(
      (v) => v.category === 'forbidden_word' && v.word === '嘴角_上扬变体'
    )
    expect(hit).toBeDefined()
  })

  it('does not false-positive on 嘴角 干裂 (no 弧度)', () => {
    const content = makeValidContent() + '\n\n他嘴角干裂，渗出血丝。'
    const report = auditChapter(content)
    const hits = report.violations.filter(
      (v) => v.category === 'forbidden_word' && v.wordCategory === '表情动作模板'
    )
    // 不应命中 嘴角+弧度 模式
    const falsePositive = hits.find((h) => h.word?.includes('弧度'))
    expect(falsePositive).toBeUndefined()
  })
})

describe('chapter-audit (forbidden-words catalog integrity)', () => {
  it('every category has at least 1 word', () => {
    for (const cat of FORBIDDEN_WORD_CATEGORIES) {
      expect(cat.words.length).toBeGreaterThan(0)
    }
  })

  it('all forbidden words are non-empty', () => {
    for (const cat of FORBIDDEN_WORD_CATEGORIES) {
      for (const w of cat.words) {
        expect(w.length).toBeGreaterThan(0)
      }
    }
  })

  it('all patterns are valid regexes', () => {
    for (const p of flattenForbiddenPatterns()) {
      expect(() => p.pattern.test('test')).not.toThrow()
    }
  })

  it('all categories have name + hint', () => {
    for (const cat of FORBIDDEN_WORD_CATEGORIES) {
      expect(cat.name.length).toBeGreaterThan(0)
      expect(cat.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('violationKey (P5-C 稳定键)', () => {
  it('同 category + 同 word + 同 offset 生成同 key', () => {
    const a = {
      category: 'forbidden_word' as const,
      severity: 'warn' as const,
      message: 'x',
      word: '似乎',
      offset: 42
    }
    const b = {
      category: 'forbidden_word' as const,
      severity: 'error' as const, // severity 不影响 key
      message: 'x',
      word: '似乎',
      offset: 42
    }
    expect(violationKey(a)).toBe(violationKey(b))
  })

  it('offset 不同 → key 不同', () => {
    const a = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '似乎', offset: 42 }
    const b = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '似乎', offset: 100 }
    expect(violationKey(a)).not.toBe(violationKey(b))
  })

  it('word 不同 → key 不同', () => {
    const a = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '似乎', offset: 42 }
    const b = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '仿佛', offset: 42 }
    expect(violationKey(a)).not.toBe(violationKey(b))
  })

  it('category 不同 → key 不同', () => {
    const a = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: 'X', offset: 0 }
    const b = { category: 'rule' as const, severity: 'warn' as const, message: '', word: 'X', offset: 0 }
    expect(violationKey(a)).not.toBe(violationKey(b))
  })

  it('offset 为 undefined 时回退到 ruleId', () => {
    const a = { category: 'rule' as const, severity: 'warn' as const, message: '', ruleId: 'rule-10-dash-abuse' }
    const b = { category: 'rule' as const, severity: 'warn' as const, message: '', ruleId: 'rule-12-emoji' }
    expect(violationKey(a)).not.toBe(violationKey(b))
  })

  it('offset 为 undefined + word 为空 + 无 ruleId 时兜底为 "general"', () => {
    const a = { category: 'ending' as const, severity: 'error' as const, message: 'x' }
    expect(violationKey(a)).toContain('ending:general:')
  })

  it('key 在 re-audit 间稳定（不依赖列表位置）', () => {
    const v = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '似乎', offset: 42 }
    // 同一违例在不同的报告里（index 不同），key 必须相同
    const k1 = violationKey(v)
    const k2 = violationKey(v)
    expect(k1).toBe(k2)
  })
})

describe('pruneHumanizeMap (P5-C 选择性清理)', () => {
  const v1 = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '似乎', offset: 10 }
  const v2 = { category: 'forbidden_word' as const, severity: 'warn' as const, message: '', word: '仿佛', offset: 50 }
  const v3 = { category: 'rule' as const, severity: 'warn' as const, message: '', word: '格外', offset: 100 }

  it('新报告里所有违例都在 → 保留全部', () => {
    const oldMap = {
      [violationKey(v1)]: { result: 'r1' },
      [violationKey(v2)]: { result: 'r2' }
    }
    const next = pruneHumanizeMap([v1, v2], oldMap)
    expect(Object.keys(next)).toHaveLength(2)
  })

  it('新报告只含部分违例 → 只保留对应的', () => {
    const oldMap = {
      [violationKey(v1)]: { result: 'r1' },
      [violationKey(v2)]: { result: 'r2' },
      [violationKey(v3)]: { result: 'r3' }
    }
    const next = pruneHumanizeMap([v1, v3], oldMap)
    expect(Object.keys(next).sort()).toEqual([violationKey(v1), violationKey(v3)].sort())
  })

  it('新报告不含任何旧违例 → 清空', () => {
    const oldMap = {
      [violationKey(v1)]: { result: 'r1' },
      [violationKey(v2)]: { result: 'r2' }
    }
    const next = pruneHumanizeMap([], oldMap)
    expect(next).toEqual({})
  })

  it('新报告含旧报告没有的违例 → 旧 key 全部丢弃', () => {
    const oldMap = { [violationKey(v1)]: { result: 'r1' } }
    const newV = { category: 'rule' as const, severity: 'warn' as const, message: '', word: 'X', offset: 999 }
    const next = pruneHumanizeMap([newV], oldMap)
    expect(next).toEqual({})
  })

  it('不影响空 map', () => {
    const next = pruneHumanizeMap([v1, v2], {})
    expect(next).toEqual({})
  })

  it('保持值不变（不深拷贝）', () => {
    const result = { result: 'r1' }
    const oldMap = { [violationKey(v1)]: result }
    const next = pruneHumanizeMap([v1], oldMap)
    expect(next[violationKey(v1)]).toBe(result)
  })
})
