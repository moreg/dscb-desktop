import { describe, it, expect, beforeEach } from 'vitest'
import {
  pushSyncHistory,
  popSyncHistory,
  peekSyncHistory,
  clearSyncHistoryForChapter,
  loadPendingSyncQueue,
  savePendingSyncQueue,
  upsertPendingSync,
  removePendingSync,
  findPendingForChapter,
  receiptHasUndoableWrites,
  makeSyncId,
  loadSyncHistory,
  saveSyncHistory,
  formatPendingSyncBootHint,
  shouldShowPendingBootHint,
  markPendingBootHintShown,
  summarizePendingQueue,
  countPendingSyncQueue,
  notifyPendingSyncQueueChanged,
  PENDING_SYNC_CHANGED_EVENT,
  type SyncHistoryEntry,
  type PendingSyncItem,
  type SyncUndoReceipt,
  type StorageLike
} from '../src/shared/post-write-sync-session'

function memStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    }
  }
}

const emptyReceipt = (): SyncUndoReceipt => ({
  extraction: {
    chapterNumber: 1,
    newCharacters: [],
    newLocations: [],
    newItems: [],
    newForeshadowings: [],
    newPlotPoints: [],
    characterStateChanges: [],
    collectedForeshadowings: []
  },
  memory: {
    applied: {
      characters: 0,
      locations: 0,
      items: 0,
      foreshadowings: 0,
      plotPoints: 1,
      stateChanges: 1,
      collected: 0
    },
    errors: [],
    appliedDiffs: [
      {
        kind: 'state',
        label: '林远',
        field: '伤势',
        oldValue: '无',
        newValue: '轻伤',
        applicable: true
      }
    ]
  },
  settings: { applied: 0, skipped: 0, errors: [], appliedDiffs: [] }
})

function hist(chapter: number, msg: string, projectId = 'p1'): SyncHistoryEntry {
  return {
    id: makeSyncId(),
    projectId,
    chapterNumber: chapter,
    at: Date.now(),
    message: msg,
    receipt: emptyReceipt()
  }
}

describe('sync history stack', () => {
  it('push/pop LIFO and cap max', () => {
    let stack: SyncHistoryEntry[] = []
    for (let i = 0; i < 5; i++) {
      stack = pushSyncHistory(stack, hist(1, `m${i}`), 3)
    }
    expect(stack).toHaveLength(3)
    expect(stack.map((s) => s.message)).toEqual(['m2', 'm3', 'm4'])

    const p1 = popSyncHistory(stack)
    expect(p1.popped?.message).toBe('m4')
    expect(p1.next).toHaveLength(2)
    expect(peekSyncHistory(p1.next)?.message).toBe('m3')

    const empty = popSyncHistory([])
    expect(empty.popped).toBeNull()
  })

  it('clearSyncHistoryForChapter keeps other chapters', () => {
    let stack = [hist(1, 'a'), hist(2, 'b'), hist(1, 'c')]
    stack = clearSyncHistoryForChapter(stack, 1)
    expect(stack.map((s) => s.message)).toEqual(['b'])
  })

  it('receiptHasUndoableWrites', () => {
    expect(receiptHasUndoableWrites(emptyReceipt())).toBe(true)
    const empty = emptyReceipt()
    empty.memory.applied.plotPoints = 0
    empty.memory.applied.stateChanges = 0
    empty.memory.appliedDiffs = []
    expect(receiptHasUndoableWrites(empty)).toBe(false)
  })
})

