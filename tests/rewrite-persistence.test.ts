import { describe, it, expect } from 'vitest'
import {
  buildStorageKey,
  serializeState,
  deserializeState,
  loadState,
  saveState,
  clearState,
  getLocalStorage,
  REWRITE_PERSISTENCE_VERSION,
  type PersistedRewriteState
} from '../src/main/data/rewrite-persistence'
import type { RewriteEntry } from '../src/main/data/rewrite-history'

/** 内存 mock：模拟 localStorage */
function makeMockStorage(): {
  getItem: ReturnType<typeof vi.fn>
  setItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
  data: Map<string, string>
} {
  // 用 vi.fn 包装手写实现（vitest 用来 mock 也可以，这里手写更直接）
  const data = new Map<string, string>()
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      data.set(k, v)
    }),
    removeItem: vi.fn((k: string) => {
      data.delete(k)
    })
  }
}

// 用 vitest 的 vi 全局
import { vi } from 'vitest'

describe('buildStorageKey', () => {
  it('includes version + projectId + chapterNumber', () => {
    expect(buildStorageKey('proj-1', 3)).toBe(
      `ai-writer:rewrite:v${REWRITE_PERSISTENCE_VERSION}:proj-1:3`
    )
  })

  it('different projects have different keys', () => {
    expect(buildStorageKey('A', 1)).not.toBe(buildStorageKey('B', 1))
  })

  it('different chapters have different keys', () => {
    expect(buildStorageKey('P', 1)).not.toBe(buildStorageKey('P', 2))
  })
})

describe('serializeState / deserializeState (roundtrip)', () => {
  it('roundtrips empty state', () => {
    const s: PersistedRewriteState = { version: REWRITE_PERSISTENCE_VERSION, history: [], redoStack: [] }
    const raw = serializeState(s)
    expect(deserializeState(raw)).toEqual(s)
  })

  it('roundtrips state with entries', () => {
    const s: PersistedRewriteState = {
      version: REWRITE_PERSISTENCE_VERSION,
      history: [
        { oldSnippet: '似乎', newText: '好像', at: 1000, violationKey: 'forbidden_word:似乎:42' },
        { oldSnippet: '心中一动', newText: '顿了顿', at: 2000 }
      ],
      redoStack: [{ oldSnippet: 'X', newText: 'Y', at: 3000 }]
    }
    const raw = serializeState(s)
    const restored = deserializeState(raw)
    expect(restored).toEqual(s)
  })

  it('serializeState produces valid JSON', () => {
    const s: PersistedRewriteState = { version: REWRITE_PERSISTENCE_VERSION, history: [], redoStack: [] }
    expect(() => JSON.parse(serializeState(s))).not.toThrow()
  })
})

