import { describe, expect, it } from 'vitest'
import type { Character } from '../src/shared/types'
import {
  buildCharacterAliasGroups,
  expandCharacterAliasTerms,
  projectCharactersForChapter
} from '../src/main/data/memory/character-memory-context'

function character(name: string, patch: Partial<Character> = {}): Character {
  return { id: name, name, createdAt: '', updatedAt: '', ...patch }
}

describe('historical character context', () => {
  it('removes undated later personality, role, tags and duplicate raw fields from old-chapter cards', () => {
    const current = character('沈青', {
      personality: '弑师后冷酷多疑', role: '最终反派', identity: '北境女帝', abilities: '已突破大宗师',
      tags: ['黑化'], synopsis: '控制天下', customFields: { 显性性格: '冷酷多疑' }, rawFields: { 角色定位: '最终反派' }
    })
    const result = projectCharactersForChapter([current], 10, [], true)[0]
    expect(result).toMatchObject({ name: '沈青', personality: undefined, role: undefined, identity: undefined,
      abilities: undefined, synopsis: undefined, tags: undefined, customFields: undefined, rawFields: undefined })
    expect(current.personality).toBe('弑师后冷酷多疑')
    expect(current.customFields).toEqual({ 显性性格: '冷酷多疑' })
  })

  it('restores only the most recent identity snapshot strictly before the chapter being written', () => {
    const result = projectCharactersForChapter([character('沈青')], 10, [
      { name: '沈青', updateChapter: 0, personality: '开朗', role: '主角同伴', identity: '村民' },
      { name: '沈青', updateChapter: 5, personality: '谨慎但仍愿信任师父', role: '同伴', identity: '外门弟子' },
      { name: '沈青', updateChapter: 10, personality: '弑师后冷酷', role: '反派', identity: '掌门' },
      { name: '沈青', updateChapter: 30, personality: '无情', role: '最终反派', identity: '女帝' }
    ], true)[0]
    expect(result).toMatchObject({ personality: '谨慎但仍愿信任师父', role: '同伴', identity: '外门弟子' })
  })

  it('keeps unknown history unknown and retains the latest card for forward writing', () => {
    const cards = [character('沈青', { role: '主角同伴', personality: '开朗' })]
    expect(projectCharactersForChapter(cards, 11, [], false)).toBe(cards)
    const old = projectCharactersForChapter(cards, 5, [{ name: '沈青', updateChapter: 3, role: '-', personality: '未知' }], true)
    expect(old[0].role).toBeUndefined()
    expect(old[0].personality).toBeUndefined()
    const undated = projectCharactersForChapter(cards, 5, [{ name: '沈青', updateChapter: 0, role: '最终反派', personality: '后期黑化' }], true)
    expect(undated[0].role).toBeUndefined()
    expect(undated[0].personality).toBeUndefined()
  })
})

describe('explicit character aliases', () => {
  it('reads only explicit alias fields, preserving names without inventing identity links', () => {
    const groups = buildCharacterAliasGroups([character('林远', {
      customFields: { 别名: '小林、青衣客；“阿远”', 曾用名: ['林小七'], 身份: '玄门掌门', 状态轨迹: '已成为青帝',
        化名: '青帝（第20章起）', aliases: ['Lin Yuan'], 外号: '未知' },
      synopsis: '他就是青帝', tags: ['白发剑客']
    })], 10)
    expect(groups).toEqual([{ name: '林远', aliases: ['小林', '青衣客', '阿远', '林小七', 'Lin Yuan'] }])
    expect(expandCharacterAliasTerms(['青衣客'], '', groups)).toEqual(['林远', '小林', '青衣客', '阿远', '林小七', 'Lin Yuan'])
    expect(expandCharacterAliasTerms([], '青衣客在桥边等人。', groups)).toContain('林远')
    expect(expandCharacterAliasTerms(['玄门掌门'], '', groups)).toEqual([])
  })

  it('rejects common labels shared by multiple characters or equal to another canonical name', () => {
    const groups = buildCharacterAliasGroups([
      character('张三', { customFields: { 别名: '老张、张四、青衣客' } }),
      character('张四', { customFields: { 别名: '老张、阿四' } })
    ], 100)
    expect(groups).toEqual([{ name: '张三', aliases: ['青衣客'] }, { name: '张四', aliases: ['阿四'] }])
    expect(expandCharacterAliasTerms(['老张'], '', groups)).toEqual([])
    expect(expandCharacterAliasTerms(['张四'], '', groups)).toEqual(['张四', '阿四'])
  })

  it('filters dates before old-chapter retrieval, without accepting prose or conditional aliases', () => {
    const cards = [character('林远', { customFields: {
      别名: ['青衣客（第3章起）', '青帝（第10章揭晓）', '无名剑客', '又称阿远', '青衣客（后来才使用）']
    } })]
    expect(buildCharacterAliasGroups(cards, 10, { excludeUndated: true }))
      .toEqual([{ name: '林远', aliases: ['青衣客'] }])
    expect(buildCharacterAliasGroups(cards, 11)[0].aliases).toEqual(['青衣客', '青帝', '无名剑客'])
  })

  it('uses Latin word boundaries so Ann does not identify Joanna', () => {
    const groups = buildCharacterAliasGroups([character('安妮', { customFields: { aliases: 'Ann' } })], 20)
    expect(expandCharacterAliasTerms([], 'Joanna walked away.', groups)).toEqual([])
    expect(expandCharacterAliasTerms([], 'Ann walked away.', groups)).toEqual(['安妮', 'Ann'])
  })
})
