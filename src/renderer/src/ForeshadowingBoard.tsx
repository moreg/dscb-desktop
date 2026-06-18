import { useEffect, useState } from 'react'
import type { Foreshadowing, ForeshadowingStatus } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
}

const COLUMNS: { status: ForeshadowingStatus; label: string; color: string }[] = [
  { status: 'pending', label: '待埋', color: '#64748b' },
  { status: 'planted', label: '已埋', color: '#d97706' },
  { status: 'collected', label: '已收', color: '#059669' },
  { status: 'missed', label: '遗漏', color: '#e11d48' }
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack}>← 返回记忆中心</button>
        <button onClick={create}>+ 新建伏笔</button>
      </div>
      <h2>伏笔看板</h2>
      {loading ? (
        <p>加载中…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {COLUMNS.map((col) => {
            const list = items.filter((f) => f.status === col.status)
            return (
              <div
                key={col.status}
                style={{ background: '#f8fafc', borderRadius: 10, padding: 10 }}
              >
                <div style={{ fontWeight: 700, color: col.color, marginBottom: 8 }}>
                  {col.label}（{list.length}）
                </div>
                {list.map((f) => (
                  <div
                    key={f.id}
                    style={{
                      background: '#fff',
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      padding: 10,
                      marginBottom: 8
                    }}
                  >
                    <div style={{ fontSize: 14 }}>{f.content}</div>
                    <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>
                      {f.plantChapter ? `埋:${f.plantChapter} ` : ''}
                      {f.expectedCollect ? `预收:${f.expectedCollect} ` : ''}
                      {f.actualCollect ? `实收:${f.actualCollect}` : ''}
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {f.status === 'pending' ? (
                        <button onClick={() => plant(f)}>埋设</button>
                      ) : null}
                      {f.status === 'planted' ? (
                        <>
                          <button onClick={() => collect(f)}>回收</button>
                          <button onClick={() => markMissed(f)}>遗漏</button>
                        </>
                      ) : null}
                      <button onClick={() => remove(f)}>删除</button>
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
