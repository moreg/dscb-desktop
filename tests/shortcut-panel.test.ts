import { describe, it, expect } from 'vitest'
import { SHORTCUTS, isMac, type ShortcutDef } from '../src/renderer/src/shortcut-defs'

describe('SHORTCUTS catalog', () => {
  it('has at least 1 shortcut', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0)
  })

  it('every shortcut has required fields', () => {
    for (const s of SHORTCUTS) {
      expect(s.keysMac).toBeTruthy()
      expect(s.keysWin).toBeTruthy()
      expect(s.desc).toBeTruthy()
      expect(s.group).toBeTruthy()
    }
  })

  it('includes Ctrl+Z undo + Ctrl+Shift+Z redo', () => {
    const undo = SHORTCUTS.find((s: ShortcutDef) => /Z/.test(s.keysWin) && !s.keysWin.includes('Shift'))
    const redo = SHORTCUTS.find((s: ShortcutDef) => /Shift.*Z|Z.*Shift/.test(s.keysWin))
    expect(undo?.desc).toContain('撤销')
    expect(redo?.desc).toContain('重做')
  })

  it('includes Cmd+/ shortcut panel toggle', () => {
    const panel = SHORTCUTS.find((s: ShortcutDef) => /\//.test(s.keysWin))
    expect(panel?.desc).toContain('快捷键')
  })

  it('all groups are valid', () => {
    const valid = ['写作', '质检 / 改写', '撤销 / 重做', '保存 / 打开', '导航']
    for (const s of SHORTCUTS) {
      expect(valid).toContain(s.group)
    }
  })
})

describe('isMac', () => {
  it('default test environment is not Mac', () => {
    expect(isMac()).toBe(false)
  })
})

describe('P19-C 集成: 快捷键面板 UI', () => {
  it('Cmd+/ 和 Ctrl+/ 都映射到同一个动作（同一行 SHORTCUTS）', () => {
    const panel = SHORTCUTS.find((s: ShortcutDef) => /\//.test(s.keysMac) && /\//.test(s.keysWin))
    expect(panel).toBeDefined()
    expect(panel?.keysMac).toContain('⌘')
    expect(panel?.keysWin).toContain('Ctrl')
  })

  it('撤销 + 重做 在同一 group（用户能找到）', () => {
    const undo = SHORTCUTS.find((s: ShortcutDef) => /撤销/.test(s.desc) && /Z/.test(s.keysWin))
    const redo = SHORTCUTS.find((s: ShortcutDef) => /重做/.test(s.desc) && /Z/.test(s.keysWin))
    expect(undo?.group).toBe('撤销 / 重做')
    expect(redo?.group).toBe('撤销 / 重做')
  })
})
