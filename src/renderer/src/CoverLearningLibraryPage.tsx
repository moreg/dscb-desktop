import { useCallback, useEffect, useState } from 'react'
import type { CoverLearningLibrarySummary, CoverLearningRunResult } from '../../shared/types'

export default function CoverLearningLibraryPage(): React.ReactElement {
  const [library, setLibrary] = useState<CoverLearningLibrarySummary | null>(null)
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [learning, setLearning] = useState(false)
  const [lastResult, setLastResult] = useState<CoverLearningRunResult | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const applySummary = useCallback((summary: CoverLearningLibrarySummary): void => {
    setLibrary(summary)
    setDirectory(summary.directory)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      applySummary(await window.api.getCoverLearningLibrary())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [applySummary])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const chooseDirectory = async (): Promise<void> => {
    setError('')
    setMessage('')
    try {
      const selected = await window.api.chooseCoverLearningLibraryDirectory()
      if (!selected) return
      applySummary(selected)
      setMessage('学习库位置已更新，所有项目将共用这里的规则。')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const saveDirectory = async (): Promise<void> => {
    if (!directory.trim()) {
      setError('学习库目录不能为空')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      applySummary(await window.api.setCoverLearningLibraryDirectory(directory.trim()))
      setMessage('学习库位置已保存，所有项目立即生效。')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const learnFolder = async (): Promise<void> => {
    setLearning(true)
    setError('')
    setMessage('')
    try {
      const result = await window.api.chooseAndLearnCoverFolder()
      if (!result) return
      setLastResult(result)
      applySummary(result.summary)
      setMessage(result.learned > 0
        ? `学习完成：新增 ${result.learned} 张，已写入公共学习结果。`
        : '扫描完成：没有新增封面，已有图片已自动过滤。')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLearning(false)
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>学习库</h1>
        <p className="desc">跨项目共享的本地创作知识，不属于任何一本书的工作区</p>
      </div>

      {loading ? <p className="empty">正在读取学习库…</p> : null}

      {library ? (
        <>
          {/* 顶部概览：占满页面宽度，避免像弹窗一样窄条堆叠 */}
          <div className="card" style={{ margin: '16px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
              <div>
                <h2 style={{ margin: '0 0 6px' }}>番茄封面学习库</h2>
                <p className="meta" style={{ margin: 0 }}>
                  所有小说项目读取同一份学习库。修改规则后，下一次提炼提示词或生成封面立即生效。
                </p>
              </div>
              <span className={`badge ${library.status === 'ready' ? '' : 'badge-alert'}`}>
                {library.status === 'ready' ? '● 正常加载' : '● 使用内置回退'}
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 12,
                marginTop: 20
              }}
            >
              <Stat value={library.sampleCount} label="学习样本" suffix="张" />
              <Stat value={library.categoryCount} label="覆盖题材" suffix="个" />
              <Stat value={library.styleCount} label="封面风格" suffix="种" />
              <Stat value={library.trackedSampleCount} label="可去重样本" suffix="张" />
            </div>
          </div>

          {/* 「学习新封面」与「本地保存位置」并排展开，宽屏下不再挤成一条竖着的窄栏 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
              gap: 16,
              alignItems: 'start'
            }}
          >
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
                <div>
                  <h2 style={{ margin: '0 0 6px' }}>学习新封面</h2>
                  <p className="meta" style={{ margin: 0 }}>
                    选择一个文件夹，程序会递归读取其中的 PNG、JPG、WEBP、BMP 和 GIF。分析全部在本地完成，不上传图片。
                  </p>
                </div>
                <button className="btn btn-primary" disabled={learning} onClick={() => void learnFolder()}>
                  {learning ? '正在扫描与学习…' : '选择封面文件夹并学习'}
                </button>
              </div>
              <div className="placeholder" style={{ marginTop: 16, textAlign: 'left', padding: 16 }}>
                <strong>自动去重</strong>
                <p className="meta" style={{ margin: '6px 0 0' }}>
                  每张封面同时生成 SHA-256 内容指纹和保守的标准化视觉指纹。改名、移动不会重复学习；等比例缩放且标准化像素一致时也会跳过，不确定的相似图会保留为新样本。
                  当前已记录 {library.trackedSampleCount} 张可去重封面，共完成 {library.learningRunCount} 次文件夹学习。
                </p>
              </div>
              {lastResult ? (
                <div style={{ marginTop: 16 }}>
                  <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
                    本次结果：扫描 {lastResult.scanned} 张 · 新增 {lastResult.learned} 张 · 重复 {lastResult.duplicates} 张 · 失败 {lastResult.failed} 张
                  </p>
                  <ul className="diag-list" style={{ margin: 0 }}>
                    {lastResult.observations.map((observation) => (
                      <li key={observation} className="diag-item">
                        <span className="diag-msg">{observation}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : library.lastLearnedAt ? (
                <p className="meta" style={{ margin: '14px 0 0' }}>
                  最近一次学习：{new Date(library.lastLearnedAt).toLocaleString()}
                </p>
              ) : null}
            </div>

            <div className="card">
              <h2 style={{ marginTop: 0 }}>本地保存位置</h2>
              <p className="meta">
                可放到备份盘或同步盘。新目录没有库文件时会自动创建；已有库文件时直接读取。
              </p>
              <div className="field">
                <label htmlFor="cover-learning-library-directory">学习库目录</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    id="cover-learning-library-directory"
                    className="input"
                    value={directory}
                    onChange={(event) => setDirectory(event.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn btn-ghost" onClick={() => void chooseDirectory()}>
                    选择目录
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={saving || directory.trim() === library.directory}
                    onClick={() => void saveDirectory()}
                  >
                    {saving ? '保存中…' : '保存位置'}
                  </button>
                </div>
              </div>
              <p className="meta" style={{ overflowWrap: 'anywhere' }}>
                当前文件：{library.filePath}
              </p>
              {library.status === 'fallback' ? (
                <p className="diag-msg" style={{ color: 'var(--danger)' }}>
                  原学习库没有被覆盖。当前已安全回退：{library.error ?? '文件格式异常'}
                </p>
              ) : null}
              {message ? <p className="diag-msg" style={{ color: 'var(--success)' }}>{message}</p> : null}
              {error ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => void refresh()}>
                  重新读取
                </button>
              </div>
            </div>
          </div>

          <div className="placeholder" style={{ marginTop: 16, textAlign: 'left' }}>
            <strong>当前用途</strong>
            <p className="meta" style={{ marginBottom: 0 }}>
              封面生成会读取题材推荐、构图、配色、标题字体、作者字体、文字位置、字效和 9:16 安全区规则。后续增加其他公共学习内容时，也统一从这个入口管理。
            </p>
          </div>
        </>
      ) : null}

      {!library && error ? <p className="diag-msg" style={{ color: 'var(--danger)' }}>{error}</p> : null}
    </div>
  )
}

function Stat({ value, label, suffix }: { value: number; label: string; suffix: string }): React.ReactElement {
  return (
    <div className="placeholder" style={{ padding: 16 }}>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}{suffix}</div>
      <div className="meta">{label}</div>
    </div>
  )
}
