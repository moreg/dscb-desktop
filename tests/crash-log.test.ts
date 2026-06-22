import { describe, it, expect } from 'vitest'
import {
  loadCrashLog,
  recordCrash,
  clearCrashLog,
  formatCrashLog,
  type StorageLike
} from '../src/renderer/src/crash-log'

function makeStorage(): {
  getItem: any
  setItem: any
  removeItem: any
  data: Map<string, string>
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k)
  }
}

const sample = (overrides: Partial<{ at: number; message: string; stack?: string }> = {}) => ({
  at: 1000,
  message: 'Something broke',
  stack: 'at file.ts:1:1',
  ...overrides
})

describe('recordCrash / loadCrashLog', () => {
  it('records a single entry', () => {
    const s = makeStorage()
    recordCrash(s, sample())
    const loaded = loadCrashLog(s)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].message).toBe('Something broke')
  })

  it('returns [] when no entries', () => {
    expect(loadCrashLog(makeStorage())).toEqual([])
  })

  it('returns [] for corrupted JSON', () => {
    const s = makeStorage()
    s.data.set('ai-writer:crash-log', 'not json {')
    expect(loadCrashLog(s)).toEqual([])
  })

  it('filters out malformed entries', () => {
    const s = makeStorage()
    s.data.set(
      'ai-writer:crash-log',
      JSON.stringify([
        sample(),
        { at: 2000 }, // missing message
        { message: 'x' }, // missing at
        { at: 'string', message: 'x' }, // wrong type at
        sample({ at: 3000, message: 'second' })
      ])
    )
    const loaded = loadCrashLog(s)
    expect(loaded).toHaveLength(2)
    expect(loaded.map((e) => e.message)).toEqual(['Something broke', 'second'])
  })

  it('caps at MAX_ENTRIES (50), dropping oldest', () => {
    const s = makeStorage()
    for (let i = 0; i < 55; i++) {
      recordCrash(s, sample({ at: 1000 + i, message: `e${i}` }))
    }
    const loaded = loadCrashLog(s)
    expect(loaded).toHaveLength(50)
    // 最旧的 5 条 (e0..e4) 应被丢弃
    expect(loaded[0].message).toBe('e5')
    expect(loaded[loaded.length - 1].message).toBe('e54')
  })

  it('preserves order (oldest first, newest last)', () => {
    const s = makeStorage()
    recordCrash(s, sample({ at: 1000, message: 'first' }))
    recordCrash(s, sample({ at: 2000, message: 'second' }))
    recordCrash(s, sample({ at: 3000, message: 'third' }))
    expect(loadCrashLog(s).map((e) => e.message)).toEqual(['first', 'second', 'third'])
  })

  it('works with null storage (silent failure)', () => {
    // 不应抛错
    expect(() => recordCrash(null, sample())).not.toThrow()
    expect(loadCrashLog(null)).toEqual([])
  })

  it('preserves componentStack', () => {
    const s = makeStorage()
    recordCrash(s, {
      at: 1000,
      message: 'x',
      componentStack: '\n  at Foo\n  at Bar'
    })
    expect(loadCrashLog(s)[0].componentStack).toContain('Foo')
  })
})

describe('clearCrashLog', () => {
  it('removes all entries', () => {
    const s = makeStorage()
    recordCrash(s, sample())
    recordCrash(s, sample({ at: 2000, message: 'b' }))
    expect(loadCrashLog(s)).toHaveLength(2)
    clearCrashLog(s)
    expect(loadCrashLog(s)).toEqual([])
  })

  it('works with null storage', () => {
    expect(() => clearCrashLog(null)).not.toThrow()
  })
})

describe('formatCrashLog', () => {
  it('empty → placeholder', () => {
    expect(formatCrashLog([])).toBe('（无崩溃记录）')
  })

  it('formats single entry with timestamp', () => {
    const text = formatCrashLog([{ at: 1700000000000, message: 'oops' }])
    expect(text).toContain('oops')
    expect(text).toContain('#1')
    // ISO timestamp appears
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('includes stack when present', () => {
    const text = formatCrashLog([{ at: 1000, message: 'oops', stack: 'at foo.ts:1:1' }])
    expect(text).toContain('at foo.ts:1:1')
  })

  it('separates multiple entries with ---', () => {
    const text = formatCrashLog([
      { at: 1000, message: 'a' },
      { at: 2000, message: 'b' }
    ])
    expect(text).toContain('---')
    expect(text).toContain('a')
    expect(text).toContain('b')
  })
})

describe('P19-F 集成: 完整崩溃流', () => {
  it('typical flow: 渲染错 → 记录 → 格式化 → 导出', () => {
    const s = makeStorage()
    // 模拟 3 次崩溃
    recordCrash(s, {
      at: Date.parse('2026-06-22T10:00:00Z'),
      message: 'Cannot read properties of undefined',
      stack: 'TypeError: ...\n  at ChapterEditor.tsx:123',
      componentStack: '\n  at ChapterEditor\n  at div'
    })
    recordCrash(s, {
      at: Date.parse('2026-06-22T11:00:00Z'),
      message: 'Network request failed',
      stack: 'Error: ...\n  at fetch'
    })

    // 用户点"导出错误日志"→ formatCrashLog 拿全文复制给开发者
    const exported = formatCrashLog(loadCrashLog(s))
    expect(exported).toContain('Cannot read properties')
    expect(exported).toContain('Network request failed')
    expect(exported).toContain('ChapterEditor')
    expect(exported).toContain('fetch')
  })
})
