import { useState } from 'react'
import ProjectListPage from './ProjectListPage'
import ChapterListPage from './ChapterListPage'
import ChapterEditor from './ChapterEditor'
import CharacterManagerPage from './CharacterManagerPage'

type View =
  | { kind: 'projects' }
  | { kind: 'chapters'; projectId: string }
  | { kind: 'editor'; projectId: string; chapterNumber: number }
  | { kind: 'characters'; projectId: string }

export default function App() {
  const [view, setView] = useState<View>({ kind: 'projects' })

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 820, margin: '40px auto', padding: '0 20px' }}>
      <h1>ai-writer 桌面版</h1>
      <p style={{ color: '#64748b' }}>Phase 03 · 项目 / 章节 / 人物（本地文件存储）</p>
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
        />
      ) : view.kind === 'characters' ? (
        <CharacterManagerPage
          projectId={view.projectId}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      ) : (
        <ChapterEditor
          projectId={view.projectId}
          chapterNumber={view.chapterNumber}
          onBack={() => setView({ kind: 'chapters', projectId: view.projectId })}
        />
      )}
    </div>
  )
}
