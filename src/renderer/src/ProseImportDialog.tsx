import { useEffect, useRef, useState } from 'react'
import type { ProseImportEncoding, ProseImportPreview, ProseImportResult } from '../../shared/prose-import'
import './prose-import.css'

export default function ProseImportDialog({ onClose, onImported }: {
  onClose: () => void
  onImported: (result: ProseImportResult) => void
}) {
  const [name, setName] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [encoding, setEncoding] = useState<ProseImportEncoding>('auto')
  const [preview, setPreview] = useState<ProseImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [result, setResult] = useState<ProseImportResult | null>(null)
  const lock = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !lock.current) closeRef.current()
      if (event.key !== 'Tab') return
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')
      if (!nodes?.length) { event.preventDefault(); return }
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      previous?.focus()
      void window.api.cancelProseImport().catch(() => undefined)
    }
  }, [])

  const choose = async (mode: 'files' | 'folder', typedPath = false) => {
    if (lock.current) return
    lock.current = true
    setBusy(true); setError(''); setPreview(null); setAcknowledged(false)
    try {
      const next = await window.api.previewProseImport({ mode, encoding, folderPath: typedPath ? folderPath : undefined })
      setPreview(next)
      if (next?.suggestedName && !name.trim()) setName(next.suggestedName)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; setBusy(false) }
  }

  const commit = async () => {
    if (lock.current || !preview || !name.trim()) return
    lock.current = true; setBusy(true); setError('')
    try { setResult(await window.api.commitProseImport(preview.token, name.trim())) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; setBusy(false) }
  }

  const hasWarnings = !!preview && (preview.issues.length > 0 || preview.missing.length > 0)
  return <div className="dialog-overlay">
    <div ref={dialogRef} tabIndex={-1} className="dialog prose-import-dialog" role="dialog" aria-modal="true" aria-labelledby="prose-import-title" aria-busy={busy}>
      <h3 id="prose-import-title">{result ? '正文已导入' : '导入正文'}</h3>
      <p className="meta">支持多个 TXT、Markdown 文件或正文文件夹。保留原文，按章号整理，保存为一本新小说。</p>
      {result ? <>
        <p role="status">《{result.project.name}》已导入 {result.importedCount} 章，可在书案打开。</p>
        <p className="meta prose-import-path">保存位置：{result.project.path}</p>
        {result.pendingCount > 0 && <p>仍有 {result.pendingCount} 项未处理问题，详见下方检查结果。源文件保留在原处。</p>}
      </> : <>
        <div className="field">
          <label htmlFor="prose-import-name">书名</label>
          <input id="prose-import-name" className="input" maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="输入这本小说的书名" />
        </div>
        <div className="field">
          <label htmlFor="prose-import-encoding">文本编码</label>
          <select id="prose-import-encoding" className="input" value={encoding} disabled={busy} onChange={e => { setEncoding(e.target.value as ProseImportEncoding); setPreview(null); void window.api.cancelProseImport() }}>
            <option value="auto">自动（UTF-8 / 带标记的 UTF-16）</option>
            <option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option>
            <option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option>
          </select>
        </div>
        <div className="prose-import-actions">
          <button className="btn" disabled={busy} onClick={() => void choose('files')}>选择正文文件（可多选）</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => void choose('folder')}>选择文件夹</button>
        </div>
        <div className="field">
          <label htmlFor="prose-import-folder">或粘贴正文文件夹路径</label>
          <div className="prose-import-actions">
            <input id="prose-import-folder" className="input" value={folderPath} disabled={busy} onChange={e => { setFolderPath(e.target.value); setPreview(null) }} placeholder="例如 E:\小说正文" />
            <button className="btn btn-ghost" disabled={busy || !folderPath.trim()} onClick={() => void choose('folder', true)}>读取文件夹</button>
          </div>
        </div>
      </>}
      {busy && <p role="status">正在处理正文，请稍候。</p>}
      {error && <p role="alert" className="prose-import-error">{error}</p>}
      {preview && <section aria-label="导入检查结果" className="prose-import-report">
        <p>检查 {preview.fileCount} 个文本文件，识别 {preview.detectedCount} 个章节片段，{result ? '已导入' : '可导入'} {preview.chapters.length} 章。</p>
        {preview.missing.length > 0 && <p className="prose-import-warning">章号范围内缺少：{preview.missing.join('、')}。保留空缺，不补写。</p>}
        {preview.duplicates.length > 0 && <details><summary>完全重复项（{preview.duplicates.length}）</summary><ul>{preview.duplicates.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
        {preview.issues.length > 0 && <details open><summary>未处理问题（{preview.issues.length}）</summary><ul>{preview.issues.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
        <details open><summary>章节与原文预览（{preview.chapters.length}）</summary>
          <div className="prose-import-chapters">{preview.chapters.map(c => <details key={c.number}>
            <summary>第{c.number}章 · {c.title}</summary>
            <p className="meta prose-import-path">来源：{c.source}</p><pre>{c.excerpt}</pre>
          </details>)}</div>
        </details>
        {!result && hasWarnings && <label className="prose-import-ack"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />只导入上方可导入章节，保留缺章和未解决项。</label>}
      </section>}
      <div className="prose-import-actions prose-import-footer">
        {result ? <button className="btn btn-primary" onClick={() => onImported(result)}>完成，返回书案</button> : <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !preview?.chapters.length || (hasWarnings && !acknowledged)} onClick={() => void commit()}>
            {busy ? '处理中…' : `导入${preview ? ` ${preview.chapters.length} 章` : ''}`}
          </button>
        </>}
      </div>
    </div>
  </div>
}
