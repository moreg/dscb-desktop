import { useEffect, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import ShortcutPanel, { useShortcutPanelToggle } from './ShortcutPanel'
export { SHORTCUTS, isMac } from './shortcut-defs'
import ProjectListPage from './ProjectListPage'
import ChapterListPage from './ChapterListPage'
import ChapterEditor from './ChapterEditor'
import CharacterManagerPage from './CharacterManagerPage'
import MemoryCenterPage from './MemoryCenterPage'
import MemoryEntityPage from './MemoryEntityPage'
import ForeshadowingBoard from './ForeshadowingBoard'
import TrackingPage from './TrackingPage'
import RelationshipPage from './RelationshipPage'
import SettingsPage from './SettingsPage'
import OutlinePage from './OutlinePage'
import RhythmChartPage from './RhythmChartPage'
import FigurePage from './FigurePage'
import StyleProfilePage from './StyleProfilePage'
import TeardownPage from './TeardownPage'
import CoverPage from './CoverPage'
import ScanPage from './ScanPage'
import type { Diagnostic, MemoryEntityType, ProjectMeta } from '../../shared/types'
import {
  loadPendingSyncQueue,
  countPendingSyncQueue,
  formatPendingSyncBootHint,
  shouldShowPendingBootHint,
  markPendingBootHintShown,
  PENDING_SYNC_CHANGED_EVENT
} from '../../shared/post-write-sync-session'
import { getLocalStorage } from '../../main/data/rewrite-persistence'

type ThemeMode = 'light' | 'dark' | 'system'

type View =
  | { kind: 'projects' }
  | { kind: 'teardown' }
  | { kind: 'scan' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }
  | { kind: 'characters'; projectId: string }
  | { kind: 'memoryCenter'; projectId: string }
  | { kind: 'memoryEntity'; projectId: string; entityType: MemoryEntityType }
  | { kind: 'foreshadowingBoard'; projectId: string }
  | { kind: 'tracking'; projectId: string }
  | { kind: 'relationships'; projectId: string }
  | { kind: 'outline'; projectId: string }
  | { kind: 'rhythm'; projectId: string }
  | { kind: 'figures'; projectId: string }
  | { kind: 'styles' }
  | { kind: 'covers'; projectId: string }
  | { kind: 'settings'; tab?: string }

const ENTITY_LABELS: Record<MemoryEntityType, string> = {
  location: '地点',
  worldview: '世界观',
  timeline: '时间线',
  plot_point: '剧情点',
  item: '物品'
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  const resolve = (): 'light' | 'dark' =>
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode
  const set = () => {
    if (resolve() === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }
  set()
  if (mode === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', set)
  }
}

function projectIdOf(view: View): string | null {
  return 'projectId' in view ? view.projectId : null
}

function isNavActive(view: View, kind: string, projectId: string | null): boolean {
  if (kind === 'projects') return view.kind === 'projects'
  if (kind === 'teardown') return view.kind === 'teardown'
  if (kind === 'styles') return view.kind === 'styles'
  if (!projectId) return false
  if (kind === 'chapters') return view.kind === 'chapters' || view.kind === 'editor'
  if (kind === 'outline') return view.kind === 'outline'
  if (kind === 'rhythm') return view.kind === 'rhythm'
  if (kind === 'figures') return view.kind === 'figures'
  if (kind === 'covers') return view.kind === 'covers'
  if (kind === 'characters') return view.kind === 'characters'
  if (kind === 'relationships') return view.kind === 'relationships'
  if (kind === 'memoryCenter') return view.kind === 'memoryCenter'
  if (kind === 'foreshadowingBoard') return view.kind === 'foreshadowingBoard'
  if (kind === 'tracking') return view.kind === 'tracking'
  if (kind.startsWith('entity:')) {
    const type = kind.split(':')[1] as MemoryEntityType
    return view.kind === 'memoryEntity' && view.entityType === type
  }
  return false
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [projectName, setProjectName] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [diagDismissed, setDiagDismissed] = useState(false)
  const [diagExpanded, setDiagExpanded] = useState(false)
  /** 启动时：待同步队列提醒 */
  const [bootSyncHint, setBootSyncHint] = useState<string | null>(null)
  /** 侧栏「设置」角标：待同步条数 */
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  const { open: shortcutOpen, hide: hideShortcut } = useShortcutPanelToggle()

  const refreshPendingSyncCount = () => {
    try {
      setPendingSyncCount(countPendingSyncQueue(getLocalStorage()))
    } catch {
      setPendingSyncCount(0)
    }
  }

  useEffect(() => {
    void window.api.getTheme().then((nextTheme) => {
      setTheme(nextTheme)
      applyTheme(nextTheme)
    })
  }, [])

  // 侧栏角标：挂载读一次 + 监听队列变更
  useEffect(() => {
    refreshPendingSyncCount()
    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ count?: number }>).detail
      if (typeof detail?.count === 'number') setPendingSyncCount(detail.count)
      else refreshPendingSyncCount()
    }
    window.addEventListener(PENDING_SYNC_CHANGED_EVENT, onChanged)
    // 跨标签/窗口 storage 事件兜底
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'ai-writer:pending-sync-queue' || e.key === null) {
        refreshPendingSyncCount()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PENDING_SYNC_CHANGED_EVENT, onChanged)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // 启动提醒：有 N 条待补跑同步（session 内只弹一次）
  useEffect(() => {
    try {
      const storage = getLocalStorage()
      const queue = loadPendingSyncQueue(storage)
      const hint = formatPendingSyncBootHint(queue.length)
      if (!hint) return
      const sess =
        typeof sessionStorage !== 'undefined'
          ? sessionStorage
          : null
      if (!shouldShowPendingBootHint(storage, sess, queue.length)) return
      markPendingBootHintShown(sess)
      setBootSyncHint(hint)
      const t = window.setTimeout(() => setBootSyncHint(null), 12000)
      return () => window.clearTimeout(t)
    } catch {
      /* ignore */
    }
  }, [])

  const currentProjectId = projectIdOf(view)
  useEffect(() => {
    if (!currentProjectId) {
      setProjectName('')
      setDiagnostics([])
      // 离开项目视图：停止文件监听
      void window.api.stopWatchProject().catch((err) => console.error('[App] stopWatch failed:', err))
      return
    }
    // 进入/切换项目：启动文件监听（主进程会先释放旧 watcher）
    void window.api.watchProject(currentProjectId).catch((err) => console.error('[App] watch failed:', err))
    void window.api
      .listProjects()
      .then((list: ProjectMeta[]) => {
        const project = list.find((item) => item.id === currentProjectId)
        setProjectName(project?.name ?? '')
      })
      .catch((err) => console.error('[App] Failed to list projects:', err))
    setDiagDismissed(false)
    void window.api
      .getDiagnostics(currentProjectId)
      .then(setDiagnostics)
      .catch((err) => console.error('[App] Failed to get diagnostics:', err))
  }, [currentProjectId])

  const onThemeChange = (nextTheme: ThemeMode) => {
    setTheme(nextTheme)
    applyTheme(nextTheme)
    void window.api.setTheme(nextTheme)
  }

  const mainInnerClass = `main-inner ${
    view.kind === 'projects'
      ? 'projects-wide'
      : view.kind === 'editor'
      ? 'editor-wide'
      : view.kind === 'relationships'
        ? 'relationship-wide'
        : view.kind === 'rhythm'
          ? 'rhythm-wide'
          : view.kind === 'foreshadowingBoard'
            ? 'foreshadowing-wide'
            : view.kind === 'tracking'
              ? 'tracking-wide'
              : ''
  }`

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1 className="title">
            <span className="dot" />
            大神持笔
          </h1>
          <p className="sub">本地创作 · AI 辅助</p>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">书案</div>
          <button
            className={`nav-item ${isNavActive(view, 'projects', currentProjectId) ? 'active' : ''}`}
            onClick={() => setView({ kind: 'projects' })}
          >
            <span className="icon">📚</span>
            我的项目
          </button>
          <button
            className={`nav-item ${view.kind === 'teardown' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'teardown' })}
          >
            <span className="icon">🔍</span>
            拆文库
          </button>
          <button
            className={`nav-item ${view.kind === 'scan' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'scan' })}
          >
            <span className="icon">📈</span>
            扫榜
          </button>
          <button
            className={`nav-item ${view.kind === 'styles' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'styles' })}
          >
            <span className="icon">✒</span>
            文风库
          </button>

          {currentProjectId ? (
            <>
              <div className="sidebar-section">{projectName || '当前项目'}</div>
              <button
                className={`nav-item ${isNavActive(view, 'chapters', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'chapters', projectId: currentProjectId })}
              >
                <span className="icon">📝</span>
                章节
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'outline', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'outline', projectId: currentProjectId })}
              >
                <span className="icon">📐</span>
                大纲
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'rhythm', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'rhythm', projectId: currentProjectId })}
              >
                <span className="icon">📈</span>
                节奏图谱
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'figures', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'figures', projectId: currentProjectId })}
              >
                <span className="icon">🗺</span>
                关键图解
              </button>

              <button
                className={`nav-item ${isNavActive(view, 'covers', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'covers', projectId: currentProjectId })}
              >
                <span className="icon">🖼</span>
                封面
              </button>

              <div className="sidebar-section">人物</div>
              <button
                className={`nav-item ${isNavActive(view, 'characters', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'characters', projectId: currentProjectId })}
              >
                <span className="icon">👤</span>
                人物档案
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'relationships', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'relationships', projectId: currentProjectId })}
              >
                <span className="icon">🔗</span>
                人物关系
              </button>

              <div className="sidebar-section">记忆</div>
              <button
                className={`nav-item ${isNavActive(view, 'memoryCenter', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'memoryCenter', projectId: currentProjectId })}
              >
                <span className="icon">🧠</span>
                记忆中心
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'tracking', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'tracking', projectId: currentProjectId })}
              >
                <span className="icon">🧭</span>
                追踪
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'foreshadowingBoard', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'foreshadowingBoard', projectId: currentProjectId })}
              >
                <span className="icon">🎯</span>
                伏笔
              </button>
            </>
          ) : null}
        </nav>

        <div className="sidebar-footer">
          <button
            className={`nav-item ${view.kind === 'settings' ? 'active' : ''}`}
            onClick={() =>
              setView({
                kind: 'settings',
                tab: pendingSyncCount > 0 ? 'syncQueue' : undefined
              })
            }
            title={
              pendingSyncCount > 0
                ? `${pendingSyncCount} 条记忆同步待补跑`
                : '设置'
            }
          >
            <span className="icon">⚙</span>
            设置
            {pendingSyncCount > 0 ? (
              <span className="badge badge-alert" aria-label={`${pendingSyncCount} 条待同步`}>
                {pendingSyncCount > 99 ? '99+' : pendingSyncCount}
              </span>
            ) : null}
          </button>
          <button
            className="nav-item"
            onClick={() => {
              const next: ThemeMode = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
              onThemeChange(next)
            }}
            title={theme === 'light' ? '浅色模式（点击切换）' : theme === 'dark' ? '深色模式（点击切换）' : '跟随系统（点击切换）'}
          >
            <span className="icon">{theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'}</span>
            {theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '自动'}
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className={mainInnerClass}>
          {bootSyncHint ? (
            <div className="diag-banner boot-sync-hint" role="status">
              <div className="diag-banner-head">
                <strong>⟳ {bootSyncHint}</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setBootSyncHint(null)
                      setView({ kind: 'settings', tab: 'syncQueue' })
                    }}
                  >
                    去查看
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setBootSyncHint(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {diagnostics.length > 0 && !diagDismissed && currentProjectId ? (
            <div className="diag-banner">
              <div className="diag-banner-head">
                <strong>⚠ 格式体检：发现 {diagnostics.length} 处可能的格式问题</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setDiagExpanded((v) => !v)}>
                    {diagExpanded ? '收起' : '查看详情'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setDiagDismissed(true)}>
                    忽略
                  </button>
                </div>
              </div>
              {diagExpanded ? (
                <>
                  <ul className="diag-list">
                    {diagnostics.map((item, index) => (
                      <li key={index} className="diag-item">
                        <span className="diag-msg">{item.message}</span>
                        {item.hint ? <span className="diag-hint">修复建议：{item.hint}</span> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          {view.kind === 'projects' ? (
            <ErrorBoundary>
              <ProjectListPage onOpenProject={(id) => setView({ kind: 'chapters', projectId: id })} />
            </ErrorBoundary>
          ) : view.kind === 'settings' ? (
            <ErrorBoundary>
              <SettingsPage
                initialTab={view.kind === 'settings' ? view.tab : undefined}
                onOpenChapter={(projectId, chapterNumber) =>
                  setView({ kind: 'editor', projectId, chapterNumber })
                }
              />
            </ErrorBoundary>
          ) : view.kind === 'teardown' ? (
            <ErrorBoundary>
              <TeardownPage />
            </ErrorBoundary>
          ) : view.kind === 'scan' ? (
            <ErrorBoundary>
              <ScanPage />
            </ErrorBoundary>
          ) : view.kind === 'chapters' ? (
            <ErrorBoundary>
              <ChapterListPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'projects' })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
                onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
                onOpenMemoryCenter={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenOutline={() => setView({ kind: 'outline', projectId: view.projectId })}
              />
            </ErrorBoundary>
          ) : view.kind === 'editor' ? (
            <ErrorBoundary>
              <ChapterEditor
                projectId={view.projectId}
                chapterNumber={view.chapterNumber}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenOutline={() => setView({ kind: 'outline', projectId: view.projectId })}
                onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
                onNavigateChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'characters' ? (
            <ErrorBoundary>
              <CharacterManagerPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'memoryCenter' ? (
            <ErrorBoundary>
              <MemoryCenterPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
                onOpenEntity={(entityType) =>
                  setView({ kind: 'memoryEntity', projectId: view.projectId, entityType })
                }
                onOpenForeshadowings={() => setView({ kind: 'foreshadowingBoard', projectId: view.projectId })}
                onOpenRelationships={() => setView({ kind: 'relationships', projectId: view.projectId })}
              />
            </ErrorBoundary>
          ) : view.kind === 'memoryEntity' ? (
            <ErrorBoundary>
              <MemoryEntityPage
                projectId={view.projectId}
                type={view.entityType}
                label={ENTITY_LABELS[view.entityType]}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'tracking' ? (
            <ErrorBoundary>
              <TrackingPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenForeshadowings={() => setView({ kind: 'foreshadowingBoard', projectId: view.projectId })}
              />
            </ErrorBoundary>
          ) : view.kind === 'foreshadowingBoard' ? (
            <ErrorBoundary>
              <ForeshadowingBoard
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'relationships' ? (
            <ErrorBoundary>
              <RelationshipPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
                onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
              />
            </ErrorBoundary>
          ) : view.kind === 'outline' ? (
            <ErrorBoundary>
              <OutlinePage
                projectId={view.projectId}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'rhythm' ? (
            <ErrorBoundary>
              <RhythmChartPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'figures' ? (
            <ErrorBoundary>
              <FigurePage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenChapter={(n) => setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })}
              />
            </ErrorBoundary>
          ) : view.kind === 'styles' ? (
            <ErrorBoundary>
              <StyleProfilePage projectId={currentProjectId || undefined} />
            </ErrorBoundary>
          ) : view.kind === 'covers' ? (
            <ErrorBoundary>
              <CoverPage projectId={view.projectId} />
            </ErrorBoundary>
          ) : null}
        </div>
      </main>

      <ShortcutPanel open={shortcutOpen} onClose={hideShortcut} />
    </div>
  )
}
