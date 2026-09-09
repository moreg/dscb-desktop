import { useEffect, useState, useCallback } from 'react'
import type { ChapterVersion, ChapterSource } from '../../shared/types'

interface Props {
  projectId: string
  chapterNumber: number
  chapterTitle: string
  currentDraft: string
  isOpen: boolean
  onClose: () => void
  onRollback: (version: ChapterVersion) => Promise<void>
}

export default function ChapterVersionsDialog({
  projectId,
  chapterNumber,
  chapterTitle,
  currentDraft,
  isOpen,
  onClose,
  onRollback
}: Props) {
  const [versions, setVersions] = useState<ChapterVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<ChapterVersion | null>(null)
  const [rollingBack, setRollingBack] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [noteInput, setNoteInput] = useState('')
  const [sourceInput, setSourceInput] = useState<ChapterSource>('manual')

  const fetchVersions = useCallback(async () => {
    if (!isOpen) return
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.listChapterVersions(projectId, chapterNumber)
      // 保证倒序排列（版本号由大到小，最新在最上）
      const sorted = [...list].sort((a, b) => b.versionNumber - a.versionNumber)
      setVersions(sorted)
      // 默认选中最新版本（若未选或之前选中的已不存在）
      if (sorted.length > 0) {
        setSelectedVersion((prev) => {
          if (!prev) return sorted[0]
          const stillExists = sorted.find((v) => v.versionNumber === prev.versionNumber)
          return stillExists ?? sorted[0]
        })
      } else {
        setSelectedVersion(null)
      }
    } catch (err) {
      setError((err as Error).message || '获取历史版本失败')
    } finally {
      setLoading(false)
    }
  }, [isOpen, projectId, chapterNumber])

  useEffect(() => {
    if (isOpen) {
      void fetchVersions()
    }
  }, [isOpen, fetchVersions])

  if (!isOpen) return null

  const handleCreateSnapshot = async () => {
    if (!currentDraft.trim()) {
      alert('当前正文为空，无法存为版本')
      return
    }
    setCreating(true)
    try {
      await window.api.createChapterVersion(projectId, chapterNumber, {
        source: sourceInput,
        content: currentDraft,
        note: noteInput.trim() || undefined
      })
      setNoteInput('')
      setShowCreateForm(false)
      await fetchVersions()
    } catch (err) {
      alert(`存为版本失败：${(err as Error).message}`)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (v: ChapterVersion) => {
    if (!window.confirm(`确定删除版本 #${v.versionNumber} 吗？`)) return
    try {
      await window.api.deleteChapterVersion(projectId, chapterNumber, v.versionNumber)
      await fetchVersions()
    } catch (err) {
      alert(`删除版本失败：${(err as Error).message}`)
    }
  }

  const handleRollbackConfirm = async (v: ChapterVersion) => {
    const confirmMsg = `确定要将第 ${chapterNumber} 章的正文恢复到版本 #${v.versionNumber}（${v.wordCount} 字）吗？\n当前正文将被覆盖并自动留存为新版本。`
    if (!window.confirm(confirmMsg)) return
    setRollingBack(true)
    try {
      await onRollback(v)
      onClose()
    } catch (err) {
      alert(`恢复失败：${(err as Error).message}`)
    } finally {
      setRollingBack(false)
    }
  }

  const sourceBadge = (source: ChapterSource) => {
    switch (source) {
      case 'ai':
        return { label: 'AI 生成', bg: 'rgba(147, 51, 234, 0.12)', color: '#7c3aed', border: 'rgba(147, 51, 234, 0.3)' }
      case 'reviewed':
        return { label: '审核润色', bg: 'rgba(16, 185, 129, 0.12)', color: '#059669', border: 'rgba(16, 185, 129, 0.3)' }
      case 'manual':
      default:
        return { label: '手动保存', bg: 'rgba(100, 116, 139, 0.12)', color: '#475569', border: 'rgba(100, 116, 139, 0.3)' }
    }
  }

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    } catch {
      return iso
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose} style={{ zIndex: 10000 }}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 860,
          maxWidth: '95vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 24,
          background: 'var(--surface-2, #ffffff)',
          color: 'var(--ink, #1e293b)'
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0, padding: 0, border: 'none', fontSize: 18 }}>
              📜 正文历史版本 · 第 {chapterNumber} 章 {chapterTitle ? `《${chapterTitle}》` : ''}
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--ink-3, #64748b)' }}>
              保留最近 5 个历史版本，版本倒序排序。支持在线预览正文，并可随时一键恢复。
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={() => setShowCreateForm((s) => !s)}
              style={{ fontSize: 12 }}
              title="将当前编辑器里的未保存/已保存正文保存为独立版本快照"
            >
              {showCreateForm ? '收起存快照' : '+ 存为新版本'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ fontSize: 16, lineHeight: 1 }}>
              ✕
            </button>
          </div>
        </div>

        {/* 手动存快照折叠表单 */}
        {showCreateForm ? (
          <div
            style={{
              background: 'var(--surface, #f8fafc)',
              border: '1px solid var(--line, #e2e8f0)',
              borderRadius: 'var(--r-md, 8px)',
              padding: 12,
              marginBottom: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: 'var(--ink-2, #475569)', whiteSpace: 'nowrap' }}>
                版本类型：
              </label>
              <select
                className="select"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value as ChapterSource)}
                style={{ padding: '3px 8px', fontSize: 12 }}
              >
                <option value="manual">手动保存</option>
                <option value="ai">AI 生成</option>
                <option value="reviewed">审核润色</option>
              </select>
              <input
                type="text"
                placeholder="版本备注（选填，如：大改前备份 / 终稿草稿）"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  fontSize: 12,
                  borderRadius: 'var(--r-sm, 4px)',
                  border: '1px solid var(--line, #cbd5e1)',
                  background: 'var(--surface-2, #fff)'
                }}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleCreateSnapshot()}
                disabled={creating}
              >
                {creating ? '保存中…' : '立即保存'}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3, #94a3b8)' }}>
              将当前编辑器内的正文（{currentDraft.replace(/\s/g, '').length} 字）保存为新版本，最多保留 5 个最新版本。
            </div>
          </div>
        ) : null}

        {/* 主体区域：左右分栏（左侧版本倒序列表，右侧预览与恢复） */}
        <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 380, maxHeight: '60vh', overflow: 'hidden' }}>
          {/* 左侧：版本列表（倒序） */}
          <div
            style={{
              width: 310,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid var(--line, #e2e8f0)',
              paddingRight: 12,
              overflowY: 'auto'
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2, #475569)', marginBottom: 8 }}>
              版本列表（{versions.length} / 5，倒序）：
            </div>

            {loading ? (
              <p style={{ color: 'var(--ink-3, #94a3b8)', fontSize: 13, margin: '20px 0' }}>加载历史版本中…</p>
            ) : error ? (
              <p style={{ color: '#ef4444', fontSize: 12.5 }}>{error}</p>
            ) : versions.length === 0 ? (
              <div style={{ color: 'var(--ink-3, #94a3b8)', fontSize: 12.5, padding: '24px 8px', textAlign: 'center' }}>
                暂无历史版本记录。
                <div style={{ marginTop: 8 }}>正文每次保存均会自动生成版本，亦可点击右上角「+ 存为新版本」手动快照。</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {versions.map((v, index) => {
                  const isSelected = selectedVersion?.versionNumber === v.versionNumber
                  const badge = sourceBadge(v.source)
                  return (
                    <div
                      key={v.versionNumber}
                      onClick={() => setSelectedVersion(v)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 'var(--r-md, 6px)',
                        border: isSelected ? '1.5px solid var(--primary, #3b82f6)' : '1px solid var(--line, #e2e8f0)',
                        background: isSelected ? 'rgba(59, 130, 246, 0.05)' : 'var(--surface, #f8fafc)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <strong style={{ fontSize: 13, color: isSelected ? 'var(--primary, #2563eb)' : 'inherit' }}>
                            #{v.versionNumber}
                          </strong>
                          {index === 0 ? (
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 4px',
                                borderRadius: 3,
                                background: 'rgba(239, 68, 68, 0.1)',
                                color: '#ef4444',
                                fontWeight: 600
                              }}
                            >
                              最新
                            </span>
                          ) : null}
                          <span
                            style={{
                              fontSize: 10.5,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: badge.bg,
                              color: badge.color,
                              border: `1px solid ${badge.border}`
                            }}
                          >
                            {badge.label}
                          </span>
                        </div>
                        <span style={{ fontSize: 11.5, color: 'var(--ink-3, #64748b)' }}>{v.wordCount} 字</span>
                      </div>

                      <div style={{ fontSize: 11, color: 'var(--ink-3, #94a3b8)', marginTop: 4 }}>
                        {formatTime(v.createdAt)}
                      </div>

                      {v.note ? (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: 'var(--ink-2, #475569)',
                            marginTop: 4,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                          title={v.note}
                        >
                          💬 {v.note}
                        </div>
                      ) : null}

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
                        <button
                          className="btn btn-sm btn-ghost"
                          style={{ fontSize: 11, padding: '2px 6px' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedVersion(v)
                          }}
                        >
                          查看
                        </button>
                        <button
                          className="btn btn-sm btn-primary"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleRollbackConfirm(v)
                          }}
                          disabled={rollingBack}
                          title="把编辑器正文恢复为此版本的内容"
                        >
                          恢复
                        </button>
                        <button
                          className="btn btn-sm btn-ghost"
                          style={{ fontSize: 11, padding: '2px 4px', color: '#94a3b8' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleDelete(v)
                          }}
                          title="删除该版本"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 右侧：版本正文预览与一键恢复 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {selectedVersion ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                    paddingBottom: 8,
                    borderBottom: '1px solid var(--line, #e2e8f0)'
                  }}
                >
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>
                      版本 #{selectedVersion.versionNumber} 预览
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--ink-3, #64748b)', marginLeft: 8 }}>
                      （{selectedVersion.wordCount} 字 · {formatTime(selectedVersion.createdAt)}）
                    </span>
                    {selectedVersion.note ? (
                      <span style={{ fontSize: 12, color: 'var(--ink-2, #475569)', marginLeft: 8 }}>
                        · 备注：{selectedVersion.note}
                      </span>
                    ) : null}
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleRollbackConfirm(selectedVersion)}
                    disabled={rollingBack}
                    style={{ fontSize: 12.5, fontWeight: 600 }}
                  >
                    {rollingBack ? '恢复中…' : `↶ 恢复为正文（版本 #${selectedVersion.versionNumber}）`}
                  </button>
                </div>

                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: 12,
                    background: 'var(--surface, #f8fafc)',
                    border: '1px solid var(--line, #e2e8f0)',
                    borderRadius: 'var(--r-md, 6px)',
                    fontFamily: 'var(--font-editor, inherit)',
                    fontSize: 14,
                    lineHeight: 1.8,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--ink, #334155)'
                  }}
                >
                  {selectedVersion.content || '（此版本正文为空）'}
                </div>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ink-3, #94a3b8)',
                  fontSize: 13
                }}
              >
                请在左侧选择一个版本进行预览和恢复
              </div>
            )}
          </div>
        </div>

        {/* 底部信息与关闭按钮 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 16,
            paddingTop: 12,
            borderTop: '1px solid var(--line, #e2e8f0)',
            fontSize: 12,
            color: 'var(--ink-3, #64748b)'
          }}
        >
          <div>
            💡 提示：恢复版本后，当前正文会被覆盖并自动备份。版本历史会自动保留最新的 5 个版本。
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
