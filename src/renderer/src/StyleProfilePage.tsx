import { useEffect, useMemo, useState } from 'react'
import type {
  CreateStyleProfileInput,
  ProjectData,
  StyleAnalysisResult,
  StyleProfile
} from '../../shared/types'

interface Props {
  projectId: string
}

const EMPTY_ANALYSIS: StyleAnalysisResult = {
  identifiedStyle: '',
  sentencePatterns: [],
  vocabularyPreferences: [],
  punctuationAndRhythm: [],
  narrativePerspective: [],
  tone: [],
  narrativeTemplates: [],
  dos: [],
  donts: [],
  stylePrompt: ''
}

export default function StyleProfilePage({ projectId }: Props) {
  const [projectData, setProjectData] = useState<ProjectData | null>(null)
  const [profiles, setProfiles] = useState<StyleProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [sampleText, setSampleText] = useState('')
  const [analysis, setAnalysis] = useState<StyleAnalysisResult | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = () => {
    void window.api.getProject(projectId).then(setProjectData)
    void window.api.listStyleProfiles(projectId).then((items) => {
      setProfiles(items)
      setSelectedId((current) => current ?? items[0]?.id ?? null)
    })
  }

  useEffect(() => {
    refresh()
    setDraftName('')
    setSampleText('')
    setAnalysis(null)
    setMessage(null)
  }, [projectId])

  const selected = useMemo(
    () => profiles.find((item) => item.id === selectedId) ?? null,
    [profiles, selectedId]
  )

  const onExtract = async () => {
    setExtracting(true)
    setMessage(null)
    try {
      const result = await window.api.extractStyleProfile(
        projectId,
        sampleText,
        draftName.trim() || undefined
      )
      setAnalysis(result)
      setMessage('文风提取完成，可以保存为文风卡。')
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setExtracting(false)
    }
  }

  const onSave = async () => {
    if (!analysis) return
    setSaving(true)
    setMessage(null)
    try {
      const input: CreateStyleProfileInput = {
        name: draftName.trim() || `文风 ${profiles.length + 1}`,
        sourceType: 'sampleText',
        sampleText,
        ...analysis
      }
      const profile = await window.api.createStyleProfile(projectId, input)
      refresh()
      setSelectedId(profile.id)
      setDraftName('')
      setSampleText('')
      setAnalysis(null)
      setMessage('文风卡已保存。')
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const onRename = async () => {
    if (!selected || !draftName.trim()) return
    setRenaming(true)
    setMessage(null)
    try {
      const updated = await window.api.updateStyleProfile(projectId, selected.id, {
        name: draftName.trim()
      })
      refresh()
      setSelectedId(updated.id)
      setMessage('文风名已更新。')
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setRenaming(false)
    }
  }

  const onDelete = async (profile: StyleProfile) => {
    if (!window.confirm(`删除文风卡「${profile.name}」？`)) return
    await window.api.deleteStyleProfile(projectId, profile.id)
    refresh()
    setSelectedId((current) => (current === profile.id ? null : current))
  }

  const onSetDefault = async (styleProfileId: string | null) => {
    await window.api.setProjectDefaultStyleProfile(projectId, styleProfileId)
    refresh()
  }

  const preview = analysis ?? selected ?? EMPTY_ANALYSIS

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>文风</h1>
            <p className="desc">提取样文文风，保存为项目内可复用的文风卡，并设置项目默认文风。</p>
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: '0 0 320px', minWidth: 280 }}>
          <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
            <h3 className="sub" style={{ margin: 0 }}>文风卡</h3>
            <span className="meta" style={{ marginLeft: 'auto' }}>
              {profiles.length} 个
            </span>
          </div>
          {profiles.length === 0 ? (
            <div className="placeholder" style={{ padding: 12 }}>
              还没有文风卡。先在右侧粘贴样文做一次提取。
            </div>
          ) : (
            <ul className="bare" style={{ display: 'grid', gap: 10 }}>
              {profiles.map((profile) => {
                const isDefault = projectData?.defaultStyleProfileId === profile.id
                return (
                  <li
                    key={profile.id}
                    className="card card-hover"
                    style={{
                      padding: 12,
                      borderColor: selectedId === profile.id ? 'var(--vermilion)' : undefined
                    }}
                  >
                    <button
                      type="button"
                      className="link-btn"
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => {
                        setSelectedId(profile.id)
                        setDraftName(profile.name)
                        setAnalysis(null)
                      }}
                    >
                      <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                        <strong>{profile.name}</strong>
                        {isDefault ? <span className="chip chip-success">默认</span> : null}
                      </div>
                      <div className="meta" style={{ marginTop: 6 }}>{profile.identifiedStyle}</div>
                    </button>
                    <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => void onSetDefault(profile.id)}
                        disabled={isDefault}
                      >
                        设为默认
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => void onDelete(profile)}>
                        删除
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {projectData?.defaultStyleProfileId ? (
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 10 }}
              onClick={() => void onSetDefault(null)}
            >
              清空项目默认文风
            </button>
          ) : null}
        </div>

        <div style={{ flex: '1 1 640px', minWidth: 320, display: 'grid', gap: 16 }}>
          <div className="card">
            <h3 className="sub" style={{ marginTop: 0 }}>提取文风</h3>
            <div className="field">
              <label>文风名</label>
              <input
                className="input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="如：冷峻第一人称都市风 / 轻快吐槽古风"
              />
            </div>
            <div className="field">
              <label>样本文本</label>
              <textarea
                className="textarea"
                rows={12}
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder="粘贴 300-20000 字样文，系统会分析文风、句式、词汇、节奏、叙事视角与模板。"
              />
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={() => void onExtract()}
                disabled={extracting || !sampleText.trim()}
              >
                {extracting ? '提取中…' : '开始提取'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setDraftName('')
                  setSampleText('')
                  setAnalysis(null)
                  setMessage(null)
                }}
              >
                清空
              </button>
              {analysis ? (
                <button className="btn" onClick={() => void onSave()} disabled={saving}>
                  {saving ? '保存中…' : '保存为文风卡'}
                </button>
              ) : null}
            </div>
            {message ? <p className="meta" style={{ marginTop: 10 }}>{message}</p> : null}
          </div>

          {selected ? (
            <div className="card">
              <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h3 className="sub" style={{ margin: 0 }}>编辑名称</h3>
                <span className="chip">{selected.name}</span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  style={{ flex: 1, minWidth: 240 }}
                />
                <button className="btn btn-ghost" onClick={() => void onRename()} disabled={renaming}>
                  {renaming ? '保存中…' : '更新名称'}
                </button>
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
              <h3 className="sub" style={{ margin: 0 }}>
                {analysis ? '提取结果预览' : selected ? '文风卡详情' : '提取结果预览'}
              </h3>
              {selected && !analysis ? (
                <span className="meta" style={{ marginLeft: 'auto' }}>
                  创建于 {selected.createdAt.slice(0, 10)}
                </span>
              ) : null}
            </div>
            <StyleSection title="是什么文风" items={[preview.identifiedStyle].filter(Boolean)} />
            <StyleSection title="句式特征" items={preview.sentencePatterns} />
            <StyleSection title="词汇偏好" items={preview.vocabularyPreferences} />
            <StyleSection title="标点与节奏" items={preview.punctuationAndRhythm} />
            <StyleSection title="叙事视角与语气" items={[...preview.narrativePerspective, ...preview.tone]} />
            <StyleSection title="基础叙事模板" items={preview.narrativeTemplates} />
            <StyleSection title="应该做" items={preview.dos} />
            <StyleSection title="不要做" items={preview.donts} />
            <section style={{ marginTop: 14 }}>
              <strong style={{ fontSize: 13 }}>写作提示词摘要</strong>
              <pre
                className="body"
                style={{ whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 260, overflow: 'auto' }}
              >
                {preview.stylePrompt || '暂无'}
              </pre>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

function StyleSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {items.length === 0 ? (
        <p className="meta" style={{ marginTop: 6 }}>暂无</p>
      ) : (
        <ul className="bare" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {items.map((item) => (
            <li key={item} className="chip" style={{ width: 'fit-content', maxWidth: '100%' }}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
