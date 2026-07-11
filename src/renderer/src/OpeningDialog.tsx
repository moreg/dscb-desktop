import { useState, useEffect, useRef } from 'react'

interface Props {
  projectId: string
  onClose: () => void
  onCompleted: () => void
}

type Step = 'brain' | 'settings' | 'volume' | 'chapters' | 'done'

const STEP_LABELS: Record<Step, string> = {
  brain: '1 · 脑洞',
  settings: '2 · 核心设定',
  volume: '3 · 卷级大纲',
  chapters: '4 · 前 N 章细纲',
  done: '完成'
}

function friendlyError(err: string): string {
  const map: Record<string, string> = {
    LLM_NOT_CONFIGURED: '请先在设置中配置大模型 API Key',
    LLM_AUTH_FAILED: 'API Key 无效或认证失败，请检查设置',
    LLM_RATE_LIMIT: '请求过于频繁，请稍后再试',
    LLM_TIMEOUT: '生成超时（网络较慢或内容过长），请重试',
    LLM_OUTPUT_TRUNCATED: '输出不完整（已尝试自动续写但仍未完成），可点击「重新生成」重试',
    LLM_RESPONSE_TOO_LARGE: '生成内容过长，请尝试简化提示词',
    LLM_REQUEST_FAILED: '请求失败，请检查网络连接',
    NETWORK_ERROR: '网络连接失败，请检查网络',
    AGY_NOT_FOUND: '未检测到 agy CLI，请先安装 Antigravity CLI',
    AGY_SPAWN_FAILED: 'agy CLI 启动失败，请检查安装',
    CODEX_NOT_FOUND: '未检测到 codex CLI，请先安装 Codex CLI',
    CODEX_MODEL_ERROR: 'codex 模型配置有误，请检查模型名',
    'Agent execution terminated': 'agy 执行出错（模型调用失败或超时），请检查网络后重试',
    // codex 网络错误
    'tls handshake': 'TLS 握手失败，请检查网络代理设置或 OpenAI 服务器连接',
    'stream disconnected': '连接中断，请检查网络稳定性后重试',
    'Reconnecting': '正在重连，请检查网络连接'
  }
  const lowerErr = err.toLowerCase()
  for (const [key, msg] of Object.entries(map)) {
    if (lowerErr.includes(key.toLowerCase())) return msg
  }
  if (err.includes('AGY_ERROR:')) return `agy 执行出错：${err.slice(err.indexOf(':') + 1).trim().slice(0, 100)}`
  if (err.includes('CODEX_ERROR:')) return `codex 执行出错：${err.slice(err.indexOf(':') + 1).trim().slice(0, 100)}`
  // Zod 字段超长错误：解析出字段名和实际字符数
  const tooBig = err.match(/(\w+): Too big: expected string to have <=(\d+) characters/g)
  if (tooBig) {
    const items = tooBig.map((s) => {
      const m = s.match(/(\w+): Too big: expected string to have <=(\d+) characters/)
      return m ? `${m[1]} 超过 ${m[2]} 字符上限` : s
    })
    return `内容过长（${items.join('、')}），请精简后再试`
  }
  return err
}

/**
 * 开书多步向导（story-long-write Phase 1-3）。
 * 1. 脑洞输入 → 2. 核心设定（流式，可编辑）→ 3. 卷级大纲（流式）→ 4. 细纲（流式）→ 落盘
 */
