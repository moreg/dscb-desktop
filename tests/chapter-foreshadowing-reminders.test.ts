import { describe, expect, it } from 'vitest'
import { buildForeshadowingReminders } from '../src/renderer/src/foreshadowingReminders'
import type { DetailedOutlineItem, Foreshadowing } from '../src/shared/types'

const baseForeshadowing = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('buildForeshadowingReminders', () => {
  it('groups current chapter outline, pending, and collect reminders', () => {
    const outline: DetailedOutlineItem = {
      chapterNumber: 12,
      foreshadowings: ['窗外黑影', '旧钥匙']
    }
    const foreshadowings: Foreshadowing[] = [
      {
        ...baseForeshadowing,
        id: 'FB-001',
        content: '旧钥匙',
        status: 'pending'
      },
      {
        ...baseForeshadowing,
        id: 'FB-002',
        content: '铃声三响',
        status: 'planted',
        expectedCollect: 12
      },
      {
        ...baseForeshadowing,
        id: 'FB-003',
        content: '下卷才回收',
        status: 'planted',
        expectedCollect: 30
      }
    ]

    expect(buildForeshadowingReminders(12, outline, foreshadowings)).toEqual({
      outline: ['窗外黑影', '旧钥匙'],
      toPlant: ['旧钥匙'],
      toCollect: ['铃声三响']
    })
  })

  it('deduplicates blank and repeated reminders', () => {
    const outline: DetailedOutlineItem = {
      chapterNumber: 3,
      foreshadowings: ['  铜镜  ', '', '铜镜']
    }
    const foreshadowings: Foreshadowing[] = [
      {
        ...baseForeshadowing,
        id: 'FB-001',
        content: ' 铜镜 ',
        status: 'pending'
      }
    ]

    expect(buildForeshadowingReminders(3, outline, foreshadowings)).toEqual({
      outline: ['铜镜'],
      toPlant: ['铜镜'],
      toCollect: []
    })
  })
})
