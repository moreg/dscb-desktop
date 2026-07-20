/**
 * 快捷键元数据（纯函数，可在 node tsc / vitest 测试）。
 * UI 组件见 ShortcutPanel.tsx。
 */

export interface ShortcutDef {
  keysMac: string
  keysWin: string
  desc: string
  group: '写作' | '质检 / 改写' | '撤销 / 重做' | '保存 / 打开' | '导航'
}

/** 当前注册的所有快捷键（单一真相源） */
export const SHORTCUTS: ShortcutDef[] = [
  // 写作
  { keysMac: '⌘ + S', keysWin: 'Ctrl + S', desc: '保存当前章节', group: '保存 / 打开' },
  { keysMac: '⌘ + /', keysWin: 'Ctrl + /', desc: '显示/隐藏本快捷键面板', group: '导航' },
  { keysMac: '⌘ + Shift + A', keysWin: 'Ctrl + Shift + A', desc: '重新跑 AI 味检查', group: '质检 / 改写' },
  // 撤销
  { keysMac: '⌘ + Z', keysWin: 'Ctrl + Z', desc: '撤销最近一次改写 / 按要求重写', group: '撤销 / 重做' },
  { keysMac: '⌘ + Shift + Z', keysWin: 'Ctrl + Shift + Z', desc: '重做', group: '撤销 / 重做' },
  { keysMac: '⌘ + Y', keysWin: 'Ctrl + Y', desc: '重做（Windows 风格）', group: '撤销 / 重做' }
]

/**
 * 把快捷键的 keysMac/keysWin 合并为"在当前平台用哪个"的字符串。
 * SSR-safe：typeof navigator !== 'undefined' 时用 navigator.platform。
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform
  return /Mac|iPod|iPhone|iPad/.test(platform)
}
