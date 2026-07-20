import { useMemo, useState } from 'react'
import type {
  ChapterSelfCheckReport,
  SelfCheckCategory,
  SelfCheckItemResult,
  SelfCheckVerdict
} from '../../shared/types'
import { selfCheckHasActionableIssues } from '../../shared/self-check-to-requirements'

const CATEGORY_LABEL: Record<SelfCheckCategory, string> = {
  continuity: '衔接',
  plot: '剧情',
  foreshadow: '伏笔',
  power: '金手指',
  structure: '结构',
  ban: '禁项'
}

const VERDICT_LABEL: Record<SelfCheckVerdict, string> = {
  pass: '通过',
  fail: '失败',
  warn: '留意',
  skip: '跳过'
}

function verdictClass(v: SelfCheckVerdict): string {
  return `self-check-verdict self-check-verdict-${v}`
}

function itemIcon(v: SelfCheckVerdict): string {
  switch (v) {
    case 'pass':
      return '✓'
    case 'fail':
      return '✕'
    case 'warn':
      return '!'
    default:
      return '–'
  }
}

interface Props {
  report: ChapterSelfCheckReport | null
  /** 重新对当前正文跑自检 */
  onRerun?: () => void | Promise<void>
  rerunLoading?: boolean
  /** 默认展开 fail/warn */
  defaultExpanded?: boolean
  /** 紧凑模式（嵌在同步条下） */
  compact?: boolean
  /**
   * 一键：把失败/留意项生成「按要求重写」指令并打开重写对话框。
   */
  onApplyToRewrite?: () => void
  /**
   * 一键：把失败/留意项填入续写「临时写作要求」并打开续写确认框。
   */
  onApplyToContinue?: () => void
}

/**
 * 写后自检明细：按 fail → warn → pass → skip 排序，可折叠展开。
 */
export default function ChapterSelfCheckPanel(props: Props) {
  const {
    report,
    onRerun,
    rerunLoading,
    defaultExpanded,
    compact,
    onApplyToRewrite,
    onApplyToContinue
  } = props
  const [expanded, setExpanded] = useState(defaultExpanded ?? true)
  const [filter, setFilter] = useState<'all' | 'issues'>('issues')
  const hasIssues = selfCheckHasActionableIssues(report)

  const sorted = useMemo(() => {
    if (!report?.items?.length) return [] as SelfCheckItemResult[]
    const rank: Record<SelfCheckVerdict, number> = {
      fail: 0,
      warn: 1,
      pass: 2,
      skip: 3
    }
    return [...report.items].sort((a, b) => rank[a.verdict] - rank[b.verdict])
  }, [report])

  const visible = useMemo(() => {
    if (filter === 'issues') {
      return sorted.filter((i) => i.verdict === 'fail' || i.verdict === 'warn')
    }
    return sorted
  }, [sorted, filter])

  if (!report) {
    return (
      <div className={`self-check-panel${compact ? ' self-check-compact' : ''}`}>
        <div className="self-check-head">
          <strong className="self-check-title">写后自检</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            续写完成后自动对照清单
          </span>
          {onRerun ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => void onRerun()}
              disabled={rerunLoading}
            >
              {rerunLoading ? '检查中…' : '✦ 立即自检'}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const { counts } = report
  const issueCount = counts.fail + counts.warn
  const statusClass = !report.ok
    ? 'self-check-status-fail'
    : counts.warn > 0
      ? 'self-check-status-warn'
      : 'self-check-status-ok'

  return (
    <div className={`self-check-panel${compact ? ' self-check-compact' : ''} ${statusClass}`}>
      <div className="self-check-head">
        <button
          type="button"
          className="self-check-toggle"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          <span className="self-check-chevron">{expanded ? '▼' : '▶'}</span>
          <strong className="self-check-title">写后自检</strong>
        </button>
        <span className={`self-check-badge ${statusClass}`}>
          {report.ok
            ? counts.warn > 0
              ? `${counts.warn} 项留意`
              : '全部通过'
            : `${counts.fail} 项失败`}
        </span>
        <span className="muted self-check-counts" style={{ fontSize: 11.5 }}>
          通过 {counts.pass} · 留意 {counts.warn} · 失败 {counts.fail}
          {counts.skip > 0 ? ` · 跳过 ${counts.skip}` : ''}
        </span>
        {onRerun ? (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => void onRerun()}
            disabled={rerunLoading}
            title="用当前编辑器正文重新跑自检"
          >
            {rerunLoading ? '检查中…' : '重新检查'}
          </button>
        ) : null}
      </div>

      <p className="self-check-summary muted">{report.summary}</p>
      <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
        启发式检查（关键词/章末形态），供参考，不能替代人工通读。
      </p>

      {hasIssues && (onApplyToRewrite || onApplyToContinue) ? (
        <div className="self-check-actions">
          {onApplyToRewrite ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onApplyToRewrite}
              title="根据失败/留意项生成修改要求，打开「按要求重写」"
            >
              按自检改正文
            </button>
          ) : null}
          {onApplyToContinue ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onApplyToContinue}
              title="把自检项填入续写临时要求"
            >
              填入续写临时要求
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <>
          <div className="self-check-filters">
            <button
              type="button"
              className={`btn btn-ghost btn-sm${filter === 'issues' ? ' is-active' : ''}`}
              onClick={() => setFilter('issues')}
            >
              仅问题 ({issueCount})
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${filter === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              全部 ({sorted.length})
            </button>
          </div>

          {visible.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {filter === 'issues' ? '没有失败或需留意的项。' : '无检查项。'}
            </p>
          ) : (
            <ul className="self-check-list">
              {visible.map((item) => (
                <li key={item.id} className={`self-check-item self-check-item-${item.verdict}`}>
                  <span className={verdictClass(item.verdict)} title={VERDICT_LABEL[item.verdict]}>
                    {itemIcon(item.verdict)}
                  </span>
                  <div className="self-check-item-body">
                    <div className="self-check-item-label">
                      <span className="self-check-cat">{CATEGORY_LABEL[item.category]}</span>
                      {item.label}
                    </div>
                    <div className="self-check-item-detail muted">{item.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  )
}