describe('pending sync queue', () => {
  let storage: StorageLike

  beforeEach(() => {
    storage = memStorage()
  })

  it('upsert replaces same project+chapter', () => {
    let q: PendingSyncItem[] = []
    q = upsertPendingSync(q, {
      id: 'a',
      projectId: 'p1',
      chapterNumber: 3,
      content: '旧正文',
      errors: ['e1'],
      at: 1,
      attempts: 1
    })
    q = upsertPendingSync(q, {
      id: 'b',
      projectId: 'p1',
      chapterNumber: 3,
      content: '新正文',
      errors: ['e2'],
      at: 2,
      attempts: 3
    })
    expect(q).toHaveLength(1)
    expect(q[0].content).toBe('新正文')
    expect(q[0].attempts).toBe(3)
  })

  it('persist and load roundtrip', () => {
    const item: PendingSyncItem = {
      id: 'x',
      projectId: 'p',
      chapterNumber: 2,
      content: '章节正文',
      errors: ['超时'],
      at: 99,
      attempts: 2
    }
    expect(savePendingSyncQueue(storage, [item])).toBe(true)
    const loaded = loadPendingSyncQueue(storage)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].content).toBe('章节正文')
    expect(loaded[0].errors).toEqual(['超时'])
  })

  it('remove by project+chapter and find', () => {
    let q = upsertPendingSync([], {
      id: '1',
      projectId: 'p',
      chapterNumber: 1,
      content: 'c1',
      errors: [],
      at: 1,
      attempts: 0
    })
    q = upsertPendingSync(q, {
      id: '2',
      projectId: 'p',
      chapterNumber: 2,
      content: 'c2',
      errors: [],
      at: 2,
      attempts: 0
    })
    expect(findPendingForChapter(q, 'p', 2)?.content).toBe('c2')
    q = removePendingSync(q, { projectId: 'p', chapterNumber: 2 })
    expect(findPendingForChapter(q, 'p', 2)).toBeNull()
    expect(q).toHaveLength(1)
  })

  it('ignores corrupt storage', () => {
    storage.setItem('ai-writer:pending-sync-queue', '{not json')
    expect(loadPendingSyncQueue(storage)).toEqual([])
  })

  it('summarizePendingQueue groups by project', () => {
    const q = [
      {
        id: '1',
        projectId: 'a',
        projectName: '书A',
        chapterNumber: 1,
        content: 'x',
        errors: [],
        at: 1,
        attempts: 0
      },
      {
        id: '2',
        projectId: 'a',
        chapterNumber: 2,
        content: 'y',
        errors: [],
        at: 2,
        attempts: 0
      },
      {
        id: '3',
        projectId: 'b',
        projectName: '书B',
        chapterNumber: 1,
        content: 'z',
        errors: [],
        at: 3,
        attempts: 0
      }
    ]
    const s = summarizePendingQueue(q)
    expect(s.total).toBe(3)
    expect(s.byProject.find((p) => p.projectId === 'a')?.count).toBe(2)
    expect(s.byProject.find((p) => p.projectId === 'a')?.projectName).toBe('书A')
  })
})

describe('sync history persistence', () => {
  it('roundtrip load/save per chapter', () => {
    const storage = memStorage()
    const stack = [hist(3, 'first'), hist(3, 'second')]
    expect(saveSyncHistory(storage, 'p1', 3, stack)).toBe(true)
    const loaded = loadSyncHistory(storage, 'p1', 3)
    expect(loaded).toHaveLength(2)
    expect(loaded[1].message).toBe('second')
    expect(loadSyncHistory(storage, 'p1', 1)).toEqual([])

    saveSyncHistory(storage, 'p1', 3, [])
    expect(loadSyncHistory(storage, 'p1', 3)).toEqual([])
  })
})

describe('boot hint', () => {
  it('formats and session-dedupes', () => {
    expect(formatPendingSyncBootHint(0)).toBeNull()
    expect(formatPendingSyncBootHint(2)).toMatch(/2 条/)
    const local = memStorage()
    const sess = memStorage()
    expect(shouldShowPendingBootHint(local, sess, 2)).toBe(true)
    markPendingBootHintShown(sess)
    expect(shouldShowPendingBootHint(local, sess, 2)).toBe(false)
  })
})

describe('queue count and notify', () => {
  it('countPendingSyncQueue', () => {
    const storage = memStorage()
    expect(countPendingSyncQueue(storage)).toBe(0)
    savePendingSyncQueue(storage, [
      {
        id: '1',
        projectId: 'p',
        chapterNumber: 1,
        content: 'c',
        errors: [],
        at: 1,
        attempts: 0
      }
    ])
    expect(countPendingSyncQueue(storage)).toBe(1)
  })

  it('savePendingSyncQueue notifies via CustomEvent when window exists', () => {
    const storage = memStorage()
    // vitest 默认 node 环境无 window；有则验证事件，无则只验证 notify 不抛
    const g = globalThis as { window?: Window & typeof globalThis }
    if (!g.window?.addEventListener) {
      expect(() => notifyPendingSyncQueueChanged(3)).not.toThrow()
      expect(savePendingSyncQueue(storage, [])).toBe(true)
      return
    }
    const counts: number[] = []
    const handler = (ev: Event) => {
      counts.push((ev as CustomEvent<{ count: number }>).detail.count)
    }
    g.window.addEventListener(PENDING_SYNC_CHANGED_EVENT, handler)
    try {
      savePendingSyncQueue(storage, [
        {
          id: '1',
          projectId: 'p',
          chapterNumber: 1,
          content: 'hello',
          errors: [],
          at: 1,
          attempts: 0
        }
      ])
      expect(counts.at(-1)).toBe(1)
      savePendingSyncQueue(storage, [])
      expect(counts.at(-1)).toBe(0)
    } finally {
      g.window.removeEventListener(PENDING_SYNC_CHANGED_EVENT, handler)
    }
  })
})