describe('deserializeState (错误处理)', () => {
  it('null input → null', () => {
    expect(deserializeState(null)).toBe(null)
  })

  it('undefined input → null', () => {
    expect(deserializeState(undefined)).toBe(null)
  })

  it('empty string → null', () => {
    expect(deserializeState('')).toBe(null)
  })

  it('invalid JSON → null', () => {
    expect(deserializeState('not json {')).toBe(null)
  })

  it('non-object root → null', () => {
    expect(deserializeState('"a string"')).toBe(null)
    expect(deserializeState('42')).toBe(null)
    expect(deserializeState('null')).toBe(null)
  })

  it('version mismatch → null', () => {
    const raw = JSON.stringify({ version: 99, history: [], redoStack: [] })
    expect(deserializeState(raw)).toBe(null)
  })

  it('history not array → null', () => {
    const raw = JSON.stringify({ version: REWRITE_PERSISTENCE_VERSION, history: 'oops', redoStack: [] })
    expect(deserializeState(raw)).toBe(null)
  })

  it('redoStack not array → null', () => {
    const raw = JSON.stringify({ version: REWRITE_PERSISTENCE_VERSION, history: [], redoStack: null })
    expect(deserializeState(raw)).toBe(null)
  })

  it('entry missing required field → null', () => {
    // oldSnippet 有，但 newText / at 缺失
    const raw = JSON.stringify({
      version: REWRITE_PERSISTENCE_VERSION,
      history: [{ oldSnippet: 'x' }],
      redoStack: []
    })
    expect(deserializeState(raw)).toBe(null)
  })

  it('entry with wrong type → null', () => {
    const raw = JSON.stringify({
      version: REWRITE_PERSISTENCE_VERSION,
      history: [{ oldSnippet: 123, newText: 'y', at: 1000 }],
      redoStack: []
    })
    expect(deserializeState(raw)).toBe(null)
  })

  it('entry with non-string violationKey → null', () => {
    const raw = JSON.stringify({
      version: REWRITE_PERSISTENCE_VERSION,
      history: [{ oldSnippet: 'x', newText: 'y', at: 1000, violationKey: 42 }],
      redoStack: []
    })
    expect(deserializeState(raw)).toBe(null)
  })

  it('entry with undefined violationKey is OK (optional field)', () => {
    const raw = JSON.stringify({
      version: REWRITE_PERSISTENCE_VERSION,
      history: [{ oldSnippet: 'x', newText: 'y', at: 1000 }],
      redoStack: []
    })
    const restored = deserializeState(raw)
    expect(restored).not.toBe(null)
  })

  it('redoStack entry invalid → null (both arrays validated)', () => {
    const raw = JSON.stringify({
      version: REWRITE_PERSISTENCE_VERSION,
      history: [],
      redoStack: [{ oldSnippet: 'x', newText: 'y' /* missing at */ }]
    })
    expect(deserializeState(raw)).toBe(null)
  })
})

describe('saveState / loadState / clearState (with mock storage)', () => {
  it('saveState writes JSON to storage.getItem/equivalent', () => {
    const s = makeMockStorage()
    const state: PersistedRewriteState = {
      version: REWRITE_PERSISTENCE_VERSION,
      history: [{ oldSnippet: 'A', newText: 'a', at: 1000 }],
      redoStack: []
    }
    const ok = saveState(s, 'proj', 1, state)
    expect(ok).toBe(true)
    expect(s.setItem).toHaveBeenCalledTimes(1)
    const key = buildStorageKey('proj', 1)
    expect(s.data.get(key)).toBeDefined()
  })

  it('loadState reads back what was saved (roundtrip)', () => {
    const s = makeMockStorage()
    const state: PersistedRewriteState = {
      version: REWRITE_PERSISTENCE_VERSION,
      history: [{ oldSnippet: 'A', newText: 'a', at: 1000, violationKey: 'k1' }],
      redoStack: [{ oldSnippet: 'B', newText: 'b', at: 2000 }]
    }
    saveState(s, 'proj', 5, state)
    const restored = loadState(s, 'proj', 5)
    expect(restored).toEqual(state)
  })

  it('loadState on different chapter returns null', () => {
    const s = makeMockStorage()
    saveState(s, 'proj', 1, { version: 1, history: [], redoStack: [] })
    expect(loadState(s, 'proj', 2)).toBe(null)
  })

  it('loadState on different project returns null', () => {
    const s = makeMockStorage()
    saveState(s, 'A', 1, { version: 1, history: [], redoStack: [] })
    expect(loadState(s, 'B', 1)).toBe(null)
  })

  it('clearState removes the key', () => {
    const s = makeMockStorage()
    saveState(s, 'proj', 1, { version: 1, history: [], redoStack: [] })
    const key = buildStorageKey('proj', 1)
    expect(s.data.has(key)).toBe(true)
    clearState(s, 'proj', 1)
    expect(s.data.has(key)).toBe(false)
  })

  it('clearState on missing key is no-op (returns true)', () => {
    const s = makeMockStorage()
    expect(clearState(s, 'proj', 1)).toBe(true)
  })

  it('saveState with null storage returns false', () => {
    const state: PersistedRewriteState = { version: 1, history: [], redoStack: [] }
    expect(saveState(null, 'proj', 1, state)).toBe(false)
  })

  it('loadState with null storage returns null', () => {
    expect(loadState(null, 'proj', 1)).toBe(null)
  })

  it('clearState with null storage returns false', () => {
    expect(clearState(null, 'proj', 1)).toBe(false)
  })

  it('saveState catches storage.setItem throw (e.g. quota exceeded)', () => {
    const s = makeMockStorage()
    s.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError')
    })
    const state: PersistedRewriteState = { version: 1, history: [], redoStack: [] }
    expect(saveState(s, 'proj', 1, state)).toBe(false)
  })

  it('loadState catches storage.getItem throw', () => {
    const s = makeMockStorage()
    s.getItem = vi.fn(() => {
      throw new Error('SecurityError')
    })
    expect(loadState(s, 'proj', 1)).toBe(null)
  })

  it('clearState catches storage.removeItem throw', () => {
    const s = makeMockStorage()
    s.removeItem = vi.fn(() => {
      throw new Error('SecurityError')
    })
    expect(clearState(s, 'proj', 1)).toBe(false)
  })
})

