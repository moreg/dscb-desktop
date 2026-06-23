import type { StyleAnalysisResult } from '../../../../shared/types'

interface Props {
  state: {
    draftName: string
    sampleText: string
    selectedFileNames: string[]
    analysis: StyleAnalysisResult | null
    extracting: boolean
    saving: boolean
    message: string | null
  }
  actions: {
    setDraftName: (v: string) => void
    setSampleText: (v: string) => void
    clearFileSelection: () => void
    onSelectFile: () => Promise<void>
    onExtract: () => Promise<void>
    onSave: () => Promise<void>
    onClear: () => void
  }
}

export default function StyleProfileExtractCard({ state, actions }: Props) {
  return (
    <div className="card">
      <h3 className="sub" style={{ marginTop: 0 }}>提取文风</h3>
      <div className="field">
        <label>文风名</label>
        <input
          className="input"
          value={state.draftName}
          onChange={(e) => actions.setDraftName(e.target.value)}
          placeholder="如：冷峻第一人称都市风 / 轻快吐槽古风"
        />
      </div>
      <div className="field">
        <label>样本文本</label>
        <textarea
          className="textarea"
          rows={12}
          value={state.sampleText}
          onChange={(e) => {
            actions.setSampleText(e.target.value)
            if (state.selectedFileNames.length > 0) actions.clearFileSelection()
          }}
          placeholder="粘贴 300-20000 字样文，或点击“从文件导入”选择本地 .txt/.md 文件。现在支持多选。"
        />
        {state.selectedFileNames.length > 0 ? (
          <div className="meta" style={{ marginTop: 6 }}>
            <div>[文件] 已导入 {state.selectedFileNames.length} 个文件</div>
            <div style={{ marginTop: 4, whiteSpace: 'normal' }}>
              {state.selectedFileNames.join('、')}
            </div>
          </div>
        ) : null}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-ghost"
          onClick={() => void actions.onSelectFile()}
          disabled={state.extracting}
        >
          [目录] 从文件导入
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void actions.onExtract()}
          disabled={state.extracting || !state.sampleText.trim()}
        >
          {state.extracting ? '提取中…' : '开始提取'}
        </button>
        <button className="btn btn-ghost" onClick={actions.onClear}>
          清空
        </button>
        {state.analysis ? (
          <button className="btn" onClick={() => void actions.onSave()} disabled={state.saving}>
            {state.saving ? '保存中…' : '保存为文风卡'}
          </button>
        ) : null}
      </div>
      {state.message ? <p className="meta" style={{ marginTop: 10 }}>{state.message}</p> : null}
    </div>
  )
}
