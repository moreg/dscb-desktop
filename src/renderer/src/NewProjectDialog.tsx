import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '../../shared/types'
import type { FanqieIdeaOpeningChapter } from '../../shared/fanqie-chart'
import { copyLongStoryBrainstormRecovery } from './long-story-brainstorm-library'
import { isWebClient } from './web-download'
import './long-story-project.css'

export interface NewProjectDraft {
  name: string
  genre: string
  description: string
  targetChapters?: number
  openingChapters?: FanqieIdeaOpeningChapter[]
  ideaDevelopment?: string
}
interface Props {
  initialDraft?: NewProjectDraft
  brainstormRecoveryKey?: string
  onClose: () => void
  onCreated: (project: ProjectMeta, notice: string) => void
}

export default function NewProjectDialog({ initialDraft, brainstormRecoveryKey, onClose, onCreated }: Props) {
  const [name, setName] = useState(() => initialDraft?.name ?? '')
  const [genre, setGenre] = useState(() => initialDraft?.genre ?? '')
  const [description, setDescription] = useState(() => initialDraft?.description ?? '')
  const [targetChapters, setTargetChapters] = useState(() => initialDraft?.targetChapters !== undefined ? String(initialDraft.targetChapters) : '')
  const [customPath, setCustomPath] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [selecting, setSelecting] = useState(false)
  const selectingRef = useRef(false)
  const mountedRef = useRef(true)
  const [error, setError] = useState('')
  const locked = saving || selecting
  const chapterCount = targetChapters.trim() ? Number(targetChapters) : undefined

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const close = () => {
    if (mountedRef.current && !savingRef.current && !selectingRef.current) onClose()
  }

  const selectPath = async () => {
    if (!mountedRef.current || savingRef.current || selectingRef.current) return
    selectingRef.current = true
    setSelecting(true)
    setError('')
    try {
      const selected = await window.api.selectDirectory()
      if (mountedRef.current && selected) setCustomPath(selected)
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      selectingRef.current = false
      if (mountedRef.current) setSelecting(false)
    }
  }

  const submit = async () => {
    if (!mountedRef.current || savingRef.current || selectingRef.current || locked || !name.trim()) return
    if (chapterCount !== undefined && (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 100000)) {
      setError('预计章数需在 1—100000 章之间，或留空。')
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const project = await window.api.createProject({
        name: name.trim(),
        genre: genre.trim() || undefined,
        description: description.trim() || undefined,
        targetChapters: chapterCount,
        customPath: customPath.trim() || undefined,
        openingChapters: initialDraft?.openingChapters,
        ideaDevelopment: initialDraft?.ideaDevelopment
      })
      const copied = !brainstormRecoveryKey || copyLongStoryBrainstormRecovery(brainstormRecoveryKey, `project:${project.id}`)
      if (mountedRef.current) onCreated(project, copied ? '' : '项目已创建。脑洞记录仍保留在脑洞栏目中。')
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <div className="dialog-overlay" onClick={close}>
      <div className="dialog long-project-dialog" role="dialog" aria-modal="true" aria-labelledby="long-project-dialog-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="long-project-dialog-title">新建项目</h3>
        <p className="meta">先保存项目信息和脑洞简介，开始写作时再添加大纲与设定。</p>
        {initialDraft?.openingChapters?.length ? (
          <details>
            <summary>将一起保存的前三章写作方向</summary>
            {initialDraft.openingChapters.map(chapter => <p key={chapter.chapter} className="meta">第{chapter.chapter}章：{chapter.openingEvent} · {chapter.protagonistAction} · {chapter.payoff} · 章末：{chapter.endHook}</p>)}
            <p className="meta">补充正式设定和大纲后，生成前三章细纲时会自动使用这些方向。</p>
          </details>
        ) : null}
        <div className="field">
          <label>名称 *</label>
          <input
            className="input"
            maxLength={255}
            disabled={locked}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="《九霄剑尊》"
            autoFocus
          />
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>题材</label>
            <input
              className="input"
              maxLength={100}
              disabled={locked}
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              placeholder="玄幻 / 都市 / 科幻…"
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>预计章数</label>
            <input
              className="input"
              type="number"
              min={1}
              max={100000}
              step={1}
              disabled={locked}
              value={targetChapters}
              onChange={(e) => setTargetChapters(e.target.value)}
              placeholder="如 200"
            />
          </div>
        </div>
        <div className="field">
          <label>简介</label>
          <textarea
            className="textarea"
            maxLength={5000}
            disabled={locked}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="一句话概括故事 / 卖点"
          />
        </div>
        {isWebClient() ? null : <div className="field">
          <label>保存位置（可选）</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="默认位置"
              style={{ flex: 1 }}
              readOnly
            />
            <button
              className="btn btn-ghost btn-sm"
              onClick={selectPath}
              disabled={selecting || locked}
              style={{ whiteSpace: 'nowrap' }}
            >
              {selecting ? '…' : '选择'}
            </button>
          </div>
          {customPath ? (
            <p className="meta" style={{ marginTop: 4 }}>
              将保存到：{customPath}
            </p>
          ) : null}
        </div>}
        {error ? <p className="project-info-error" role="alert">{error}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={close} disabled={locked}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={locked || !name.trim()}>
            {saving ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

