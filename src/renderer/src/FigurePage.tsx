import { useEffect, useState } from 'react'
import type { FigureSummary, ChapterFigure, FigureSection } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter: (n: number) => void
}

export default function FigurePage({ projectId, onBack, onOpenChapter }: Props) {
  const [list, setList] = useState<FigureSummary[]>([])
  const [selected, setSelected] = useState<ChapterFigure | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setSelected(null)
    void window.api.listFigures(projectId).then((l) => {
      setList(l)
      setLoading(false)
    })
  }, [projectId])

  const openDetail = async (fileName: string) => {
    const fig = await window.api.readFigure(projectId, fileName)
    setSelected(fig)
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              ‹ 返回
            </button>
            <h1 style={{ marginTop: 8 }}>关键情节图解</h1>
            <p className="desc">{list.length} 个关键节点 · Mermaid 图解</p>
          </div>
        </div>
      </div>

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : list.length === 0 ? (
        <div className="placeholder">
          <p>暂无关键情节图解。</p>
          <p className="meta">
            技能在第三步为关键转折章节生成 图解/第N章-名称.html（Mermaid 流程图）。
          </p>
        </div>
      ) : selected ? (
        <FigureDetail
          figure={selected}
          onBack={() => setSelected(null)}
          onOpenChapter={onOpenChapter}
          onOpenInBrowser={async () => {
            await window.api.openFigure(projectId, selected.fileName)
          }}
        />
      ) : (
        <ul className="bare">
          {list.map((f) => (
            <li key={f.fileName} className="card card-hover" style={{ padding: '14px 16px' }}>
              <button
                type="button"
                onClick={() => void openDetail(f.fileName)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                  color: 'inherit',
                  textAlign: 'left'
                }}
              >
                <strong>
                  {f.chapterNumber ? `第 ${f.chapterNumber} 章 · ` : ''}
                  {f.title}
                </strong>
                <span className="meta">查看 →</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FigureDetail({
  figure,
  onBack,
  onOpenChapter,
  onOpenInBrowser
}: {
  figure: ChapterFigure
  onBack: () => void
  onOpenChapter: (n: number) => void
  onOpenInBrowser: () => void
}) {
  const ch = figure.chapterNumber
  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 列表
        </button>
        {ch ? (
          <button
            className="btn btn-sm"
            onClick={() => onOpenChapter(ch)}
            title="跳转到该章节正文"
          >
            去第 {ch} 章
          </button>
        ) : null}
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={onOpenInBrowser}>
          🌐 在浏览器打开完整图解
        </button>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ fontSize: 17, marginBottom: 12 }}>{figure.title}</h2>
        {figure.sections.length === 0 ? (
          <p className="empty">该图解无可识别的结构化内容，请用浏览器打开查看。</p>
        ) : (
          figure.sections.map((sec, i) => (
            <FigureSectionView key={i} section={sec} />
          ))
        )}
      </div>
    </div>
  )
}

function FigureSectionView({ section }: { section: FigureSection }) {
  return (
    <section className="md-section" style={{ marginBottom: 14 }}>
      <h4 className="md-h3">{section.name}</h4>
      {section.kind === 'list' && section.items ? (
        <ul className="md-ul">
          {section.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : null}
      {section.kind === 'table' && section.rows ? (
        <table className="md-table">
          <tbody>
            {section.rows.map((r, i) => (
              <tr key={i} className={i === 0 ? '' : undefined}>
                {r.map((c, j) =>
                  i === 0 ? (
                    <th key={j}>{c}</th>
                  ) : (
                    <td key={j}>{c}</td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {section.kind === 'mermaid' && section.mermaid ? (
        <div>
          <pre className="md-code">{section.mermaid}</pre>
          <p className="meta" style={{ marginTop: 4 }}>
            ↑ Mermaid 流程图源码。完整渲染图请用右上角「在浏览器打开」查看。
          </p>
        </div>
      ) : null}
      {section.kind === 'prose' && section.text ? (
        <p className="md-p" style={{ whiteSpace: 'pre-wrap' }}>
          {section.text}
        </p>
      ) : null}
    </section>
  )
}
