import { useMemo } from 'react'
import MarkdownView from './MarkdownView'
import { formatAppUpdateNotes } from './app-update-notes'

export default function AppUpdateReleaseNotes({ notes, compact }: { notes?: string; compact: boolean }) {
  const text = useMemo(() => formatAppUpdateNotes(notes), [notes])
  return (
    <details className="app-update-notes" open>
      <summary>本次更新内容</summary>
      <div className="app-update-notes-body" tabIndex={0} role="region" aria-label="本次更新内容"
        style={{ maxHeight: compact ? 180 : 320 }}>
        {text
          ? <MarkdownView sections={[{ title: '', body: text }]} />
          : <p className="muted">此版本暂未提供更新说明。</p>}
      </div>
    </details>
  )
}
