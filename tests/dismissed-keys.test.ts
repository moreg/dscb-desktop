import { describe, it, expect, beforeEach } from 'vitest'
import {
  addDismissedKey,
  addDismissedKeys,
  clearDismissedKeys,
  loadDismissedKeys,
  outlineDiffStableKey,
  removeDismissedKey,
  saveDismissedKeys
} from '../src/shared/dismissed-keys'

const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  // vitest/jsdom or node：补 localStorage stub
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v)
      },
      removeItem: (k: string) => {
        mem.delete(k)
      }
    }
  })
})

describe('dismissed-keys', () => {
  it('load/save roundtrip', () => {
    saveDismissedKeys('k1', new Set(['a', 'b']))
    expect([...loadDismissedKeys('k1')].sort()).toEqual(['a', 'b'])
  })

  it('add / remove / clear', () => {
    addDismissedKey('k2', 'x')
    addDismissedKeys('k2', ['y', 'z'])
    expect(loadDismissedKeys('k2').has('x')).toBe(true)
    expect(loadDismissedKeys('k2').size).toBe(3)
    removeDismissedKey('k2', 'y')
    expect(loadDismissedKeys('k2').has('y')).toBe(false)
    clearDismissedKeys('k2')
    expect(loadDismissedKeys('k2').size).toBe(0)
  })

  it('outlineDiffStableKey 对相同内容稳定、不依赖下标', () => {
    const d = {
      type: 2 as const,
      priority: 'P1' as const,
      outline: '  细纲 A  ',
      actual: '正文 A',
      suggestion: '改细纲'
    }
    expect(outlineDiffStableKey(d)).toBe(outlineDiffStableKey({ ...d, outline: '细纲 A' }))
    expect(outlineDiffStableKey(d)).not.toBe(
      outlineDiffStableKey({ ...d, actual: '正文 B' })
    )
  })
})
