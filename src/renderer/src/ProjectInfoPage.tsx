import { FormEvent, useEffect, useState } from 'react'

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
      setMessage('已保存，书架和灵感抽签将同步使用这份信息')
      onProjectUpdated?.(updated.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

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

        <aside className="project-info-tip">
          <span className="project-info-tip-icon" aria-hidden>🎲</span>
          <div>
            <strong>与灵感抽签同步</strong>
            <p>在“灵感抽签”点击“保存为项目书名与简介”，结果会自动写到这里。</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
