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
import RelationshipPage from './RelationshipPage'
import SettingsPage from './SettingsPage'
import OutlinePage from './OutlinePage'
import RhythmChartPage from './RhythmChartPage'
import FigurePage from './FigurePage'
import type { MemoryEntityType, ProjectMeta, Diagnostic } from '../../shared/types'

type ThemeMode = 'light' | 'dark' | 'system'

type View =
  | { kind: 'projects' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }
  | { kind: 'characters'; projectId: string }
  | { kind: 'memoryCenter'; projectId: string }
  | { kind: 'memoryEntity'; projectId: string; entityType: MemoryEntityType }
  | { kind: 'foreshadowingBoard'; projectId: string }
  | { kind: 'relationships'; projectId: string }
  | { kind: 'outline'; projectId: string }
  | { kind: 'rhythm'; projectId: string }
  | { kind: 'figures'; projectId: string }
  | { kind: 'settings' }

const ENTITY_LABELS: Record<MemoryEntityType, string> = {
  location: '地点',
  worldview: '世界观',
  timeline: '时间线',
  plot_point: '剧情点'
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  const resolve = (): 'light' | 'dark' => {
    if (mode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return mode
  }
  const set = () => {
    const v = resolve()
    if (v === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }
  set()
  if (mode === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', set)
  }
}

/** 从 view 中提取当前项目 id（若无返回 null） */
function projectIdOf(v: View): string | null {
  if ('projectId' in v) return v.projectId
  return null
}

/** 判断导航项是否对应当前 view */
function isNavActive(view: View, kind: string, projectId: string | null): boolean {
  if (kind === 'projects') return view.kind === 'projects'
  if (!projectId) return false
  if (kind === 'chapters') return view.kind === 'chapters' || view.kind === 'editor'
  if (kind === 'outline') return view.kind === 'outline'
  if (kind === 'rhythm') return view.kind === 'rhythm'
  if (kind === 'figures') return view.kind === 'figures'
  if (kind === 'characters') return view.kind === 'characters'
  if (kind === 'relationships') return view.kind === 'relationships'
  if (kind === 'memoryCenter') return view.kind === 'memoryCenter'
  if (kind === 'foreshadowingBoard') return view.kind === 'foreshadowingBoard'
  if (kind.startsWith('entity:')) {
    const t = kind.split(':')[1] as MemoryEntityType
    return view.kind === 'memoryEntity' && view.entityType === t
  }
  return false
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [projectName, setProjectName] = useState<string>('')
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [diagDismissed, setDiagDismissed] = useState(false)
  const { open: shortcutOpen, show: showShortcut, hide: hideShortcut } = useShortcutPanelToggle()

  useEffect(() => {
    void window.api.getTheme().then((t) => {
      setTheme(t)
      applyTheme(t)
    })
  }, [])

  // 当切换项目时，加载项目名用于侧边栏展示
  const currentProjectId = projectIdOf(view)
  useEffect(() => {
    if (!currentProjectId) {
      setProjectName('')
      setDiagnostics([])
      return
    }
    void window.api.listProjects()
      .then((list: ProjectMeta[]) => {
        const p = list.find((x) => x.id === currentProjectId)
        setProjectName(p?.name ?? '')
      })
      .catch((err) => console.error('[App] Failed to list projects:', err))
    // 格式体检：进入项目时扫描一次（文件有内容但解析为空 → 静默丢数据风险）
    setDiagDismissed(false)
    void window.api.getDiagnostics(currentProjectId)
      .then(setDiagnostics)
      .catch((err) => console.error('[App] Failed to get diagnostics:', err))
  }, [currentProjectId])

  const onThemeChange = (t: ThemeMode) => {
    setTheme(t)
    applyTheme(t)
    void window.api.setTheme(t)
  }

  const go = (v: View) => setView(v)
  const mainInnerClass = `main-inner ${view.kind === 'editor' ? 'wide' : view.kind === 'relationships' ? 'relationship-wide' : view.kind === 'rhythm' ? 'rhythm-wide' : view.kind === 'foreshadowingBoard' ? 'foreshadowing-wide' : ''}`

  return (
    <div className="app-shell">
      {/* ============ 侧边栏 ============ */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1 className="title">
            <span className="dot" />
            大神持笔
          </h1>
          <p className="sub">本地创作 · AI 辅助</p>
        </div>

        <nav className="sidebar-nav">
          {/* 书案区 */}
          <div className="sidebar-section">书案</div>
          <button
            className={`nav-item ${isNavActive(view, 'projects', currentProjectId) ? 'active' : ''}`}
            onClick={() => go({ kind: 'projects' })}
          >
            <span className="icon">📚</span>
            我的项目
          </button>

          {/* 项目内导航 */}
          {currentProjectId ? (
            <>
              <div className="sidebar-section">{projectName || '当前项目'}</div>

              <button
                className={`nav-item ${isNavActive(view, 'chapters', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'chapters', projectId: currentProjectId })}
              >
                <span className="icon">📖</span>
                章节
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'outline', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'outline', projectId: currentProjectId })}
              >
                <span className="icon">📜</span>
                大纲
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'rhythm', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'rhythm', projectId: currentProjectId })}
              >
                <span className="icon">📈</span>
                节奏图谱
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'figures', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'figures', projectId: currentProjectId })}
              >
                <span className="icon">🎬</span>
                关键图解
              </button>

              <div className="sidebar-section">人物</div>
              <button
                className={`nav-item ${isNavActive(view, 'characters', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'characters', projectId: currentProjectId })}
              >
                <span className="icon">👤</span>
                人物档案
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'relationships', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'relationships', projectId: currentProjectId })}
              >
                <span className="icon">🔗</span>
                人物关系
              </button>

              <div className="sidebar-section">记忆</div>
              <button
                className={`nav-item ${isNavActive(view, 'memoryCenter', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'memoryCenter', projectId: currentProjectId })}
              >
                <span className="icon">🧠</span>
                记忆中心
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'entity:location', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'memoryEntity', projectId: currentProjectId, entityType: 'location' })}
              >
                <span className="icon">🏯</span>
                地点
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'entity:worldview', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'memoryEntity', projectId: currentProjectId, entityType: 'worldview' })}
              >
                <span className="icon">☯</span>
                世界观
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'entity:timeline', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'memoryEntity', projectId: currentProjectId, entityType: 'timeline' })}
              >
                <span className="icon">⌛</span>
                时间线
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'entity:plot_point', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'memoryEntity', projectId: currentProjectId, entityType: 'plot_point' })}
              >
                <span className="icon">✦</span>
                剧情点
              </button>
              <button
                className={`nav-item ${isNavActive(view, 'foreshadowingBoard', currentProjectId) ? 'active' : ''}`}
                onClick={() => go({ kind: 'foreshadowingBoard', projectId: currentProjectId })}
              >
                <span className="icon">📌</span>
                伏笔
              </button>
            </>
          ) : null}
        </nav>

        {/* 侧边栏底部：设置 + 主题 */}
        <div className="sidebar-footer">
          <button
            className={`nav-item ${view.kind === 'settings' ? 'active' : ''}`}
            onClick={() => go({ kind: 'settings' })}
          >
            <span className="icon">⚙</span>
            设置
          </button>
          <div className="theme-switch">
            <button
              className={theme === 'light' ? 'active' : ''}
              onClick={() => onThemeChange('light')}
              title="浅色"
            >
              浅
            </button>
            <button
              className={theme === 'dark' ? 'active' : ''}
              onClick={() => onThemeChange('dark')}
              title="深色"
            >
              深
            </button>
            <button
              className={theme === 'system' ? 'active' : ''}
              onClick={() => onThemeChange('system')}
              title="跟随系统"
            >
              自动
            </button>
          </div>
        </div>
      </aside>

      {/* ============ 主内容区 ============ */}
      <main className="main-content">
        <div className={mainInnerClass}>
          {diagnostics.length > 0 && !diagDismissed && currentProjectId ? (
            <div className="diag-banner">
              <div className="diag-banner-head">
                <strong>⚠️ 格式体检：发现 {diagnostics.length} 处可能的格式问题（可能导致静默丢数据）</strong>
                <button className="btn btn-ghost btn-sm" onClick={() => setDiagDismissed(true)}>
                  忽略
                </button>
              </div>
              <ul className="diag-list">
                {diagnostics.map((d, i) => (
                  <li key={i} className="diag-item">
                    <span className="diag-file">{d.file}</span>
                    <span className="diag-msg">{d.message}</span>
                    {d.hint ? <span className="diag-hint">修复建议：{d.hint}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="diag-footer">
                完整格式要求见 <code>docs/md-format-spec.md</code>
              </p>
            </div>
          ) : null}
          {view.kind === 'projects' ? (
            <ErrorBoundary>
              <ProjectListPage onOpenProject={(id) => setView({ kind: 'chapters', projectId: id })} />
            </ErrorBoundary>
          ) : view.kind === 'settings' ? (
            <ErrorBoundary>
              <SettingsPage />
            </ErrorBoundary>
          ) : view.kind === 'chapters' ? (
            <ErrorBoundary>
              <ChapterListPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'projects' })}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
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
              />
            </ErrorBoundary>
          ) : view.kind === 'characters' ? (
            <ErrorBoundary>
              <CharacterManagerPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
              />
            </ErrorBoundary>
          ) : view.kind === 'memoryCenter' ? (
            <ErrorBoundary>
              <MemoryCenterPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
                onOpenEntity={(t) =>
                  setView({ kind: 'memoryEntity', projectId: view.projectId, entityType: t })
                }
                onOpenForeshadowings={() =>
                  setView({ kind: 'foreshadowingBoard', projectId: view.projectId })
                }
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
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
              />
            </ErrorBoundary>
          ) : view.kind === 'foreshadowingBoard' ? (
            <ErrorBoundary>
              <ForeshadowingBoard
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
              />
            </ErrorBoundary>
          ) : view.kind === 'relationships' ? (
            <ErrorBoundary>
              <RelationshipPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
                onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
              />
            </ErrorBoundary>
          ) : view.kind === 'outline' ? (
            <ErrorBoundary>
              <OutlinePage
                projectId={view.projectId}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
              />
            </ErrorBoundary>
          ) : view.kind === 'rhythm' ? (
            <ErrorBoundary>
              <RhythmChartPage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
              />
            </ErrorBoundary>
          ) : view.kind === 'figures' ? (
            <ErrorBoundary>
              <FigurePage
                projectId={view.projectId}
                onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
                onOpenChapter={(n) =>
                  setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
                }
              />
            </ErrorBoundary>
          ) : null}
        </div>
      </main>

      {/* P19-C：全局快捷键面板（Cmd+/ / Ctrl+/ 打开） */}
      <ShortcutPanel open={shortcutOpen} onClose={hideShortcut} />
    </div>
  )
}
