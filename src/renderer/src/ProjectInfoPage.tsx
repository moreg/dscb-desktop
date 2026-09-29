import { FormEvent, useEffect, useState } from 'react'
import FanqieTagPanel from './FanqieTagPanel'
import type { ProjectTitleCandidate } from '../../shared/types'

interface Props {
  projectId: string
  onProjectUpdated?: (name: string) => void
}

export default function ProjectInfoPage({ projectId, onProjectUpdated }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [initialName, setInitialName] = useState('')
  const [initialDescription, setInitialDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<ProjectTitleCandidate[]>([])
  const [removingId, setRemovingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void window.api
      .getProject(projectId)
      .then((project) => {
        if (cancelled) return
        const nextName = project.name ?? ''
        const nextDescription = project.description ?? ''
        setName(nextName)
        setDescription(nextDescription)
        setInitialName(nextName)
        setInitialDescription(nextDescription)
        setCandidates(project.titleCandidates ?? [])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const dirty = name.trim() !== initialName || description.trim() !== initialDescription

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const nextName = name.trim()
    const nextDescription = description.trim()
    if (!nextName) {
      setError('小说名称不能为空')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const updated = await window.api.updateProjectInfo(projectId, {
        name: nextName,
        description: nextDescription || undefined
      })
      setName(updated.name)
      setDescription(updated.description ?? '')
      setInitialName(updated.name)
      setInitialDescription(updated.description ?? '')
      setMessage(
        updated.name === nextName
          ? '已保存。书架和本地文件夹都会使用这个名称'
          : `已保存。不能放进文件夹名的符号已换成全角，文件夹名为「${updated.name}」`
      )
      onProjectUpdated?.(updated.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const applyCandidate = (candidate: ProjectTitleCandidate) => {
    setName(candidate.name)
    setDescription(candidate.description)
    setError('')
    setMessage('已填入候选，确认后点击“保存作品信息”生效')
  }

  const removeCandidate = async (candidate: ProjectTitleCandidate) => {
    setRemovingId(candidate.id)
    setError('')
    try {
      setCandidates(await window.api.removeTitleCandidate(projectId, candidate.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemovingId(null)
    }
  }

  const isCurrent = (candidate: ProjectTitleCandidate) =>
    candidate.name === name.trim() && candidate.description === description.trim()

  if (loading) return <p className="empty">正在读取作品信息…</p>

  return (
    <div className="project-info-page">
      <div className="page-head">
        <h1>作品信息</h1>
        <p className="desc">管理这本小说对外展示的名称与简介</p>
      </div>

      <div className="project-info-layout">
        <form className="card project-info-form" onSubmit={(event) => void save(event)}>
          <div className="field">
            <label htmlFor="project-name">小说名称</label>
            <input
              id="project-name"
              className="input project-info-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setMessage('')
              }}
              maxLength={255}
              placeholder="请输入小说名称"
              autoFocus
            />
            <div className="project-info-count">{name.length}/255</div>
          </div>

          <div className="field">
            <label htmlFor="project-description">作品简介</label>
            <textarea
              id="project-description"
              className="textarea project-info-description"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
                setMessage('')
              }}
              maxLength={5000}
              rows={12}
              placeholder="可以手动填写，也可以在“灵感抽签”中生成后保存到项目"
            />
            <div className="project-info-count">{description.length}/5000</div>
          </div>

          {error ? <div className="project-info-error" role="alert">{error}</div> : null}
          {message ? <div className="project-info-success" role="status">✓ {message}</div> : null}

          <div className="project-info-actions">
            <span className="muted">灵感抽签保存后，再进入此页面即可查看和修改。</span>
            <button className="btn btn-primary" type="submit" disabled={saving || !dirty}>
              {saving ? '保存中…' : dirty ? '保存作品信息' : '已保存'}
            </button>
          </div>
        </form>

        <aside className="project-info-side">
          <div className="project-info-tip">
            <span className="project-info-tip-icon" aria-hidden>🎲</span>
            <div>
              <strong>与灵感抽签同步</strong>
              <p>在“灵感抽签”点击“保存为项目书名与简介”会直接写到这里；点击“加入候选”则先收进下方候选列表。</p>
            </div>
          </div>

          <section className="project-info-candidates">
            <h2>候选书名与简介{candidates.length ? ` · ${candidates.length}` : ''}</h2>
            {candidates.length === 0 ? (
              <p className="muted">暂无候选。在灵感抽签里遇到喜欢的方案，点“加入候选”即可收藏。</p>
            ) : (
              candidates.map((candidate) => (
                <article
                  key={candidate.id}
                  className={`project-info-candidate ${isCurrent(candidate) ? 'is-current' : ''}`}
                >
                  <h3>《{candidate.name}》</h3>
                  {candidate.seed ? <span className="project-info-candidate-seed">{candidate.seed}</span> : null}
                  <p title={candidate.description}>{candidate.description}</p>
                  <div className="project-info-candidate-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void removeCandidate(candidate)}
                      disabled={removingId !== null}
                    >
                      {removingId === candidate.id ? '移除中…' : '移除'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => applyCandidate(candidate)}
                      disabled={isCurrent(candidate)}
                    >
                      {isCurrent(candidate) ? '当前使用' : '使用这个'}
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>
        </aside>
      </div>

      <FanqieTagPanel projectId={projectId} name={name} description={description} />
    </div>
  )
}