describe('getLocalStorage (环境探测)', () => {
  it('returns null when window is undefined (SSR)', () => {
    // 临时隐藏 window
    const origWindow = (globalThis as { window?: Window }).window
    ;(globalThis as { window?: Window }).window = undefined as unknown as Window
    try {
      expect(getLocalStorage()).toBe(null)
    } finally {
      ;(globalThis as { window?: Window }).window = origWindow
    }
  })

  it('handles localStorage missing (older browsers)', () => {
    const origWindow = (globalThis as { window?: Window }).window
    ;(globalThis as { window?: Window }).window = {} as unknown as Window
    try {
      expect(getLocalStorage()).toBe(null)
    } finally {
      ;(globalThis as { window?: Window }).window = origWindow
    }
  })
})

describe('P9-A 集成场景: 模拟刷新页面', () => {
  it('保存 → 重新构造 storage → 加载 = 原始数据', () => {
    // 第 1 次会话：apply A → apply B → undo
    const s1 = makeMockStorage()
    const history1: RewriteEntry[] = [
      { oldSnippet: 'A', newText: 'a', at: 1000, violationKey: 'k1' },
      { oldSnippet: 'B', newText: 'b', at: 2000, violationKey: 'k2' }
    ]
    const redo1: RewriteEntry[] = [{ oldSnippet: 'B', newText: 'b', at: 2000, violationKey: 'k2' }]
    saveState(s1, 'P', 1, { version: 1, history: history1, redoStack: redo1 })

    // 第 2 次会话：模拟"刷新页面"——新的 storage 实例，相同的 localStorage 数据
    const s2 = makeMockStorage()
    for (const [k, v] of s1.data) s2.data.set(k, v)

    const restored = loadState(s2, 'P', 1)
    expect(restored).not.toBe(null)
    expect(restored!.history).toEqual(history1)
    expect(restored!.redoStack).toEqual(redo1)
  })

  it('切到别的章时，旧章的持久化数据应保持不动', () => {
    const s = makeMockStorage()
    saveState(s, 'P', 1, {
      version: 1,
      history: [{ oldSnippet: 'A', newText: 'a', at: 1000 }],
      redoStack: []
    })
    // "切到第 2 章"——只是载入不同的 key，不应清空第 1 章的数据
    const ch1Data = s.data.get(buildStorageKey('P', 1))
    expect(ch1Data).toBeDefined()
    // 第 2 章无数据 → loadState 返回 null
    expect(loadState(s, 'P', 2)).toBe(null)
    // 切回第 1 章 → 数据仍存在
    expect(loadState(s, 'P', 1)).not.toBe(null)
  })
})
