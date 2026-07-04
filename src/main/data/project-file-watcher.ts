import { watch, type FSWatcher } from 'fs'
import { join, relative, sep } from 'path'
import type { BrowserWindow } from 'electron'

export type FileChangeKind = 'outline' | 'rhythm' | 'progress' | 'characters' | 'prose'

export interface FileChangeEvent {
  projectId: string
  kind: FileChangeKind
}

/** 防抖窗口：编辑器保存常在短时间内触发多次 fs 事件，合并为一次通知 */
const DEBOUNCE_MS = 300

/**
 * 项目文件监听器。主进程用 fs.watch 递归监听当前项目目录，
 * 防抖合并后通过 webContents.send 推送到渲染进程刷新。
 *
 * 设计：
 * - 渲染进程进入项目视图时调 watchProject(projectId, dir)；离开调 stopWatching。
 * - 切项目时直接覆盖旧 watcher（无需先 stop）。
 * - 仅监听关心的路径（细纲/节奏图谱/章节进度/角色卡/正文），忽略其他。
 * - 防抖 300ms：同一 kind 在窗口内的多次事件合并为一次通知。
 */
export class ProjectFileWatcher {
  private watcher: FSWatcher | null = null
  private currentProjectId: string | null = null
  /** 按 kind 分别防抖：不同类型互不阻塞，同类型合并 */
  private readonly timers = new Map<FileChangeKind, NodeJS.Timeout>()

  constructor(private readonly windowGetter: () => BrowserWindow | null) {}

  watchProject(projectId: string, dir: string): void {
    // 切项目：先释放旧 watcher
    this.stopWatching()
    this.currentProjectId = projectId

    try {
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const kind = classifyChange(filename)
        if (!kind) return
        this.scheduleNotify(kind)
      })
    } catch (err) {
      // recursive 在某些平台/文件系统可能不支持，降级为不监听（不影响功能）
      console.warn('[ProjectFileWatcher] watch failed:', err)
      this.watcher = null
    }
  }

  stopWatching(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.currentProjectId = null
  }

  dispose(): void {
    this.stopWatching()
  }

  private scheduleNotify(kind: FileChangeKind): void {
    const existing = this.timers.get(kind)
    if (existing) clearTimeout(existing)
    this.timers.set(
      kind,
      setTimeout(() => {
        this.timers.delete(kind)
        this.notify(kind)
      }, DEBOUNCE_MS)
    )
  }

  private notify(kind: FileChangeKind): void {
    if (!this.currentProjectId) return
    const win = this.windowGetter()
    if (!win || win.isDestroyed()) return
    win.webContents.send('project:files-changed', {
      projectId: this.currentProjectId,
      kind
    } satisfies FileChangeEvent)
  }
}

/**
 * 按相对路径归类文件变更。filename 是相对项目根的路径（分隔符为平台原生）。
 * 忽略：非目标后缀、编辑器临时文件、正文之外的 .md 等。
 */
function classifyChange(filename: string): FileChangeKind | null {
  // 统一为正斜杠便于匹配
  const norm = filename.split(sep).join('/')
  // 忽略编辑器临时/备份文件
  if (/[~]$|\.swp$|\.tmp$|\.bak$/i.test(norm)) return null

  // 节奏图谱
  if (norm === '图解/节奏图谱.html' || norm.startsWith('图解/节奏图谱')) {
    return 'rhythm'
  }
  // 章节进度笔记
  if (norm === '记忆系统/章节进度.md') return 'progress'
  // 角色卡（旧格式单文件 + 新格式每角色一文件）
  if (norm === '记忆系统/角色卡.md' || norm.startsWith('设定/角色/')) {
    return 'characters'
  }
  // 细纲
  if (norm.startsWith('细纲/') && norm.endsWith('.md')) return 'outline'
  // 正文
  if (norm.startsWith('正文/') && norm.endsWith('.md')) return 'prose'

  return null
}

/** 仅供测试：暴露分类逻辑 */
export function classifyChangeForTest(filename: string): FileChangeKind | null {
  return classifyChange(filename)
}
