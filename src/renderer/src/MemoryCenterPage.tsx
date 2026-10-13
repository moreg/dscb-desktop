import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryEntityType } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenCharacters: () => void
  onOpenEntity: (type: MemoryEntityType) => void
  onOpenForeshadowings: () => void
  onOpenRelationships: () => void
}

interface EntityMeta {
  type: MemoryEntityType
  label: string
  desc: string
  icon: string
  hint: string
}

const ENTITIES: EntityMeta[] = [
  { type: 'location', label: '地点', desc: '城池 · 山川 · 门派 · 场所', icon: '🏯', hint: '标注所属势力与首次登场' },
  { type: 'worldview', label: '世界观', desc: '体系 · 势力 · 规则 · 设定', icon: '☯', hint: '功法体系 / 修炼境界' },
  { type: 'timeline', label: '时间线', desc: '按章铺陈的关键事件', icon: '⌛', hint: '关联到具体章节号' },
  { type: 'plot_point', label: '剧情点', desc: '故事弧 · 转折 · 高潮', icon: '✦', hint: '与人物/伏笔联动' },
  { type: 'item', label: '道具', desc: '法宝 · 兵器 · 灵物 · 信物', icon: '🗡️', hint: '标注持有者与来历' }
]

export default function MemoryCenterPage({
  projectId,
  onOpenCharacters,
  onOpenEntity,
  onOpenForeshadowings,
  onOpenRelationships
}: Props) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [characterCount, setCharacterCount] = useState(0)
  const [foreshadowingCount, setForeshadowingCount] = useState(0)
  const [pendingForeshadowing, setPendingForeshadowing] = useState(0)
  const [relationshipCount, setRelationshipCount] = useState(0)
  const [syncStatus, setSyncStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; added: number; updated: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const refreshSequence = useRef({ value: 0 })
  const refresh = useCallback(async () => {
    const tracker = refreshSequence.current
    const sequence = ++tracker.value
    try {
      const statistics = await window.api.getMemoryStatistics(projectId)
      if (sequence !== tracker.value) return
      setCharacterCount(statistics.counts.character)
      setForeshadowingCount(statistics.counts.foreshadowing)
      setPendingForeshadowing(statistics.pendingForeshadowing)
      setRelationshipCount(statistics.counts.relationship)
      setCounts(statistics.counts)
    } catch (error) {
      if (sequence === tracker.value) {
        setSyncStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }, [projectId])

  useEffect(() => {
    const tracker = refreshSequence.current
    void refresh()
    const unsubscribe = window.api.onProjectFilesChanged(event => {
      if (event.projectId === projectId && ['memory', 'characters', 'outline'].includes(event.kind)) void refresh()
    })
    return () => {
      tracker.value++
      unsubscribe()
    }
  }, [projectId, refresh])

  const onSync = async () => {
    setSyncStatus({ kind: 'running' })
    try {
      const report = await window.api.syncMemoryIndex(projectId)
      setSyncStatus({ kind: 'done', added: report.added, updated: report.updated })
      refresh()
      // 3 秒后自动消失
      setTimeout(() => setSyncStatus((s) => (s.kind === 'done' ? { kind: 'idle' } : s)), 3000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSyncStatus({ kind: 'error', message })
    }
  }

  return (
    <div>
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1>记忆中心</h1>
            <p className="desc">人物 · 伏笔 · 关系 · 世界设定一览</p>
          </div>
          <div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onSync}
              disabled={syncStatus.kind === 'running'}
              title="从 设定/ + 追踪/ + 细纲/ 增量同步到 记忆/"
            >
              {syncStatus.kind === 'running' ? '同步中…' : '🔄 刷新记忆索引'}
            </button>
            {syncStatus.kind === 'done' ? (
              <span style={{ marginLeft: 8, color: 'var(--success, #5a8c5a)' }}>
                ✓ 同步完成：新增 {syncStatus.added}，更新 {syncStatus.updated}
              </span>
            ) : null}
            {syncStatus.kind === 'error' ? (
              <span style={{ marginLeft: 8, color: 'var(--warning)' }}>⚠ {syncStatus.message}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card-grid">
        <div className="card card-hover" onClick={onOpenCharacters}>
          <div className="memory-card">
            <div className="memory-icon">🧑</div>
            <div>
              <strong style={{ fontSize: 16 }}>人物</strong>
              <div className="muted">角色档案 · 性格 · 出场章节</div>
              <div className="memory-stats">
                <span><span className="num">{characterCount}</span>个人物</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card card-hover" onClick={onOpenForeshadowings}>
          <div className="memory-card">
            <div className="memory-icon">📌</div>
            <div>
              <strong style={{ fontSize: 16 }}>伏笔</strong>
              <div className="muted">埋设与回收 · 状态看板</div>
              <div className="memory-stats">
                <span><span className="num">{foreshadowingCount}</span>条</span>
                {pendingForeshadowing > 0 ? (
                  <span style={{ color: 'var(--warning)' }}>
                    待处理 {pendingForeshadowing}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="card card-hover" onClick={onOpenRelationships}>
          <div className="memory-card">
            <div className="memory-icon">🔗</div>
            <div>
              <strong style={{ fontSize: 16 }}>人物关系</strong>
              <div className="muted">师徒 · 敌我 · 情缘</div>
              <div className="memory-stats">
                <span><span className="num">{relationshipCount}</span>条关系</span>
              </div>
            </div>
          </div>
        </div>

        {ENTITIES.map((e) => (
          <div
            key={e.type}
            className="card card-hover"
            onClick={() => onOpenEntity(e.type)}
          >
            <div className="memory-card">
              <div className="memory-icon">{e.icon}</div>
              <div>
                <strong style={{ fontSize: 16 }}>{e.label}</strong>
                <div className="muted">{e.desc}</div>
                <div className="memory-stats">
                  <span><span className="num">{counts[e.type] ?? 0}</span>条</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
