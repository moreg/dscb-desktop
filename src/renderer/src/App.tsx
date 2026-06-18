import { useState } from 'react'
import ProjectListPage from './ProjectListPage'
import ChapterListPage from './ChapterListPage'
import ChapterEditor from './ChapterEditor'
import CharacterManagerPage from './CharacterManagerPage'
import MemoryCenterPage from './MemoryCenterPage'
import MemoryEntityPage from './MemoryEntityPage'
import ForeshadowingBoard from './ForeshadowingBoard'
import type { MemoryEntityType } from '../../shared/types'

type View =
  | { kind: 'projects' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }
  | { kind: 'characters'; projectId: string }
  | { kind: 'memoryCenter'; projectId: string }
  | { kind: 'memoryEntity'; projectId: string; entityType: MemoryEntityType }
  | { kind: 'foreshadowingBoard'; projectId: string }

const ENTITY_LABELS: Record<MemoryEntityType, string> = {
  location: '地点',
  worldview: '世界观',
  timeline: '时间线',
  plot_point: '剧情点'
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 820, margin: '40px auto', padding: '0 20px' }}>
      <h1>ai-writer 桌面版</h1>
      <p style={{ color: '#64748b' }}>Phase 06 · 项目 / 章节 / 记忆 / 伏笔（本地文件存储）</p>
      <hr />
      {view.kind === 'projects' ? (
        <ProjectListPage onOpenProject={(id) => setView({ kind: 'chapters', projectId: id })} />
      ) : view.kind === 'chapters' ? (
        <ChapterListPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'projects' })}
          onOpenChapter={(n) =>
            setView({ kind: 'editor', projectId: view.projectId, chapterNumber: n })
          }
          onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
          onOpenMemoryCenter={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : view.kind === 'editor' ? (
        <ChapterEditor
          projectId={view.projectId}
          chapterNumber={view.chapterNumber}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      ) : view.kind === 'characters' ? (
        <CharacterManagerPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : view.kind === 'memoryCenter' ? (
        <MemoryCenterPage
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
          onOpenCharacters={() => setView({ kind: 'characters', projectId: view.projectId })}
          onOpenEntity={(t) =>
            setView({ kind: 'memoryEntity', projectId: view.projectId, entityType: t })
          }
          onOpenForeshadowings={() =>
            setView({ kind: 'foreshadowingBoard', projectId: view.projectId })
          }
        />
      ) : view.kind === 'memoryEntity' ? (
        <MemoryEntityPage
          projectId={view.projectId}
          type={view.entityType}
          label={ENTITY_LABELS[view.entityType]}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      ) : (
        <ForeshadowingBoard
          projectId={view.projectId}
          onBack={() => setView({ kind: 'memoryCenter', projectId: view.projectId })}
        />
      )}
    </div>
  )
}
