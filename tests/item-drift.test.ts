import { describe, expect, it } from 'vitest'
import { findItemMaterialDrift, renderItemDriftHints } from '../src/main/data/memory/item-drift'

describe('确定性道具材质漂移比对', () => {
  const drift = (content: string, knownItems = ['铜牌'], extra: Partial<Parameters<typeof findItemMaterialDrift>[0]> = {}) =>
    findItemMaterialDrift({ content, knownItems, ...extra })

  it('本章出现同头不同材质的词而已知道具缺席时给出提示', () => {
    expect(drift('他举起手中的木牌，示意众人安静。')).toEqual([{ known: '铜牌', token: '木牌', head: '牌' }])
  })

  it('已知道具仍在本章出现、候选本身是道具卡、或在前文/计划中有依据时均不提示', () => {
    expect(drift('铜牌与木牌并排挂在门边。')).toEqual([])
    expect(drift('他举起手中的木牌。', ['铜牌', '木牌'])).toEqual([])
    expect(drift('他举起手中的木牌。', ['铜牌'], { plan: '下一章交代木牌的来历。' })).toEqual([])
    expect(drift('他举起手中的木牌。', ['铜牌'], { priorText: '第3章提到过一块木牌。' })).toEqual([])
  })

  it('候选后随汉字视为更长词的一部分，不作为本章独立出现', () => {
    expect(drift('门口挂着的木牌匾歪了。')).toEqual([])
  })

  it('三字道具按末字中心词比对，四字以上专名不参与', () => {
    expect(drift('他抽出的却是一把铁剑。', ['玄铁剑', '传国玉玺'])).toEqual([{ known: '玄铁剑', token: '铁剑', head: '剑' }])
  })

  it('没有任何道具卡时，前文出现过的同类词自动作为比对基准', () => {
    expect(findItemMaterialDrift({ content: '他举起手中的木牌。', priorText: '他接过铜牌就收进了袖子。' }))
      .toEqual([{ known: '铜牌', token: '木牌', head: '牌' }])
  })

  it('本章同时出现历史词与候选词时视为并列新物件，不提示', () => {
    expect(findItemMaterialDrift({ content: '他把铜牌换成了一块木牌。', priorText: '铜牌是他娘留下的。' })).toEqual([])
  })

  it('候选词本身已在前文出现过属既定用词，不提示', () => {
    expect(findItemMaterialDrift({ content: '他心里盘算着金钱。', priorText: '他数着铜钱，也缺金钱。' })).toEqual([])
  })

  it('没有任何同头依据时不凭空怀疑新物件', () => {
    expect(findItemMaterialDrift({ content: '他举起手中的木牌。' })).toEqual([])
  })

  it('同头多个已知道具命中同一候选时只提示一次', () => {
    expect(drift('裁判举起手中的金牌。', ['铜牌', '银牌'])).toEqual([{ known: '铜牌', token: '金牌', head: '牌' }])
  })

  it('提示数量有上限', () => {
    const knownItems = ['铜牌', '铁盒', '木剑']
    const hints = findItemMaterialDrift({ content: '桌上摆着银牌、锡盒、金剑。', knownItems, limit: 2 })
    expect(hints.length).toBe(2)
  })

  it('提示文案包含双方名称并说明仅供核对', () => {
    const [text] = renderItemDriftHints([{ known: '铜牌', token: '木牌', head: '牌' }])
    expect(text).toContain('木牌')
    expect(text).toContain('铜牌')
    expect(text).toContain('不要写入 findings')
  })
})
