import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type {
  ScanPlatform,
  ScanReportSummary,
  ScanResult,
  StreamHandle
} from '../../shared/types'
import MarkdownView, { MdSection } from './MarkdownView'

const PLATFORM_OPTIONS: { value: ScanPlatform; label: string; mode: string }[] = [
  { value: 'qidian', label: '起点（自动采集）', mode: 'fetch' },
  { value: 'jjwxc', label: '晋江（自动采集）', mode: 'fetch' },
  { value: 'fanqie', label: '番茄（需提供数据/内置）', mode: 'user' },
  { value: 'qimao', label: '七猫（需提供数据/内置）', mode: 'user' },
  { value: 'ciweimao', label: '刺猬猫（需提供数据/内置）', mode: 'user' },
  { value: 'zhihu', label: '知乎盐言（需提供数据/内置）', mode: 'user' },
  { value: 'dz', label: '点众（需提供数据/内置）', mode: 'user' },
  { value: 'heiyan', label: '黑岩（需提供数据/内置）', mode: 'user' }
]

/** 将完整 Markdown 文本包装为 MarkdownView 可接受的 MdSection 数组 */
function parseRawMarkdownToSections(raw: string): MdSection[] {
  return raw.trim() ? [{ title: '', body: raw }] : []
}

export default function ScanPage(): React.ReactElement {
  const [reports, setReports] = useState<ScanReportSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [platform, setPlatform] = useState<ScanPlatform>('qidian')
  const [userData, setUserData] = useState('')
  const [lastResult, setLastResult] = useState<ScanResult | null>(null)
  const [activeReport, setActiveReport] = useState<string | null>(null)
  const [activeContent, setActiveContent] = useState('')

  // 选题决策
  const [analyzing, setAnalyzing] = useState(false)
  const [decision, setDecision] = useState('')

  // 流式 token 不直接进 state：MarkdownView 每次都要对决策全文重新解析，
  // 逐 token 触发渲染是 O(n²)。先攒进缓冲，按短间隔批量 flush。
  const decisionBufRef = useRef('')
  const decisionTimerRef = useRef<number | null>(null)

  const flushDecision = useCallback(() => {
    decisionTimerRef.current = null
    const buf = decisionBufRef.current
    if (!buf) return
    decisionBufRef.current = ''
    setDecision((d) => d + buf)
  }, [])

  const resetDecision = useCallback(() => {
    if (decisionTimerRef.current != null) {
      window.clearTimeout(decisionTimerRef.current)
      decisionTimerRef.current = null
    }
    decisionBufRef.current = ''
    setDecision('')
  }, [])

  // 进行中的分析流句柄与代际号：切换/删除报告或重新分析时先 abort 旧流，
  // 并靠代际号丢弃 abort 生效前仍在途的过期 token，避免串进新报告的决策区。
  const analysisRef = useRef<StreamHandle | null>(null)
  const analysisGenRef = useRef(0)

  const cancelAnalysis = useCallback(() => {
    analysisGenRef.current++
    const handle = analysisRef.current
    analysisRef.current = null
    if (handle) void handle.abort().catch(() => undefined)
    setAnalyzing(false)
    resetDecision()
  }, [resetDecision])

  // 连点多份报告时读取可能乱序返回：只认最后一次点击的结果
  const openSeqRef = useRef(0)

  useEffect(
    () => () => {
      if (decisionTimerRef.current != null) window.clearTimeout(decisionTimerRef.current)
      void analysisRef.current?.abort().catch(() => undefined)
    },
    []
  )

  const refresh = useCallback(async (): Promise<ScanReportSummary[]> => {
    setLoading(true)
    try {
      const list = await window.api.listScanReports()
      setReports(list)
      return list
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 首次加载：有报告时默认选中第一个
    void refresh().then((list) => {
      if (list.length > 0) void openReport(list[0].fileName)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  const handleScan = async (): Promise<void> => {
    setScanning(true)
    setLastResult(null)
    try {
      const result = await window.api.scanRank({
        platform,
        userData: userData.trim() || undefined
      })
      setLastResult(result)
      await refresh()
      if (result.fileName) {
        void openReport(result.fileName)
      }
    } catch (err) {
      alert(`采集失败：${(err as Error).message}`)
    } finally {
      setScanning(false)
    }
  }

  const openReport = async (fileName: string): Promise<void> => {
    const seq = ++openSeqRef.current
    cancelAnalysis()
    setActiveReport(fileName)
    try {
      const content = await window.api.readScanReport(fileName)
      if (seq !== openSeqRef.current) return
      setActiveContent(content ?? '（读取失败）')
    } catch (err) {
      if (seq !== openSeqRef.current) return
      setActiveContent(`读取失败：${(err as Error).message}`)
    }
  }

  const handleAnalyze = async (): Promise<void> => {
    if (!activeReport) return
    if (!(await window.api.hasLlmKey())) {
      alert('请先在「⚙ 设置 → 模型服务」配置 provider')
      return
    }
    cancelAnalysis()
    const gen = analysisGenRef.current
    setAnalyzing(true)
    try {
      const handle = window.api.analyzeRankStream(
        activeContent,
        reports.find((r) => r.fileName === activeReport)?.platform ?? platform,
        (token, done) => {
          if (gen !== analysisGenRef.current) return
          if (token) {
            decisionBufRef.current += token
            if (decisionTimerRef.current == null) {
              decisionTimerRef.current = window.setTimeout(flushDecision, 80)
            }
          }
          if (done) {
            if (decisionTimerRef.current != null) {
              window.clearTimeout(decisionTimerRef.current)
            }
            flushDecision()
            setAnalyzing(false)
          }
        }
      )
      analysisRef.current = handle
      await handle
    } catch (err) {
      // 切换报告触发的主动取消：静默；真实失败才提示
      if (gen !== analysisGenRef.current) return
      const msg = (err as Error).message
      if (!msg.includes('LLM_ABORTED')) alert(`分析失败：${msg}`)
    } finally {
      if (gen === analysisGenRef.current) {
        analysisRef.current = null
        setAnalyzing(false)
      }
    }
  }

  const handleDelete = async (fileName: string): Promise<void> => {
    if (!confirm(`删除报告 ${fileName}？`)) return
    try {
      await window.api.deleteScanReport(fileName)
      const list = await refresh()
      if (activeReport === fileName) {
        setActiveReport(null)
        setActiveContent('')
        cancelAnalysis()
        // 删除的是当前报告时，自动选中剩余的第一份
        if (list.length > 0) void openReport(list[0].fileName)
      }
    } catch (err) {
      alert(`删除失败：${(err as Error).message}`)
    }
  }

  const platformMode = PLATFORM_OPTIONS.find((p) => p.value === platform)?.mode ?? 'user'

  const activeSections = useMemo(
    () => parseRawMarkdownToSections(activeContent),
    [activeContent]
  )
  const decisionSections = useMemo(
    () => parseRawMarkdownToSections(decision),
    [decision]
  )

  return (
    <div style={{ paddingBottom: 40 }}>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>市场扫榜</h1>
            <p className="desc">洞察热门题材与卖点 · 跨样本重复模式才算信号</p>
          </div>
        </div>
      </div>

      {/* 采集表单 */}
      <div className="scan-card">
        <div className="scan-card-title">
          <span>📊 榜单采集与配置</span>
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 240px', marginBottom: 0 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>选择目标平台</label>
            <select
              className="input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as ScanPlatform)}
              style={{ marginTop: 6 }}
            >
              {PLATFORM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto', marginBottom: 0 }}>
            <button
              className="btn btn-primary"
              onClick={() => void handleScan()}
              disabled={scanning}
              style={{ padding: '8px 20px' }}
            >
              {scanning ? '采集中…' : '📈 采集榜单'}
            </button>
          </div>
        </div>

        {platformMode === 'user' ? (
          <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>用户数据（可选）</label>
            <p className="desc" style={{ marginTop: 4, marginBottom: 8, fontSize: 12 }}>
              {PLATFORM_OPTIONS.find((p) => p.value === platform)?.label} 需登录态/有反爬。
              粘贴榜单数据（书名/作者/题材）走用户模式；留空则用内置题材趋势降级分析。
            </p>
            <textarea
              className="textarea"
              value={userData}
              onChange={(e) => setUserData(e.target.value)}
              rows={3}
              placeholder="粘贴榜单文本（书名、作者、题材等）…"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            />
          </div>
        ) : null}

        {lastResult ? (
          <div
            style={{
              marginTop: 14,
              padding: '10px 14px',
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-sm)',
              fontSize: 13,
              color: 'var(--ink-2)'
            }}
          >
            <strong style={{ color: 'var(--vermilion)' }}>✓ 采集完成</strong>：{lastResult.sourceMode} 模式 ·{' '}
            {lastResult.books.length} 本 · 报告 <code style={{ fontSize: 12 }}>{lastResult.fileName}</code>
            {lastResult.dataQualityNote ? (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                {lastResult.dataQualityNote}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 报告列表 + 详情 */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20 }}>
        {/* 左侧：历史报告 */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, margin: 0, fontWeight: 600, color: 'var(--ink)' }}>历史报告</h3>
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>共 {reports.length} 份</span>
          </div>

          {loading ? (
            <p className="empty">加载中…</p>
          ) : reports.length === 0 ? (
            <p className="empty">还没有扫榜报告。</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 600, overflowY: 'auto', paddingRight: 2 }}>
              {reports.map((r) => {
                const isActive = activeReport === r.fileName
                const platformLabel = PLATFORM_OPTIONS.find((p) => p.value === r.platform)?.label.split('（')[0] ?? r.platform
                return (
                  <div
                    key={r.fileName}
                    className={`scan-report-item${isActive ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => void openReport(r.fileName)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void openReport(r.fileName)
                      }
                    }}
                  >
                    <div className="scan-report-name">{r.fileName}</div>
                    <div className="scan-report-meta">
                      <span>{platformLabel} · {r.bookCount} 本</span>
                      <span>{new Date(r.scannedAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
                      <button
                        className="btn btn-ghost btn-sm btn-danger"
                        style={{ padding: '2px 8px', fontSize: 11, height: 'auto', minHeight: 'unset' }}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDelete(r.fileName)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 右侧：报告详情与决策 */}
        <div>
          {activeReport ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* 报告头部与操作条 */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 16px',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-md)',
                  boxShadow: 'var(--shadow-sm)'
                }}
              >
                <div>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)', display: 'block' }}>当前查看报告</span>
                  <strong style={{ fontSize: 14, color: 'var(--ink)' }}>{activeReport}</strong>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => void handleAnalyze()}
                  disabled={analyzing}
                  style={{ padding: '6px 16px', fontSize: 13 }}
                >
                  {analyzing ? '✦ 分析中…' : '✦ 选题决策'}
                </button>
              </div>

              {/* 报告 Markdown 内容卡片 */}
              <div className="scan-content-box">
                <MarkdownView sections={activeSections} />
              </div>

              {/* 选题决策 Markdown 内容卡片 */}
              {decision || analyzing ? (
                <div
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--vermilion)',
                    borderRadius: 'var(--r-md)',
                    padding: '16px 20px',
                    boxShadow: 'var(--shadow-md)',
                    position: 'relative'
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 12,
                      paddingBottom: 8,
                      borderBottom: '1px solid var(--line)'
                    }}
                  >
                    <span style={{ fontSize: 16 }}>✦</span>
                    <h3 style={{ fontSize: 15, margin: 0, fontWeight: 700, color: 'var(--vermilion)' }}>
                      AI 选题决策与模式分析{analyzing ? '（生成中…）' : ''}
                    </h3>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                    <MarkdownView sections={decisionSections} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div
              className="card"
              style={{
                marginTop: 24,
                textAlign: 'center',
                padding: '48px 24px',
                color: 'var(--ink-3)'
              }}
            >
              <p style={{ margin: 0, fontSize: 14 }}>← 请从左侧选择一份报告查看排版详情，或在上方发起榜单采集。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
