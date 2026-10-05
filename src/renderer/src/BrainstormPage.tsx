import { useRef, useState } from 'react'
import type { LongStoryIdea } from '../../shared/long-story-brainstorm'
import { longStoryIdeaBrief } from '../../shared/long-story-brainstorm'
import type { ProjectMeta } from '../../shared/types'
import LongStoryBrainstorm from './LongStoryBrainstorm'
import NewProjectDialog from './NewProjectDialog'
import {
  allowBrainstormPageDraftWrite, readBrainstormPageDraft, writeBrainstormPageDraft
} from './brainstorm-page-draft'
import type { BrainstormPageDraft } from './brainstorm-page-draft'
import './brainstorm-page.css'

interface ProjectDraft {
  name: string
  genre: string
  description: string
  targetChapters?: number
}

interface Props {
  onOpenProjects: () => void
}

export default function BrainstormPage({ onOpenProjects }: Props): React.ReactElement {
  const [loaded] = useState(() => readBrainstormPageDraft())
  const [draft, setDraft] = useState(loaded.draft)
  const draftRef = useRef(draft)
  const [warning, setWarning] = useState(loaded.warning)
  const [storageError, setStorageError] = useState(false)
  const [brainstormBusy, setBrainstormBusy] = useState(false)
  const brainstormBusyRef = useRef(false)
  const [selectedDraft, setSelectedDraft] = useState<ProjectDraft | null>(null)
  const selectedDraftRef = useRef<ProjectDraft | null>(null)
  const [createdProject, setCreatedProject] = useState<ProjectMeta | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const locked = brainstormBusy || selectedDraft !== null
  const targetChapters = draft.targetChapters.trim() ? Number(draft.targetChapters) : undefined

  function updateDraft(patch: Partial<BrainstormPageDraft>): void {
    if (brainstormBusyRef.current || selectedDraftRef.current) return
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    allowBrainstormPageDraftWrite()
    const saved = writeBrainstormPageDraft(next)
    setStorageError(!saved)
    if (saved) setWarning('')
    setError('')
    setMessage('')
    setCreatedProject(null)
  }

  function adoptIdea(idea: LongStoryIdea): boolean {
    if (brainstormBusyRef.current || selectedDraftRef.current) return false
    const current = draftRef.current
    const chapters = current.targetChapters.trim() ? Number(current.targetChapters) : undefined
    if (chapters !== undefined && (!Number.isInteger(chapters) || chapters < 1 || chapters > 100000)) {
      setError('预计章数需在 1—100000 章之间，或留空。')
      return false
    }
    const selected = { name: idea.title, genre: current.genre.trim(), description: longStoryIdeaBrief(idea), targetChapters: chapters }
    selectedDraftRef.current = selected
    setSelectedDraft(selected)
    setError('')
    setMessage('')
    setCreatedProject(null)
    return true
  }

  function onCreated(project: ProjectMeta, notice: string): void {
    selectedDraftRef.current = null
    setSelectedDraft(null)
    setCreatedProject(project)
    setMessage(`《${project.name}》已创建，可在书案中查看。${notice ? ` ${notice}` : ''}`)
  }

  function onBusyChange(busy: boolean): void {
    brainstormBusyRef.current = busy
    setBrainstormBusy(busy)
  }

  function closeDialog(): void {
    selectedDraftRef.current = null
    setSelectedDraft(null)
  }

  return <div className="brainstorm-page">
    <div className="page-head">
      <div className="page-head-row">
        <div><h1>脑洞</h1><p className="desc">先收集长篇创意，找到喜欢的故事后再创建项目。</p></div>
        <button className="btn btn-ghost" type="button" disabled={selectedDraft !== null} onClick={onOpenProjects}>我的书案</button>
      </div>
    </div>

    <section className="card brainstorm-settings" aria-label="长篇构思条件">
      <div className="brainstorm-settings-grid">
        <div className="field">
          <label htmlFor="brainstorm-genre">题材（可选）</label>
          <input id="brainstorm-genre" className="input" maxLength={100} disabled={locked} value={draft.genre} placeholder="玄幻 / 都市 / 悬疑 / 言情…" onChange={event => updateDraft({ genre: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="brainstorm-chapters">预计章数（可选）</label>
          <input id="brainstorm-chapters" className="input" type="number" min={1} max={100000} step={1} disabled={locked} value={draft.targetChapters} placeholder="如 200，留空则自由构思" onChange={event => updateDraft({ targetChapters: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="brainstorm-reference">已有想法（可选）</label>
        <textarea id="brainstorm-reference" className="textarea" rows={3} maxLength={5000} disabled={locked} value={draft.sourceBrief} placeholder="可以从一句设定开始，也可以留空，让 AI 给出不同方向。" onChange={event => updateDraft({ sourceBrief: event.target.value })} />
      </div>
      <p className="muted brainstorm-settings-help">无需先填书名。生成、收藏和换批都可以在这里完成；采用后可修改书名与简介，再创建项目。</p>
    </section>

    {warning ? <p className="ss-brainstorm-notice" role="status">{warning}</p> : null}
    {storageError ? <p className="ss-brainstorm-notice ss-brainstorm-error" role="alert">构思条件未能保存，离开前请复制需要的输入。</p> : null}
    {error ? <p className="ss-brainstorm-notice ss-brainstorm-error" role="alert">{error}</p> : null}
    {message ? <div className="ss-brainstorm-notice ss-brainstorm-success" role="status"><span>{message}</span>{createdProject ? <button className="btn btn-sm" type="button" onClick={onOpenProjects}>去书案查看</button> : null}</div> : null}

    <LongStoryBrainstorm genre={draft.genre} targetChapters={targetChapters} sourceBrief={draft.sourceBrief} recoveryKey="new" disabled={selectedDraft !== null} onBusyChange={onBusyChange} onAdopt={adoptIdea} />

    {selectedDraft ? <NewProjectDialog key="adopted-brainstorm" initialDraft={selectedDraft} brainstormRecoveryKey="new" onClose={closeDialog} onCreated={onCreated} /> : null}
  </div>
}
