import { useMemo, useState } from 'react'
import type {
  ChapterSelfCheckReport,
  SelfCheckCategory,
  SelfCheckItemResult,
  SelfCheckVerdict
} from '../../shared/types'
import {
  selfCheckHasActionableIssues
} from '../../shared/self-check-to-requirements'
import { selfCheckPresentation } from './chapterSelfCheckState'

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
  stale?: boolean
  error?: string | null
  /** 重新对当前正文跑自检 */
  onRerun?: () => void | Promise<void>
  rerunLoading?: boolean
  /** 默认展开 fail/warn */
  defaultExpanded?: boolean
  /** 紧凑模式（嵌在同步条下） */
  compact?: boolean
  /**
   * 本章仍在分轮续写中（上轮是 extend），正文是**故意没写完**的半成品。
   * 完成度类项（核心事件 / 到期伏笔）此时失败属正常，标注出来免得用户误当缺陷去修。
   */
  partialChapter?: boolean
  /**
   * 一键：把失败/留意项生成「按要求重写」指令并打开重写对话框。
   */
  onApplyToRewrite?: () => void
  /**
   * 一键：把失败/留意项填入续写「临时写作要求」并打开续写确认框。
   */
  onApplyToContinue?: () => void
  /**
   * 一键标点兜底（确定性替换破折号/省略号，零 LLM）。
   * 只挂在 punctuation_rule 这一项上——它是唯一能不动语义就修好的自检项，
   * 走「按自检改正文」等于为了把 —— 换成 。 烧一次 token。
   */
  onFixPunctuation?: () => void | Promise<void>
  fixPunctuationLoading?: boolean
}

/**
 * 写后自检明细：按 fail → warn → pass → skip 排序，可折叠展开。
 */
export default function ChapterSelfCheckPanel(props: Props) {
  const {
    report,
    stale,
    error,
    onRerun,
    rerunLoading,
    defaultExpanded,
    compact,
    partialChapter,
    onApplyToRewrite,
    onApplyToContinue,
    onFixPunctuation,
    fixPunctuationLoading
  } = props
  const [expanded, setExpanded] = useState(defaultExpanded ?? true)
  const [filter, setFilter] = useState<'all' | 'issues'>('issues')
  const hasIssues = selfCheckHasActionableIssues(report)
  const actionsDisabled = stale || !!error || rerunLoading || fixPunctuationLoading

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
            {error || '续写完成后自动对照清单'}
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

  const { counts, deferred, label, status } = selfCheckPresentation(report, partialChapter)
  const issueCount = counts.fail + counts.warn + deferred.size
  const statusClass = `self-check-status-${stale || error ? 'warn' : status}`
  const hasCurrentIssues = selfCheckHasActionableIssues({
    ...report, items: report.items.filter((item) => !deferred.has(item.id))
  })

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
          {stale ? '结果已过期' : error ? '检查未完成' : label}
        </span>
        <span className="muted self-check-counts" style={{ fontSize: 11.5 }}>
          通过 {counts.pass} · 留意 {counts.warn} · 失败 {counts.fail}
          {counts.skip > 0 ? ` · 跳过 ${counts.skip}` : ''}
          {deferred.size > 0 ? ` · 待写完 ${deferred.size}` : ''}
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

      <p className="self-check-summary muted" role={stale || error ? 'status' : undefined}>
        {stale ? '正文已变化，以下为修改前的结果。重新检查后才能应用自检要求。' :
          error || (deferred.size > 0 ? `当前需处理 ${counts.fail + counts.warn} 项，${deferred.size} 项留待本章写完后检查。` :
            counts.skip > 0 && counts.fail === 0 && counts.warn === 0 ? label : report.summary)}
      </p>
      {counts.skip > 0 && !stale ? (
        <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
          {counts.skip} 项未能判定；可在「全部」查看跳过原因，补齐依据后重新检查。
        </p>
      ) : null}
      {partialChapter ? (
        <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
          本章仍在分轮续写中：标「待写完」的项要整章写完才作数，现在失败是正常的，不必为它硬收尾。
        </p>
      ) : null}
      <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
        启发式检查（关键词/章末形态），供参考，不能替代人工通读。
      </p>

      {hasIssues && (onApplyToRewrite || onApplyToContinue) ? (
        <div className="self-check-actions">
          {onApplyToRewrite && hasCurrentIssues ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onApplyToRewrite}
              disabled={actionsDisabled}
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
              disabled={actionsDisabled}
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
              {deferred.size > 0 ? '问题 / 待写完' : '仅问题'} ({issueCount})
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
                <li key={item.id} className={`self-check-item self-check-item-${deferred.has(item.id) ? 'warn' : item.verdict}`}>
                  <span className={verdictClass(deferred.has(item.id) ? 'skip' : item.verdict)}
                    title={deferred.has(item.id) ? '待写完' : VERDICT_LABEL[item.verdict]}>
                    {itemIcon(deferred.has(item.id) ? 'skip' : item.verdict)}
                  </span>
                  <div className="self-check-item-body">
                    <div className="self-check-item-label">
                      <span className="self-check-cat">{CATEGORY_LABEL[item.category]}</span>
                      {item.label}
                      {deferred.has(item.id) ? (
                        <span
                          className="self-check-cat"
                          style={{ marginLeft: 6 }}
                          title="本章还没写完，这项要整章写完才作数"
                        >
                          待写完
                        </span>
                      ) : null}
                    </div>
                    <div className="self-check-item-detail muted">{item.detail}</div>
                    {item.id === 'punctuation_rule' && item.verdict === 'warn' && onFixPunctuation ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginTop: 6 }}
                        disabled={actionsDisabled}
                        onClick={() => void onFixPunctuation()}
                        title="确定性替换：—— / — / -- 改逗号或句号，…… / … 改句号。不调 LLM，可撤销"
                      >
                        {fixPunctuationLoading ? '替换中…' : '⚡ 一键替换标点'}
                      </button>
                    ) : null}
                    {item.missing?.length ? (
                      <ul className="self-check-missing muted">
                        {item.missing.map((m, index) => (
                          <li key={`${item.id}-${index}`}>{m}</li>
                        ))}
                      </ul>
                    ) : null}
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
