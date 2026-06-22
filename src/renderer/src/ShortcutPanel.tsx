import { useEffect, useState, useMemo } from 'react'
import { SHORTCUTS, isMac, type ShortcutDef } from './shortcut-defs'

/**
 * P19-C：全局快捷键面板（Cmd+/ 或 Ctrl+/）
 *
 * 列出当前页面所有可用的快捷键，按类别分组。
 * 纯组件：只读 store（不持有副作用），由父组件 useEffect 监听 Cmd+/ 切换 open。
 */
export type { ShortcutDef }
export { SHORTCUTS, isMac } from './shortcut-defs'

/** 监听 Cmd+/ 或 Ctrl+/ 切换面板 */
export function useShortcutPanelToggle(): {
  open: boolean
  show: () => void
  hide: () => void
  toggle: () => void
} {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd+/ (Mac) 或 Ctrl+/ (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape' && open) {
        // Esc 关闭
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return {
    open,
    show: () => setOpen(true),
    hide: () => setOpen(false),
    toggle: () => setOpen((o) => !o)
  }
}

/** 快捷键面板 UI */
export default function ShortcutPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mac = useMemo(isMac, [])
  const groups = useMemo(() => {
    const m = new Map<string, ShortcutDef[]>()
    for (const s of SHORTCUTS) {
      const arr = m.get(s.group) ?? []
      arr.push(s)
      m.set(s.group, arr)
    }
    return [...m.entries()]
  }, [])

  if (!open) return null

  return (
    <div
      className="shortcut-panel-backdrop"
      onClick={onClose}
      role="dialog"
      aria-label="快捷键面板"
    >
      <div
        className="shortcut-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcut-panel-header">
          <span>键盘快捷键 {mac ? '(macOS)' : '(Windows / Linux)'}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="shortcut-panel-body">
          {groups.map(([group, items]) => (
            <div key={group} className="shortcut-group">
              <h4 className="shortcut-group-title">{group}</h4>
              <ul className="shortcut-list">
                {items.map((s, i) => (
                  <li key={i} className="shortcut-item">
                    <span className="shortcut-desc">{s.desc}</span>
                    <kbd className="shortcut-keys">{mac ? s.keysMac : s.keysWin}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
