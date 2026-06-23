import { useEffect, useMemo, useState } from 'react'
import type {
  CreateStyleProfileInput,
  ProjectData,
  StyleAnalysisResult,
  StyleProfile,
  UpdateStyleProfileInput
} from '../../../../shared/types'
import { EMPTY_ANALYSIS } from '../lib/empty'
import { diffStyleProfile } from '../lib/diff'

export interface ConfirmDialogState {
  title: string
  message: string
  onConfirm: () => void
}

export interface UseStyleProfileController {
  projectData: ProjectData | null
  profiles: StyleProfile[]
  selectedId: string | null
  selected: StyleProfile | null
  draftName: string
  sampleText: string
  analysis: StyleAnalysisResult | null
  extracting: boolean
  saving: boolean
  renaming: boolean
  message: string | null
  selectedFileNames: string[]
  editingDraft: StyleProfile | null
  savingEdit: boolean
  preview: StyleAnalysisResult
  confirmDialog: ConfirmDialogState | null
  refresh: () => void
  setSelectedId: (id: string | null) => void
  setDraftName: (v: string) => void
  setSampleText: (v: string) => void
  setAnalysis: (v: StyleAnalysisResult | null) => void
  setMessage: (v: string | null) => void
  clearFileSelection: () => void
  onSelectFile: () => Promise<void>
  onExtract: () => Promise<void>
  onSave: () => Promise<void>
  onRename: () => Promise<void>
  onDelete: (profile: StyleProfile) => Promise<void>
  onSetDefault: (styleProfileId: string | null) => Promise<void>
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => Promise<void>
  setEditingDraft: (next: StyleProfile | null) => void
  closeConfirmDialog: () => void
}

export function useStyleProfileController(projectId: string): UseStyleProfileController {
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
  const [selectedFileNames, setSelectedFileNames] = useState<string[]>([])
  const [editingDraft, setEditingDraft] = useState<StyleProfile | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)

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
    setSelectedFileNames([])
    setEditingDraft(null)
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

  const onSelectFile = async () => {
    setMessage(null)
    try {
      const files = await window.api.selectTextFile()
      if (!files || files.length === 0) return

      const mergedContent = files.map((file) => file.content.trim()).filter(Boolean).join('\n\n')
      setSampleText(mergedContent)
      setSelectedFileNames(files.map((file) => file.fileName))

      const totalChars = mergedContent.length
      const namesPreview = files.map((file) => `《${file.fileName}》`).join('、')
      setMessage(`已导入 ${files.length} 个文件：${namesPreview}（合计 ${totalChars} 字）`)
    } catch (err) {
      setMessage(`导入失败：${(err as Error).message}`)
    }
  }

  const clearFileSelection = () => setSelectedFileNames([])

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
      setSelectedFileNames([])
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
    setConfirmDialog({
      title: '删除文风卡',
      message: `确定删除「${profile.name}」？删除后无法恢复。`,
      onConfirm: async () => {
        await window.api.deleteStyleProfile(projectId, profile.id)
        refresh()
        setSelectedId((current) => (current === profile.id ? null : current))
        setConfirmDialog(null)
      }
    })
  }

  const closeConfirmDialog = () => setConfirmDialog(null)

  const onSetDefault = async (styleProfileId: string | null) => {
    await window.api.setProjectDefaultStyleProfile(projectId, styleProfileId)
    refresh()
  }

  const onStartEdit = () => {
    if (!selected) return
    const normalized: StyleProfile = {
      ...selected,
      sentencePatterns: selected.sentencePatterns ?? [],
      vocabularyPreferences: selected.vocabularyPreferences ?? [],
      punctuationAndRhythm: selected.punctuationAndRhythm ?? [],
      narrativePerspective: selected.narrativePerspective ?? [],
      tone: selected.tone ?? [],
      narrativeTemplates: selected.narrativeTemplates ?? [],
      styleConstraints: selected.styleConstraints ?? [],
      characterConstraints: selected.characterConstraints ?? [],
      plotConstraints: selected.plotConstraints ?? [],
      identifiedStyle: selected.identifiedStyle ?? '',
      stylePrompt: selected.stylePrompt ?? ''
    }
    setEditingDraft(normalized)
    setMessage(null)
  }

  const onCancelEdit = () => {
    setEditingDraft(null)
    setMessage(null)
  }

  const onSaveEdit = async () => {
    if (!editingDraft) return
    setSavingEdit(true)
    setMessage(null)
    try {
      const patch: UpdateStyleProfileInput = diffStyleProfile(editingDraft, profiles)
      if (Object.keys(patch).length === 0) {
        setMessage('没有改动。')
        setEditingDraft(null)
        return
      }
      const updated = await window.api.updateStyleProfile(projectId, editingDraft.id, patch)
      refresh()
      setSelectedId(updated.id)
      setEditingDraft(null)
      setMessage('文风卡已更新。')
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setSavingEdit(false)
    }
  }

  const preview = analysis ?? selected ?? EMPTY_ANALYSIS

  return {
    projectData,
    profiles,
    selectedId,
    selected,
    draftName,
    sampleText,
    analysis,
    extracting,
    saving,
    renaming,
    message,
    selectedFileNames,
    editingDraft,
    savingEdit,
    preview,
    confirmDialog,
    refresh,
    setSelectedId,
    setDraftName,
    setSampleText,
    setAnalysis,
    setMessage,
    clearFileSelection,
    onSelectFile,
    onExtract,
    onSave,
    onRename,
    onDelete,
    onSetDefault,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    setEditingDraft,
    closeConfirmDialog
  }
}
