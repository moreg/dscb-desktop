import { useMemo, type ReactNode } from 'react'

export interface MdSection {
  title: string
  body: string
}

/**
 * 把 rawFields（Record<string, string|string[]>）重建为 `- **字段**：值` 的 markdown，
 * 供 MarkdownView 渲染。多行子列表还原为 `  - xxx` 缩进。
 * 用于角色卡 / 地点卡等需要展示完整原始字段的场景。
 */
export function rawFieldsToMarkdown(raw: Record<string, string | string[]> | undefined): string {
  if (!raw) return ''
  return Object.entries(raw)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `- **${k}**：`
        return `- **${k}**：\n${v.map((x) => `  - ${x}`).join('\n')}`
      }
      return `- **${k}**：${v}`
    })
    .join('\n')
}

interface Props {
  sections: MdSection[]
  /** 跳过这些节（如逐章节奏标注交给专门组件展示） */
  skipTitles?: string[]
}

/** 行内渲染：**粗体** + 反引号 `code` */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>
    return <span key={i}>{p}</span>
  })
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function isSeparatorRow(line: string): boolean {
  return splitRow(line).every((c) => /^:?-+:?$/.test(c))
}

function renderTable(lines: string[], key: number): ReactNode {
  const dataRows = lines
    .filter((l) => !isSeparatorRow(l))
    .map(splitRow)
    .filter((r) => r.some((c) => c !== ''))
  if (dataRows.length === 0) return null
  const [header, ...body] = dataRows
  return (
    <table key={key} className="md-table">
      <thead>
        <tr>
          {header.map((c, i) => (
            <th key={i}>{renderInline(c)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{renderInline(c)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderBody(body: string): ReactNode[] {
  const lines = body.split(/\r?\n/)
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  let inFence = false

  while (i < lines.length) {
    const line = lines[i]

    // 代码围栏（大纲少见，但世界观有 Mermaid——原样展示源码）
    if (line.trim().startsWith('```')) {
      if (!inFence) {
        const codeLines: string[] = []
        i++
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i])
          i++
        }
        i++ // 跳过结束 ```
        blocks.push(
          <pre key={key++} className="md-code">
            {codeLines.join('\n')}
          </pre>
        )
        continue
      }
    }

    // 表格块
    if (line.trim().startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      const t = renderTable(tableLines, key++)
      if (t) blocks.push(t)
      continue
    }

    // H3 / H4 子标题
    if (/^#### /.test(line)) {
      blocks.push(
        <h5 key={key++} className="md-h4">
          {line.replace(/^####\s*/, '')}
        </h5>
      )
      i++
      continue
    }
    if (/^### /.test(line)) {
      blocks.push(
        <h4 key={key++} className="md-h3">
          {line.replace(/^###\s*/, '')}
        </h4>
      )
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {quoteLines.map((q, j) => (
            <p key={j}>{renderInline(q)}</p>
          ))}
        </blockquote>
      )
      continue
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      )
      continue
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      )
      continue
    }

    // 空行
    if (line.trim() === '') {
      i++
      continue
    }

    // 普通段落
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(line)}
      </p>
    )
    i++
  }
  return blocks
}

export default function MarkdownView({ sections, skipTitles }: Props) {
  const skip = useMemo(() => new Set((skipTitles ?? []).map((t) => t.trim())), [skipTitles])
  const visible = sections.filter((s) => !skip.has(s.title.trim()))
  if (visible.length === 0) {
    return <p className="empty">暂无内容。</p>
  }
  return (
    <div className="markdown-view">
      {visible.map((sec, i) => (
        <section key={i} className="md-section">
          {sec.title ? <h3 className="md-section-title">{sec.title}</h3> : null}
          {renderBody(sec.body)}
        </section>
      ))}
    </div>
  )
}