export default function OpeningDialog({ projectId, onClose, onCompleted }: Props): React.ReactElement {
  const cacheKey = (key: string) => `opening:${projectId}:${key}`

  // 初始化状态，尝试从 localStorage 恢复进度
  const [step, setStep] = useState<Step>(() => {
    return (localStorage.getItem(cacheKey('step')) as Step) || 'brain'
  })
  const [brainDump, setBrainDump] = useState(() => {
    return localStorage.getItem(cacheKey('brainDump')) || ''
  })
  const [coreSettings, setCoreSettings] = useState(() => {
    return localStorage.getItem(cacheKey('coreSettings')) || ''
  })
  const [volumeOutline, setVolumeOutline] = useState(() => {
    return localStorage.getItem(cacheKey('volumeOutline')) || ''
  })
  const [chaptersMd, setChaptersMd] = useState(() => {
    return localStorage.getItem(cacheKey('chaptersMd')) || ''
  })

  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [rhythmPreview, setRhythmPreview] = useState('')
  const [rhythmLoading, setRhythmLoading] = useState(false)
  const [consistencyReport, setConsistencyReport] = useState<{ passed: boolean; stats: { total: number; blocking: number; advisory: number }; violations: Array<{ check: number; checkName: string; severity: string; file: string; detail: string; fix: string }> } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // 监听状态改变并自动同步到 localStorage
  useEffect(() => {
    localStorage.setItem(cacheKey('step'), step)
  }, [step])

  useEffect(() => {
    localStorage.setItem(cacheKey('brainDump'), brainDump)
  }, [brainDump])

  useEffect(() => {
    localStorage.setItem(cacheKey('coreSettings'), coreSettings)
  }, [coreSettings])

  useEffect(() => {
    localStorage.setItem(cacheKey('volumeOutline'), volumeOutline)
  }, [volumeOutline])

  useEffect(() => {
    localStorage.setItem(cacheKey('chaptersMd'), chaptersMd)
  }, [chaptersMd])

  // Esc 关闭（流式生成时禁止，避免中断）；打开时聚焦对话框
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !streaming) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [streaming, onClose])



  // 清除本地进度缓存
  const clearCache = () => {
    localStorage.removeItem(cacheKey('step'))
    localStorage.removeItem(cacheKey('brainDump'))
    localStorage.removeItem(cacheKey('coreSettings'))
    localStorage.removeItem(cacheKey('volumeOutline'))
    localStorage.removeItem(cacheKey('chaptersMd'))
  }

  // 重置/清空重来
  const handleReset = () => {
    if (confirm('确定要清空当前的全部开书进度，重新开始吗？此操作不可撤销。')) {
      setStep('brain')
      setBrainDump('')
      setCoreSettings('')
      setVolumeOutline('')
      setChaptersMd('')
      clearCache()
    }
  }

  // 完成开书
  const handleCompleted = () => {
    setStep('brain')
    clearCache()
    onCompleted()
  }

  const streamCall = async (
    fn: (onToken: (t: string, d: boolean) => void) => Promise<{ ok: boolean; error?: string; markdown?: string }>,
    onDone: (md: string) => void,
    initialBuffer = ''
  ): Promise<boolean> => {
    setStreaming(true)
    setError('')
    let buffer = initialBuffer
    let success = false
    try {
      const res = await fn((token, done) => {
        if (token) {
          buffer += token
          onDone(buffer)
        }
      })
      if (!res.ok) {
        setError(friendlyError(res.error ?? '生成失败'))
      } else {
        success = true
        if (buffer === initialBuffer && res.markdown) {
          onDone(res.markdown)
        }
      }
    } catch (err) {
      setError(friendlyError((err as Error).message))
    } finally {
      setStreaming(false)
    }
    return success
  }

  // Step 1 → 2：生成核心设定
  const genCoreSettings = async (): Promise<void> => {
    if (!brainDump.trim()) {
      setError('请输入脑洞/灵感')
      return
    }
    setStep('settings')
    setCoreSettings('')
    await streamCall(
      (onToken) => window.api.openingCoreSettingsStream(projectId, brainDump, onToken),
      (md) => setCoreSettings(md)
    )
  }

  // Step 2 → 3：生成卷级大纲
  const genVolumeOutline = async (): Promise<void> => {
    if (!coreSettings.trim()) {
      setError('核心设定为空')
      return
    }
    setStep('volume')
    setVolumeOutline('')
    await streamCall(
      (onToken) => window.api.openingVolumeOutlineStream(projectId, coreSettings, onToken),
      (md) => setVolumeOutline(md)
    )
  }

  // Step 3 → 4：生成前 N 章细纲
  const genFirstChapters = async (): Promise<void> => {
    if (!volumeOutline.trim()) {
      setError('卷级大纲为空')
      return
    }
    setStep('chapters')
    setChaptersMd('')
    await streamCall(
      (onToken) =>
        window.api.openingFirstChaptersStream(
          projectId,
          coreSettings,
          volumeOutline,
          1,
          10,
          onToken
        ),
      (md) => setChaptersMd(md)
    )
  }

  // 预览节奏图谱（不落盘，Step2 大纲确认后、Step3 细纲生成前可调）
  const previewRhythm = async (): Promise<void> => {
    if (!volumeOutline.trim()) {
      setError('卷级大纲为空，无法生成节奏图谱')
      return
    }
    setRhythmLoading(true)
    setError('')
    try {
      const res = await window.api.generateRhythm(projectId, volumeOutline)
      if (res.ok && res.html) {
        setRhythmPreview(res.html)
      } else {
        setError(res.error ?? '节奏图谱生成失败')
      }
    } catch (err) {
      setError(friendlyError((err as Error).message))
    } finally {
      setRhythmLoading(false)
    }
  }



  // 续写：从已有内容断点继续生成核心设定
  const continueCoreSettings = async (): Promise<void> => {
    if (!coreSettings.trim()) return
    const ok = await streamCall(
      (onToken) => window.api.continueCoreSettingsStream(projectId, brainDump, coreSettings, onToken),
      (md) => setCoreSettings(md),
      coreSettings
    )
    if (ok) setError('')
  }

  // 续写：从已有内容断点继续生成卷级大纲
  const continueVolumeOutline = async (): Promise<void> => {
    if (!volumeOutline.trim()) return
    const ok = await streamCall(
      (onToken) => window.api.continueVolumeOutlineStream(projectId, coreSettings, volumeOutline, onToken),
      (md) => setVolumeOutline(md),
      volumeOutline
    )
    if (ok) setError('')
  }

  // 续写：从已有内容断点继续生成前 N 章细纲
  const continueFirstChapters = async (): Promise<void> => {
    if (!chaptersMd.trim()) return
    const ok = await streamCall(
      (onToken) =>
        window.api.continueFirstChaptersStream(
          projectId,
          coreSettings,
          volumeOutline,
          1,
          10,
          chaptersMd,
          onToken
        ),
      (md) => setChaptersMd(md),
      chaptersMd
    )
    if (ok) setError('')
  }



  // Step 4：落盘
  const persist = async (): Promise<void> => {
    setStreaming(true)
    setError('')
    try {
      const res = await window.api.persistOpening(
        projectId,
        coreSettings,
        volumeOutline,
        chaptersMd || undefined,
        chaptersMd ? 1 : undefined
      )
      if (res?.consistencyReport) {
        setConsistencyReport(res.consistencyReport)
      }
      setStep('done')
    } catch (err) {
      setError(friendlyError((err as Error).message))
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="开书向导"
        tabIndex={-1}
        className="dialog"
        style={{ width: 1400, maxWidth: '95vw', height: '92vh', maxHeight: '95vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--line)', marginBottom: 18, paddingBottom: 12 }}>
          <h3 style={{ borderBottom: 'none', margin: 0, paddingBottom: 0 }}>🚀 开书向导</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', gap: 6, fontSize: 12 }}>
              {(['brain', 'settings', 'volume', 'chapters', 'done'] as Step[]).map((s, i) => (
                <span
                  key={s}
                  className={`filter-chip ${step === s ? 'active' : ''}`}
                  style={{
                    opacity: step === s || i < (['brain', 'settings', 'volume', 'chapters', 'done'] as Step[]).indexOf(step) ? 1 : 0.5,
                    cursor: 'default',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {STEP_LABELS[s]}
                </span>
              ))}
            </div>
            {step !== 'done' && (
              <button
                className="btn btn-ghost"
                onClick={onClose}
                disabled={streaming}
                style={{
                  padding: '2px 8px',
                  fontSize: 16,
                  height: 'auto',
                  lineHeight: 1,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--ink-3)',
                  cursor: 'pointer'
                }}
                title="关闭"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Step 1：脑洞输入 */}
        {step === 'brain' ? (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <p className="meta">
              输入你的脑洞/灵感。可以是：一个金手指点子、一个想写的场景、一个角色、一种想给读者的感觉。
              AI 会推断题材方向、生成核心设定。
            </p>
            <textarea
                  className="textarea"
                  value={brainDump}
                  onChange={(e) => setBrainDump(e.target.value)}
                  placeholder={
                    '示例：\n主角重生回高三，带着前世的记忆 and 手机里的一个签到系统。每天签到能获得各种能力卡片。我想写都市重生爽文，节奏快，打脸为主。\n\n或简单点：一个修仙世界里，主角的剑能吞噬其他剑灵进化。'
                  }
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 15,
                    lineHeight: 1.5,
                    flex: 1,
                    minHeight: 0,
                    marginTop: 8,
                    resize: 'none'
                  }}
                  autoFocus
            />
            {error ? <p className="diag-msg" style={{ color: '#dc2626' }}>{error}</p> : null}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
              {(brainDump.trim() || coreSettings.trim()) ? (
                <button className="btn btn-ghost" onClick={handleReset} style={{ color: 'var(--danger)' }} disabled={streaming}>
                  清空重来
                </button>
              ) : null}
              <button className="btn btn-ghost" onClick={onClose} disabled={streaming}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void genCoreSettings()} disabled={streaming || !brainDump.trim()}>
                {streaming ? '生成核心设定中…' : '✦ 生成核心设定'}
              </button>
            </div>
          </div>
        ) : null}

        {/* Step 2：核心设定（可编辑） */}
        {step === 'settings' ? (
          <StepEditor
            title="核心设定表（可编辑确认）"
            value={coreSettings}
            onChange={setCoreSettings}
            streaming={streaming}
            error={error}
            onNext={() => void genVolumeOutline()}
            onPrev={() => setStep('brain')}
            onRetry={() => void genCoreSettings()}
            onContinue={() => void continueCoreSettings()}
            nextLabel="✦ 生成卷级大纲"
          />
        ) : null}

        {/* Step 3：卷级大纲 */}
        {step === 'volume' ? (
          <>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 8 }}>
              <button
                className="btn btn-ghost"
                onClick={() => void previewRhythm()}
                disabled={streaming || rhythmLoading || !volumeOutline.trim()}
              >
                {rhythmLoading ? '📐 生成中…' : '📐 预览节奏图谱'}
              </button>
            </div>
            <StepEditor
              title="卷级大纲（可编辑确认）"
              value={volumeOutline}
              onChange={setVolumeOutline}
              streaming={streaming}
              error={error}
              onNext={() => void genFirstChapters()}
              onPrev={() => setStep('settings')}
              onRetry={() => void genVolumeOutline()}
              onContinue={() => void continueVolumeOutline()}
              nextLabel="✦ 生成前 10 章细纲"
            />
            {rhythmPreview ? (
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.5)',
                  zIndex: 1000,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                onClick={() => setRhythmPreview('')}
              >
                <div
                  style={{
                    width: '90vw',
                    height: '90vh',
                    background: 'white',
                    borderRadius: 8,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
                    <strong>📐 节奏图谱预览</strong>
                    <button className="btn btn-ghost" onClick={() => setRhythmPreview('')} style={{ padding: '2px 8px' }}>✕</button>
                  </div>
                  <iframe
                    srcDoc={rhythmPreview}
                    style={{ flex: 1, border: 'none', width: '100%' }}
                    sandbox="allow-scripts"
                    title="节奏图谱预览"
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {/* Step 4：前 N 章细纲 */}
        {step === 'chapters' ? (
          <StepEditor
            title="前 10 章细纲（可编辑确认）"
            value={chaptersMd}
            onChange={setChaptersMd}
            streaming={streaming}
            error={error}
            onNext={() => void persist()}
            onPrev={() => setStep('volume')}
            onRetry={() => void genFirstChapters()}
            onContinue={() => void continueFirstChapters()}
            nextLabel="💾 落盘保存"
          />
        ) : null}

        {/* 完成 */}
        {step === 'done' ? (
          <div style={{ marginTop: 16, textAlign: 'center', overflow: 'auto', flex: 1 }}>
            <p style={{ fontSize: 16 }}>✅ 开书完成！</p>
            <p className="meta" style={{ marginTop: 8 }}>
              开书产物已按新技能结构落盘到「设定/」「大纲/」「细纲/」「追踪/」「图解/」。
              其中主设定入口是「设定/题材定位.md」，卷级总纲在「大纲/大纲.md」，前 10 章细纲在「细纲/细纲_第NNN章_标题.md」。
            </p>
            <p className="meta">现在可以开始续写正文了。建议先在「📐 大纲」页检查细纲，再逐章续写。</p>

            {consistencyReport ? (
              <div style={{ marginTop: 16, textAlign: 'left', background: 'var(--bg-2)', padding: 12, borderRadius: 6, maxHeight: 300, overflow: 'auto' }}>
                <strong>
                  {consistencyReport.passed
                    ? '✅ 逻辑自洽检查通过'
                    : `⚠️ 逻辑自洽检查发现 ${consistencyReport.stats.total} 项问题（blocking ${consistencyReport.stats.blocking} / advisory ${consistencyReport.stats.advisory}）`}
                </strong>
                {consistencyReport.violations.length > 0 ? (
                  <ul style={{ marginTop: 8, paddingLeft: 20, fontSize: 12 }}>
                    {consistencyReport.violations.map((v, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <span style={{ color: v.severity === 'blocking' ? '#dc2626' : '#d97706', fontWeight: 600 }}>
                          [{v.severity === 'blocking' ? '必须修' : '建议'}]
                        </span>{' '}
                        <span style={{ fontWeight: 600 }}>{v.checkName}</span>{' '}
                        <span style={{ color: 'var(--ink-3)' }}>{v.file}</span>
                        <div style={{ color: 'var(--ink-2)' }}>→ {v.detail}</div>
                        <div style={{ color: 'var(--ink-3)', fontSize: 11 }}>修复：{v.fix}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta" style={{ marginTop: 8 }}>6 项硬性检查全部通过，无 blocking 违规。</p>
                )}
              </div>
            ) : null}

            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleCompleted}>
              完成，开始写作
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 通用步骤编辑器：标题 + 可编辑文本区 + 流式状态 + 上一步/下一步/续写/重试 */
function StepEditor({
  title,
  value,
  onChange,
  streaming,
  error,
  onNext,
  onPrev,
  onRetry,
  onContinue,
  nextLabel
}: {
  title: string
  value: string
  onChange: (v: string) => void
  streaming: boolean
  error: string
  onNext: () => void
  onPrev: () => void
  onRetry?: () => void
  onContinue?: () => void
  nextLabel: string
}): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [value]);

  const hasContent = value.trim().length > 0

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        {streaming ? <span className="meta" style={{ marginLeft: 8 }}>生成中…</span> : null}
      </div>
      <textarea
        ref={textareaRef}
        className="textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: 'monospace',
          fontSize: 14,
          lineHeight: 1.5,
          marginTop: 8,
          whiteSpace: 'pre-wrap',
          flex: 1,
          minHeight: 0,
          resize: 'none'
        }}
        disabled={streaming}
      />
      {error ? <p className="diag-msg" style={{ color: '#dc2626' }}>{error}</p> : null}
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 12, gap: 8 }}>
        <button className="btn btn-ghost" onClick={onPrev} disabled={streaming}>
          ← 上一步
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {onRetry ? (
            <button className="btn btn-ghost" onClick={onRetry} disabled={streaming} style={{ color: 'var(--danger)' }}>
              🔄 重新生成
            </button>
          ) : null}
          {hasContent && onContinue ? (
            <button className="btn btn-ghost" onClick={onContinue} disabled={streaming} style={{ color: 'var(--accent)' }}>
              ✏ 续写
            </button>
          ) : null}
          <button className="btn btn-primary" onClick={onNext} disabled={streaming || !hasContent}>
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
