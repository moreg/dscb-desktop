import { useEffect, useState, useCallback } from 'react'
import type {
  ScanPlatform,
  ScanReportSummary,
  ScanResult
} from '../../shared/types'

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

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setReports(await window.api.listScanReports())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
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
    } catch (err) {
      alert(`采集失败：${(err as Error).message}`)
    } finally {
      setScanning(false)
    }
  }

  const openReport = async (fileName: string): Promise<void> => {
    setActiveReport(fileName)
    try {
      const content = await window.api.readScanReport(fileName)
      setActiveContent(content ?? '（读取失败）')
    } catch (err) {
      setActiveContent(`读取失败：${(err as Error).message}`)
    }
    setDecision('')
  }

  const handleAnalyze = async (): Promise<void> => {
    if (!activeReport) return
    if (!(await window.api.hasLlmKey())) {
      alert('请先在「⚙ 设置 → 模型服务」配置 provider')
      return
    }
    setAnalyzing(true)
    setDecision('')
    try {
      await window.api.analyzeRankStream(
        activeContent,
        reports.find((r) => r.fileName === activeReport)?.platform ?? platform,
        (token, done) => {
          if (token) setDecision((d) => d + token)
          if (done) setAnalyzing(false)
        }
      )
    } catch (err) {
      alert(`分析失败：${(err as Error).message}`)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleDelete = async (fileName: string): Promise<void> => {
    if (!confirm(`删除报告 ${fileName}？`)) return
    try {
      await window.api.deleteScanReport(fileName)
      if (activeReport === fileName) {
        setActiveReport(null)
        setActiveContent('')
      }
      await refresh()
    } catch (err) {
      alert(`删除失败：${(err as Error).message}`)
    }
  }

  const platformMode = PLATFORM_OPTIONS.find((p) => p.value === platform)?.mode ?? 'user'

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>市场扫榜</h1>
            <p className="desc">洞察热门题材与卖点 · 跨样本重复模式才算信号</p>
          </div>
        </div>
      </div>

      {/* 采集表单 */}
      <div className="dialog" style={{ maxWidth: 'none', margin: '12px 0', boxShadow: 'none' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 200px' }}>
            <label>平台</label>
            <select
              className="input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as ScanPlatform)}
            >
              {PLATFORM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button
              className="btn btn-primary"
              onClick={() => void handleScan()}
              disabled={scanning}
            >
              {scanning ? '采集中…' : '📈 采集榜单'}
            </button>
          </div>
        </div>

        {platformMode === 'user' ? (
          <div className="field">
            <label>用户数据（可选）</label>
            <p className="meta" style={{ marginTop: 2, fontSize: 12 }}>
              {PLATFORM_OPTIONS.find((p) => p.value === platform)?.label} 需登录态/有反爬。
              粘贴榜单数据（书名/作者/题材）走用户模式；留空则用内置题材趋势降级分析。
            </p>
            <textarea
              className="textarea"
              value={userData}
              onChange={(e) => setUserData(e.target.value)}
              rows={4}
              placeholder="粘贴榜单文本（书名、作者、题材等）…"
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </div>
        ) : null}

        {lastResult ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: 'var(--bg-soft, #f6f8fa)',
              borderRadius: 8,
              fontSize: 13
            }}
          >
            <strong>采集完成</strong>：{lastResult.sourceMode} 模式 ·{' '}
            {lastResult.books.length} 本 · 报告 {lastResult.fileName}
            {lastResult.dataQualityNote ? (
              <div className="meta" style={{ marginTop: 4 }}>
                {lastResult.dataQualityNote}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 报告列表 + 详情 */}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, marginTop: 8 }}>
        <div>
          <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>历史报告</h3>
          {loading ? (
            <p className="empty">加载中…</p>
          ) : reports.length === 0 ? (
            <p className="empty">还没有扫榜报告。</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {reports.map((r) => (
                <button
                  type="button"
                  key={r.fileName}
                  className={`project-card${activeReport === r.fileName ? ' active' : ''}`}
                  style={{ padding: 8, cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => void openReport(r.fileName)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.fileName}</div>
                  <div className="meta" style={{ fontSize: 11 }}>
                    {r.bookCount} 本 · {new Date(r.scannedAt).toLocaleDateString('zh-CN')}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginTop: 4, fontSize: 11 }}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(r.fileName)
                    }}
                  >
                    删除
                  </button>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          {activeReport ? (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8
                }}
              >
                <strong style={{ fontSize: 13 }}>{activeReport}</strong>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleAnalyze()}
                  disabled={analyzing}
                >
                  {analyzing ? '分析中…' : '✦ 选题决策'}
                </button>
              </div>
              <pre
                style={{
                  background: 'var(--bg-code, #f6f8fa)',
                  padding: 12,
                  borderRadius: 8,
                  maxHeight: 360,
                  overflow: 'auto',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  margin: '0 0 16px'
                }}
              >
                {activeContent}
              </pre>

              {decision ? (
                <div>
                  <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>选题决策</h3>
                  <pre
                    style={{
                      background: 'var(--bg-code, #f6f8fa)',
                      padding: 12,
                      borderRadius: 8,
                      maxHeight: 480,
                      overflow: 'auto',
                      fontSize: 12,
                      whiteSpace: 'pre-wrap',
                      margin: 0
                    }}
                  >
                    {decision}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="placeholder" style={{ marginTop: 24 }}>
              <p style={{ margin: 0, fontSize: 14 }}>← 从左侧选择报告查看详情，或先采集一份榜单。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
