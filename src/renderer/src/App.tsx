import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import ShortcutPanel, { useShortcutPanelToggle } from './ShortcutPanel'
export { SHORTCUTS, isMac } from './shortcut-defs'
import ProjectListPage from './ProjectListPage'
import type { Diagnostic, DiagnosticFixKind, MemoryEntityType, ProjectMeta } from '../../shared/types'
import {
  loadPendingSyncQueue,
  countPendingSyncQueue,
  formatPendingSyncBootHint,
  shouldShowPendingBootHint,
  markPendingBootHintShown,
  PENDING_SYNC_CHANGED_EVENT
} from '../../shared/post-write-sync-session'
import { getLocalStorage } from '../../main/data/rewrite-persistence'

// 除首屏项目列表外，页面全部懒加载：Electron 本地磁盘加载 chunk 几乎无感，
// 换来主 chunk 大幅瘦身（编辑器/设置页/关系图谱等重页面不再拖慢启动解析）。
const ChapterListPage = lazy(() => import('./ChapterListPage'))
const ChapterEditor = lazy(() => import('./ChapterEditor'))
const CharacterManagerPage = lazy(() => import('./CharacterManagerPage'))
const MemoryCenterPage = lazy(() => import('./MemoryCenterPage'))
const MemoryEntityPage = lazy(() => import('./MemoryEntityPage'))
const ForeshadowingBoard = lazy(() => import('./ForeshadowingBoard'))
const TrackingPage = lazy(() => import('./TrackingPage'))
const RelationshipPage = lazy(() => import('./RelationshipPage'))
const SettingsPage = lazy(() => import('./SettingsPage'))
const OutlinePage = lazy(() => import('./OutlinePage'))
const RhythmChartPage = lazy(() => import('./RhythmChartPage'))
const FigurePage = lazy(() => import('./FigurePage'))
const StyleProfilePage = lazy(() => import('./StyleProfilePage'))
const CoverLearningLibraryPage = lazy(() => import('./CoverLearningLibraryPage'))
const TeardownPage = lazy(() => import('./TeardownPage'))
const CoverPage = lazy(() => import('./CoverPage'))
const ScanPage = lazy(() => import('./ScanPage'))
const ProjectInspirationPage = lazy(() => import('./ProjectInspirationPage'))
const ProjectInfoPage = lazy(() => import('./ProjectInfoPage'))

type ThemeMode = 'light' | 'dark' | 'system'

type View =
  | { kind: 'projects' }
  | { kind: 'teardown' }
  | { kind: 'scan' }
  | { kind: 'inspiration' }
  | { kind: 'projectInfo'; projectId: string }
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
  | { kind: 'coverLearningLibrary' }
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

function initialView(): View {
  const projectId = new URLSearchParams(window.location.search).get('projectId')?.trim()
  return projectId ? { kind: 'chapters', projectId } : { kind: 'projects' }
}

function replaceProjectInUrl(projectId: string | null): void {
  const url = new URL(window.location.href)
  if (projectId) url.searchParams.set('projectId', projectId)
  else url.searchParams.delete('projectId')
  window.history.replaceState(null, '', url)
}

