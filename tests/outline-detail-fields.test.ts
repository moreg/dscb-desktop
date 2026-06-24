import { describe, expect, it } from 'vitest'
import { getOutlineDetailRows } from '../src/renderer/src/outlineDetailFields'
import type { DetailedOutlineItem } from '../src/shared/types'

describe('getOutlineDetailRows', () => {
  it('keeps detailed outline fields close to the source markdown structure', () => {
    const item: DetailedOutlineItem = {
      chapterNumber: 1,
      title: '困兽',
      emotion: 5,
      climax: 1,
      plotSummary: '孢子灾害初现，校园陷入混乱',
      coolPoint: '苏铭用《大学体育教程》砸退变异野猫',
      charactersAppearing: ['苏铭（首次正式登场）', '图书馆管理员老周'],
      foreshadowings: ['窗外天空突然变绿', '广播断断续续的紧急通知'],
      hook: '远处传来女生的尖叫',
      wordEstimate: '约 2500 字',
      writingRequirements: '开头强情绪\n结尾必须留钩子'
    }

    expect(getOutlineDetailRows(item)).toEqual([
      { label: '节奏标注', items: ['情绪值：5', '爽点类型：1（小打脸）'] },
      { label: '核心事件', value: '孢子灾害初现，校园陷入混乱' },
      { label: '爽点/打脸', value: '苏铭用《大学体育教程》砸退变异野猫' },
      { label: '角色出场', items: ['苏铭（首次正式登场）', '图书馆管理员老周'] },
      { label: '伏笔铺设', items: ['窗外天空突然变绿', '广播断断续续的紧急通知'] },
      { label: '章末钩子', value: '远处传来女生的尖叫' },
      { label: '字数预估', value: '约 2500 字' },
      { label: '本章写作要求', value: '开头强情绪\n结尾必须留钩子' }
    ])
  })
})
