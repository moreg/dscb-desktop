import { useEffect, useState } from 'react'
import { ErrorBoundary } from './ErrorBoundary'
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
import type { MemoryEntityType } from '../../shared/types'

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
  // system 模式下监听系统变化
  if (mode === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', set)
  }
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })
  const [theme, setTheme] = useState<ThemeMode>('system')

  useEffect(() => {
    void window.api.getTheme().then((t) => {
      setTheme(t)
      applyTheme(t)
    })
  }, [])

  const onThemeChange = (t: ThemeMode) => {
    setTheme(t)
    applyTheme(t)
    void window.api.setTheme(t)
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1><span className="chip-seal" style={{ marginRight: 12, verticalAlign: 'middle' }}>卷一</span>大神持笔</h1>
          <p className="sub">本地创作 · AI 辅助 · 落笔生花</p>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div className="theme-toggle" title="主题">
            <button
              className={theme === 'light' ? 'active' : ''}
              onClick={() => onThemeChange('light')}
            >
              浅
            </button>
            <button
              className={theme === 'dark' ? 'active' : ''}
              onClick={() => onThemeChange('dark')}
            >
              深
            </button>
            <button
              className={theme === 'system' ? 'active' : ''}
              onClick={() => onThemeChange('system')}
            >
              自动
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => setView({ kind: 'settings' })}>
            ⚙ 设置
          </button>
        </div>
      </header>
      {view.kind === 'projects' ? (
        <ErrorBoundary>
          <ProjectListPage onOpenProject={(id) => setView({ kind: 'chapters', projectId: id })} />
        </ErrorBoundary>
      ) : view.kind === 'settings' ? (
        <ErrorBoundary>
          <SettingsPage onBack={() => setView({ kind: 'projects' })} />
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
            onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
            onOpenChapter={(n) =>
              setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
            }
          />
        </ErrorBoundary>
      ) : null}
    </div>
  )
}
