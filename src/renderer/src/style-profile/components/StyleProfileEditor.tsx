import type { StyleProfile } from '../../../../shared/types'
import EditableList from './EditableList'

interface Props {
  draft: StyleProfile
  saving: boolean
  message: string | null
  onChange: (next: StyleProfile) => void
  onSave: () => void
  onCancel: () => void
}

/**
 * 编辑态：name + identifiedStyle + 6 个画像字段 + 3 个约束栏 + stylePrompt，
 * 全部用 EditableList 或受控输入展示。
 */
export default function StyleProfileEditor({
  draft,
  saving,
  message,
  onChange,
  onSave,
  onCancel
}: Props) {
  const set = <K extends keyof StyleProfile>(key: K, value: StyleProfile[K]) => {
    onChange({ ...draft, [key]: value })
  }
  const setArray = (key: keyof StyleProfile, value: string[]) => {
    onChange({ ...draft, [key]: value as StyleProfile[typeof key] })
  }
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h3 className="sub" style={{ margin: 0 }}>编辑文风卡</h3>
        <span className="meta" style={{ marginLeft: 'auto' }}>
          创建于 {draft.createdAt.slice(0, 10)} · 更新于 {draft.updatedAt.slice(0, 10)}
        </span>
      </div>
      <p className="meta" style={{ marginTop: 0, fontSize: 12 }}>
        修改后点击「保存」会生成 patch（只提交改动字段）。取消则丢弃所有修改。
      </p>

      <div className="field">
        <label>文风名</label>
        <input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="field">
        <label>文风类型（一句话概括）</label>
        <input
          className="input"
          value={draft.identifiedStyle}
          onChange={(e) => set('identifiedStyle', e.target.value)}
          placeholder="如：冷峻都市第三人称"
        />
      </div>

      <EditableList
        title="句式特征"
        items={draft.sentencePatterns}
        onChange={(items) => setArray('sentencePatterns', items)}
        placeholder="如：短句推进"
      />
      <EditableList
        title="词汇偏好"
        items={draft.vocabularyPreferences}
        onChange={(items) => setArray('vocabularyPreferences', items)}
        placeholder="如：冷硬动词"
      />
      <EditableList
        title="标点与节奏"
        items={draft.punctuationAndRhythm}
        onChange={(items) => setArray('punctuationAndRhythm', items)}
        placeholder="如：顿号少，句号多"
      />
      <EditableList
        title="叙事视角"
        items={draft.narrativePerspective}
        onChange={(items) => setArray('narrativePerspective', items)}
        placeholder="如：第三人称近距离"
      />
      <EditableList
        title="语气"
        items={draft.tone}
        onChange={(items) => setArray('tone', items)}
        placeholder="如：克制"
      />
      <EditableList
        title="基础叙事模板"
        items={draft.narrativeTemplates}
        onChange={(items) => setArray('narrativeTemplates', items)}
        placeholder="如：冲突先行"
      />

      <section style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>约束（文风 / 人设 / 剧情）</strong>
        <p className="meta" style={{ marginTop: 6, fontSize: 12 }}>
          应做按归属分类：文风约束（跨题材复用） / 人设约束（与角色绑定） / 剧情约束（与本书设定绑定）。
        </p>
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          <EditableList
            title="文风约束"
            hint="跨题材复用"
            accent="var(--vermilion)"
            items={draft.styleConstraints}
            onChange={(items) => setArray('styleConstraints', items)}
            placeholder="如：保持现实质感"
          />
          <EditableList
            title="人设约束"
            hint="与主角/角色绑定"
            accent="#3b82f6"
            items={draft.characterConstraints}
            onChange={(items) => setArray('characterConstraints', items)}
            placeholder="如：保持主角冷静"
          />
          <EditableList
            title="剧情约束"
            hint="与本书题材/设定绑定"
            accent="#10b981"
            items={draft.plotConstraints}
            onChange={(items) => setArray('plotConstraints', items)}
            placeholder="如：避免金手指"
          />
        </div>
      </section>

      <div className="field" style={{ marginTop: 14 }}>
        <label>写作提示词摘要（注入到 system prompt）</label>
        <textarea
          className="textarea"
          rows={6}
          value={draft.stylePrompt}
          onChange={(e) => set('stylePrompt', e.target.value)}
        />
      </div>

      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          取消
        </button>
      </div>
      {message ? <p className="meta" style={{ marginTop: 10 }}>{message}</p> : null}
    </div>
  )
}