function isNavActive(view: View, kind: string, projectId: string | null): boolean {
  if (kind === 'projects') return view.kind === 'projects'
  if (kind === 'teardown') return view.kind === 'teardown'
  if (kind === 'inspiration') return view.kind === 'inspiration'
  if (kind === 'styles') return view.kind === 'styles'
  if (kind === 'coverLearningLibrary') return view.kind === 'coverLearningLibrary'
  if (!projectId) return false
  if (kind === 'chapters') return view.kind === 'chapters' || view.kind === 'editor'
  if (kind === 'projectInfo') return view.kind === 'projectInfo'
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
  const [view, setView] = useState<View>(initialView)
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [projectName, setProjectName] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [diagDismissed, setDiagDismissed] = useState(false)
  const [diagExpanded, setDiagExpanded] = useState(false)
  const diagWarnCount = useMemo(
    () => diagnostics.filter((d) => d.severity === 'warn').length,
    [diagnostics]
  )
  /** 正在执行的修复类型；非 null 时禁用全部修复按钮，避免并发改同一批文件 */
  const [diagFixing, setDiagFixing] = useState<DiagnosticFixKind | null>(null)
  /** 各修复的结果文案，按 kind 存 */
  const [diagFixResults, setDiagFixResults] = useState<Record<string, string>>({})
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
    let cancelled = false
    if (!currentProjectId) {
      replaceProjectInUrl(null)
      document.title = '大神持笔'
      void window.api
        .bindProjectWindow(null)
        .catch((err) => console.error('[App] release window project failed:', err))
      setProjectName('')
      setDiagnostics([])
      setDiagFixResults({})
      // 离开项目视图：停止文件监听
      void window.api.stopWatchProject().catch((err) => console.error('[App] stopWatch failed:', err))
      return () => {
        cancelled = true
      }
    }
    replaceProjectInUrl(currentProjectId)
    const activateProject = async () => {
      try {
        const result = await window.api.bindProjectWindow(currentProjectId)
        if (cancelled) return
        if (!result.ok) {
          if (result.focusedExisting) setView({ kind: 'projects' })
          return
        }

        // 只有窗口绑定成功后才启动该项目的监听和数据加载。
        const watching = await window.api.watchProject(currentProjectId)
        if (cancelled || !watching) return

        void window.api
          .listProjects()
          .then((list: ProjectMeta[]) => {
            if (cancelled) return
            const project = list.find((item) => item.id === currentProjectId)
            setProjectName(project?.name ?? '')
            document.title = project?.name ? `${project.name} — 大神持笔` : '大神持笔'
          })
          .catch((err) => console.error('[App] Failed to list projects:', err))
        setDiagDismissed(false)
        void window.api
          .getDiagnostics(currentProjectId)
          .then((nextDiagnostics) => {
            if (!cancelled) setDiagnostics(nextDiagnostics)
          })
          .catch((err) => console.error('[App] Failed to get diagnostics:', err))
      } catch (err) {
        console.error('[App] activate project failed:', err)
        if (!cancelled) setView({ kind: 'projects' })
      }
    }
    void activateProject()
    return () => {
      cancelled = true
    }
  }, [currentProjectId])

  // 细纲/节奏图谱/正文变动后重跑体检：一致性问题多是外部改文件（技能、脚本）引入的，
  // 只在打开项目时跑一次会让告警停在旧状态。
  useEffect(() => {
    if (!currentProjectId) return
    const off = window.api.onProjectFilesChanged((e) => {
      if (e.projectId !== currentProjectId) return
      if (e.kind !== 'outline' && e.kind !== 'rhythm' && e.kind !== 'prose') return
      void window.api
        .getDiagnostics(currentProjectId)
        .then(setDiagnostics)
        .catch((err) => console.error('[App] Failed to refresh diagnostics:', err))
    })
    return off
  }, [currentProjectId])

  /** 执行一键修复，完成后立刻重跑体检，让列表反映最新状态 */
  const runDiagnosticFix = async (kind: DiagnosticFixKind): Promise<void> => {
    if (!currentProjectId || diagFixing) return
    setDiagFixing(kind)
    try {
      const result = await window.api.fixDiagnostic(currentProjectId, kind)
      const skipped = result.skipped?.length
        ? `；${result.skipped.length} 项跳过：${result.skipped.slice(0, 3).join('，')}`
        : ''
      setDiagFixResults((prev) => ({ ...prev, [kind]: `${result.message}${skipped}` }))
      setDiagnostics(await window.api.getDiagnostics(currentProjectId))
    } catch (err) {
      setDiagFixResults((prev) => ({
        ...prev,
        [kind]: `修复失败：${(err as Error).message || '请重试'}`
      }))
    } finally {
      setDiagFixing(null)
    }
  }

  const openProjectHere = async (projectId: string) => {
    const result = await window.api.bindProjectWindow(projectId)
    if (result.ok) setView({ kind: 'chapters', projectId })
  }

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
              : view.kind === 'inspiration'
                ? 'inspiration-wide'
                : view.kind === 'covers'
                  ? 'cover-wide'
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
            className={`nav-item ${view.kind === 'inspiration' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'inspiration' })}
          >
            <span className="icon">🎲</span>
            灵感抽签
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
          <button
            className={`nav-item ${view.kind === 'coverLearningLibrary' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'coverLearningLibrary' })}
          >
            <span className="icon">🗃</span>
            学习库
          </button>

          {currentProjectId ? (
            <>
              <div className="sidebar-section">{projectName || '当前项目'}</div>
              <button
                className={`nav-item ${isNavActive(view, 'projectInfo', currentProjectId) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'projectInfo', projectId: currentProjectId })}
              >
                <span className="icon">📖</span>
                作品信息
              </button>
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
                <strong>
                  ⚠ 项目体检：{diagWarnCount > 0 ? `${diagWarnCount} 项待处理` : '无告警'}
                  {diagnostics.length > diagWarnCount
                    ? ` · ${diagnostics.length - diagWarnCount} 条提示`
                    : ''}
                </strong>
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
                        <span className="diag-msg">
                          <span className="diag-file">{item.file}</span>
                          {item.message}
                        </span>
                        {item.hint ? <span className="diag-hint">修复建议：{item.hint}</span> : null}
                        {item.details?.length ? (
                          <ul className="diag-details">
                            {item.details.map((line, i) => (
                              <li key={i}>{line}</li>
                            ))}
                          </ul>
                        ) : null}
                        {item.fixes?.length ? (
                          <span className="diag-actions">
                            {item.fixes.map((fix) => (
                              <button
                                key={fix.kind}
                                className="btn btn-sm"
                                title={fix.title}
                                disabled={diagFixing !== null}
                                onClick={() => void runDiagnosticFix(fix.kind)}
                              >
                                {diagFixing === fix.kind ? '修复中…' : fix.label}
                              </button>
                            ))}
                          </span>
                        ) : null}
                        {item.fixes
                          ?.map((fix) => diagFixResults[fix.kind])
                          .filter(Boolean)
                          .map((text, i) => (
                            <span key={i} className="diag-hint">
                              ✓ {text}
                            </span>
                          ))}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          <Suspense fallback={<p className="empty">页面加载中…</p>}>
          {view.kind === 'projects' ? (
            <ErrorBoundary>
              <ProjectListPage
                onOpenProject={(id) => void openProjectHere(id)}
                onOpenProjectWindow={(id) => void window.api.openProjectWindow(id)}
              />
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
          ) : view.kind === 'inspiration' ? (
            <ErrorBoundary>
              <ProjectInspirationPage />
            </ErrorBoundary>
          ) : view.kind === 'projectInfo' ? (
            <ErrorBoundary>
              <ProjectInfoPage
                projectId={view.projectId}
                onProjectUpdated={(name) => {
                  setProjectName(name)
                  document.title = `${name} — 大神持笔`
                }}
              />
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
          ) : view.kind === 'coverLearningLibrary' ? (
            <ErrorBoundary>
              <CoverLearningLibraryPage />
            </ErrorBoundary>
          ) : view.kind === 'covers' ? (
            <ErrorBoundary>
              <CoverPage projectId={view.projectId} />
            </ErrorBoundary>
          ) : null}
          </Suspense>
        </div>
      </main>

      <ShortcutPanel open={shortcutOpen} onClose={hideShortcut} />
    </div>
  )
}
