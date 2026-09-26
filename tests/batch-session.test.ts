import { describe, expect, it } from 'vitest'
import {
  parseSavedBatchSession,
  recoverBatchProgress,
  type SavedBatchSession
} from '../src/renderer/src/ChapterListPage'

function session(): SavedBatchSession {
  return {
    progress: recoverBatchProgress(10, 19, [10, 11], '通信中断', 11),
    autoContinue: true,
    autoStrength: false,
    styleProfileId: 'style-a'
  }
}

describe('批量任务断线恢复', () => {
  it('异常未返回 progress 时保留整批进度，从首个未保存章重试', () => {
    expect(recoverBatchProgress(10, 19, [11, 10, 11], '断线')).toMatchObject({
      fromChapter: 10, toChapter: 19, total: 10, currentChapter: 12,
      current: 2, completed: [10, 11], status: 'failed', error: '断线'
    })
  })

  it('正文已存但未获最终状态时，补跑检查而不跳章或重写正文', () => {
    expect(recoverBatchProgress(10, 19, [10, 11], '断线', 11)).toMatchObject({
      currentChapter: 11, status: 'paused', pendingPostProcessChapter: 11, completed: [10, 11]
    })
  })

  it('最后章已存仍缺最终状态时保留检查入口，不直接宣告完成', () => {
    expect(recoverBatchProgress(10, 11, [10, 11], '断线')).toMatchObject({
      currentChapter: 11, pendingPostProcessChapter: 11, status: 'paused'
    })
  })
})

describe('批量任务保存与恢复校验', () => {
  it('恢复同一批范围、已保存章节、待检查章与作者所选配置', () => {
    const saved = session()
    expect(parseSavedBatchSession(JSON.stringify(saved))).toEqual(saved)
  })

  it('保留上次可能正在落盘的章，供重开时读取磁盘核对', () => {
    const saved = { ...session(), interruptedChapter: 12 }
    expect(parseSavedBatchSession(JSON.stringify(saved))?.interruptedChapter).toBe(12)
  })

  it('完成后的旧任务不会再次成为续写任务', () => {
    const saved = session()
    saved.progress.status = 'completed'
    expect(parseSavedBatchSession(JSON.stringify(saved))).toBeNull()
  })

  it('拒绝损坏 JSON、超限区间以及章号和计数不一致的恢复记录', () => {
    expect(parseSavedBatchSession('{')).toBeNull()
    expect(parseSavedBatchSession('null')).toBeNull()
    expect(parseSavedBatchSession(null)).toBeNull()
    for (const patch of [
      { toChapter: 1000 },
      { currentChapter: 5 },
      { current: 9 },
      { completed: [10, 20] },
      { pendingPostProcessChapter: 12 },
      { total: 99 }
    ]) {
      const saved = session()
      Object.assign(saved.progress, patch)
      expect(parseSavedBatchSession(JSON.stringify(saved))).toBeNull()
    }
  })

  it('拒绝越界的磁盘恢复章，防止认领批次范围之外的正文', () => {
    expect(parseSavedBatchSession(JSON.stringify({ ...session(), interruptedChapter: 100 })))
      .toBeNull()
  })
})
