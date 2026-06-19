import { useEffect, useState } from 'react'
import type { Foreshadowing, ForeshadowingStatus } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

const COLUMNS: { status: ForeshadowingStatus; label: string; chip: string }[] = [
  { status: 'pending', label: '待埋', chip: '' },
  { status: 'planted', label: '已埋', chip: 'warning' },
  { status: 'collected', label: '已收', chip: 'success' },
  { status: 'missed', label: '遗漏', chip: 'danger' }
]

export default function ForeshadowingBoard({ projectId, onBack }: Props) {
  const [items, setItems] = useState<Foreshadowing[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    void window.api.listForeshadowings(projectId).then((list) => {
      setItems(list)
      setLoading(false)
    })
  }

  useEffect(refresh, [projectId])

  const create = async () => {
    const content = window.prompt('伏笔内容')
    if (!content) return
    const expected = window.prompt('预期回收章节（可留空）', '')
    await window.api.createForeshadowing(projectId, {
      content,
      expectedCollect: expected ? Number(expected) : undefined
    })
    refresh()
  }

  const plant = async (f: Foreshadowing) => {
    const n = window.prompt('埋设章节号', String(f.plantChapter ?? 1))
    if (!n) return
    await window.api.plantForeshadowing(projectId, f.id, Number(n))
    refresh()
  }

  const collect = async (f: Foreshadowing) => {
    const n = window.prompt('回收章节号', String(f.expectedCollect ?? f.plantChapter ?? 1))
    if (!n) return
    await window.api.collectForeshadowing(projectId, f.id, Number(n))
    refresh()
  }

  const markMissed = async (f: Foreshadowing) => {
    if (!window.confirm('标记为遗漏？')) return
    await window.api.markForeshadowingMissed(projectId, f.id)
    refresh()
  }

  const remove = async (f: Foreshadowing) => {
    if (!window.confirm('删除该伏笔？')) return
    await window.api.deleteForeshadowing(projectId, f.id)
    refresh()
  }

  return (
    <div>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ‹ 记忆中心
        </button>
        <button className="btn btn-primary btn-sm" onClick={create}>
          + 新伏笔
        </button>
      </div>
      <h2 className="section mt">伏笔看板</h2>
      {loading ? (
        <p className="empty">展卷中…</p>
      ) : (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const list = items.filter((f) => f.status === col.status)
            return (
              <div key={col.status} className="kanban-col">
                <h4 style={{ color: col.chip ? `var(--${col.chip === 'warning' ? 'warning' : col.chip === 'success' ? 'success' : 'danger'})` : 'var(--ink-2)' }}>
                  {col.label}（{list.length}）
                </h4>
                {list.map((f) => (
                  <div key={f.id} className="card" style={{ marginBottom: 8, padding: 10 }}>
                    <div style={{ fontSize: 14 }}>{f.content}</div>
                    <div className="meta" style={{ marginTop: 4 }}>
                      {f.plantChapter ? `埋:${f.plantChapter} ` : ''}
                      {f.expectedCollect ? `预收:${f.expectedCollect} ` : ''}
                      {f.actualCollect ? `实收:${f.actualCollect}` : ''}
                    </div>
                    <div className="btn-group" style={{ marginTop: 6 }}>
                      {f.status === 'pending' ? (
                        <button className="btn btn-sm" onClick={() => plant(f)}>
                          埋设
                        </button>
                      ) : null}
                      {f.status === 'planted' ? (
                        <>
                          <button className="btn btn-sm" onClick={() => collect(f)}>
                            回收
                          </button>
                          <button className="btn btn-sm" onClick={() => markMissed(f)}>
                            遗漏
                          </button>
                        </>
                      ) : null}
                      <button className="btn btn-sm btn-danger" onClick={() => remove(f)}>
                        删
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
