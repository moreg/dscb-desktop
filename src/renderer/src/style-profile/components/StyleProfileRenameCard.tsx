interface Props {
  currentName: string
  draftName: string
  renaming: boolean
  onChangeDraft: (v: string) => void
  onRename: () => Promise<void>
}

/**
 * 编辑名称卡：行内 input + 更新按钮。只改名字（不进入完整编辑态）。
 */
export default function StyleProfileRenameCard({
  currentName,
  draftName,
  renaming,
  onChangeDraft,
  onRename
}: Props) {
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 className="sub" style={{ margin: 0 }}>编辑名称</h3>
        <span className="chip">{currentName}</span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          value={draftName}
          onChange={(e) => onChangeDraft(e.target.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button
          className="btn btn-ghost"
          onClick={() => void onRename()}
          disabled={renaming}
        >
          {renaming ? '保存中…' : '更新名称'}
        </button>
      </div>
    </div>
  )
}
