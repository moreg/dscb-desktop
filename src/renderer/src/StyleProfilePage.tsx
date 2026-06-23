import { useStyleProfileController } from './style-profile/hooks/useStyleProfileController'
import StyleProfileSidebar from './style-profile/components/StyleProfileSidebar'
import StyleProfileExtractCard from './style-profile/components/StyleProfileExtractCard'
import StyleProfileRenameCard from './style-profile/components/StyleProfileRenameCard'
import StyleProfilePreview from './style-profile/components/StyleProfilePreview'
import StyleProfileEditor from './style-profile/components/StyleProfileEditor'
import ConfirmDialog from './style-profile/components/ConfirmDialog'

interface Props {
  projectId: string
}

export default function StyleProfilePage({ projectId }: Props) {
  const c = useStyleProfileController(projectId)

  /** 选中文风卡：清空输入态 / 编辑态，并把名字填到 draftName 用于"编辑名称" */
  const handleSelect = (id: string) => {
    const target = c.profiles.find((p) => p.id === id)
    c.setSelectedId(id)
    c.setDraftName(target?.name ?? '')
    c.setAnalysis(null)
    c.setEditingDraft(null)
  }

  /** 进入编辑态：选中并把选中 profile 复制到 draft */
  const handleStartEdit = (id: string) => {
    handleSelect(id)
    c.onStartEdit()
  }

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
        <StyleProfileSidebar
          profiles={c.profiles}
          projectData={c.projectData}
          selectedId={c.selectedId}
          onSelect={handleSelect}
          onSetDefault={c.onSetDefault}
          onStartEdit={handleStartEdit}
          onDelete={c.onDelete}
        />

        <div style={{ flex: '1 1 640px', minWidth: 320, display: 'grid', gap: 16 }}>
          {c.editingDraft ? (
            <StyleProfileEditor
              draft={c.editingDraft}
              saving={c.savingEdit}
              message={c.message}
              onChange={c.setEditingDraft}
              onSave={() => void c.onSaveEdit()}
              onCancel={c.onCancelEdit}
            />
          ) : (
            <>
              <StyleProfileExtractCard
                state={{
                  draftName: c.draftName,
                  sampleText: c.sampleText,
                  selectedFileNames: c.selectedFileNames,
                  analysis: c.analysis,
                  extracting: c.extracting,
                  saving: c.saving,
                  message: c.message
                }}
                actions={{
                  setDraftName: c.setDraftName,
                  setSampleText: c.setSampleText,
                  clearFileSelection: c.clearFileSelection,
                  onSelectFile: c.onSelectFile,
                  onExtract: c.onExtract,
                  onSave: c.onSave,
                  onClear: () => {
                    c.setDraftName('')
                    c.setSampleText('')
                    c.setAnalysis(null)
                    c.setMessage(null)
                    c.clearFileSelection()
                  }
                }}
              />
              {c.selected ? (
                <StyleProfileRenameCard
                  currentName={c.selected.name}
                  draftName={c.draftName}
                  renaming={c.renaming}
                  onChangeDraft={c.setDraftName}
                  onRename={c.onRename}
                />
              ) : null}
              <StyleProfilePreview
                preview={c.preview}
                selected={c.selected}
                hasAnalysis={c.analysis !== null}
              />
            </>
          )}
        </div>
      </div>
      {c.confirmDialog ? (
        <ConfirmDialog state={c.confirmDialog} onClose={c.closeConfirmDialog} />
      ) : null}
    </div>
  )
}
