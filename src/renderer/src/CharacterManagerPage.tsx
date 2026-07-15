import { useEffect, useMemo, useState } from 'react'
import MarkdownView, { rawFieldsToMarkdown } from './MarkdownView'
import type { Character, ChapterMeta, CreateCharacterInput } from '../../shared/types'

interface Props {
  projectId: string
  onBack: () => void
  onOpenChapter?: (n: number) => void
}

const EMPTY: CreateCharacterInput = {
  name: '',
  role: '',
  identity: '',
  personality: '',
  abilities: '',
  tags: [],
  synopsis: ''
}

const ROLE_BUCKETS: { match: string[]; label: string; cls: string }[] = [
  { match: ['主角'], label: '主角', cls: 'role-protagonist' },
  { match: ['配角', '女主', '男主'], label: '重要角色', cls: 'role-supporting' },
  { match: ['反派', 'BOSS', 'boss', '敌'], label: '反派', cls: 'role-antagonist' }
]

function bucketOf(c: Character): { label: string; cls: string } {
  const r = c.role ?? ''
  for (const b of ROLE_BUCKETS) if (b.match.some((m) => r.includes(m))) return b
  return { label: '其他', cls: 'role-extra' }
}

function avatarOf(name: string): string {
  return name.trim().slice(0, 1) || '·'
}

export default function CharacterManagerPage({ projectId, onOpenChapter }: Props) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id: string; input: CreateCharacterInput } | null>(null)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const [keyword, setKeyword] = useState('')

  const refresh = () => {
    setLoading(true)
    void window.api.listCharacters(projectId).then((list) => {
      setCharacters(list)
      setLoading(false)
    })
  }

  const refreshChapters = () => {
    void window.api.listChapters(projectId).then(setChapters)
  }

  useEffect(() => {
    refresh()
    refreshChapters()
    const onFocus = () => refreshChapters()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectId])

  const startEdit = (c: Character) =>
    setEditing({
      id: c.id,
      input: {
        name: c.name,
        role: c.role ?? '',
        identity: c.identity ?? '',
        personality: c.personality ?? '',
        abilities: c.abilities ?? '',
        tags: c.tags ?? [],
        synopsis: c.synopsis ?? ''
      }
    })

  const remove = async (c: Character) => {
    if (!window.confirm(`删除「${c.name}」？`)) return
    await window.api.deleteCharacter(projectId, c.id)
    refresh()
  }

  // 出场章节反向索引：人物 id → 章节号[]
  const appearingMap = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const ch of chapters) {
      for (const id of ch.appearingCharacters ?? []) {
        if (!map.has(id)) map.set(id, [])
        map.get(id)!.push(ch.chapterNumber)
      }
    }
    for (const arr of map.values()) arr.sort((a, b) => a - b)
    return map
  }, [chapters])

  const filtered = useMemo(() => {
    return characters.filter((c) => {
      if (filter !== 'all' && bucketOf(c).label !== filter) return false
      if (keyword) {
        const k = keyword.toLowerCase()
        const hay = [c.name, c.role, c.identity, c.personality, ...(c.tags ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(k)) return false
      }
      return true
    })
  }, [characters, filter, keyword])

  const grouped = useMemo(() => {
    const groups = new Map<string, Character[]>()
    for (const c of filtered) {
      const b = bucketOf(c)
      if (!groups.has(b.label)) groups.set(b.label, [])
      groups.get(b.label)!.push(c)
    }
    // 保持固定顺序：主角 → 重要角色 → 反派 → 其他
    const ordered: { label: string; cls: string; list: Character[] }[] = []
    for (const b of ROLE_BUCKETS) {
      const list = groups.get(b.label)
      if (list && list.length) ordered.push({ label: b.label, cls: b.cls, list })
    }
    const others = groups.get('其他')
    if (others && others.length) ordered.push({ label: '其他', cls: 'role-extra', list: others })
    return ordered
  }, [filtered])

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>人物档案</h1>
            <p className="desc">登场角色 · {characters.length} 位</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + 新人物
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="filters">
          <span
            className={`filter-chip ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部 · {characters.length}
          </span>
          {ROLE_BUCKETS.map((b) => {
            const count = characters.filter((c) => bucketOf(c).label === b.label).length
            return (
              <span
                key={b.label}
                className={`filter-chip ${filter === b.label ? 'active' : ''}`}
                onClick={() => setFilter(b.label)}
              >
                {b.label} · {count}
              </span>
            )
          })}
        </div>
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="搜索名字 / 性格 / 标签"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {loading ? (
        <p className="empty">展卷中…</p>
      ) : characters.length === 0 ? (
        <div className="placeholder">
          <p style={{ margin: '0 0 12px' }}>尚无人物。点「+ 新人物」开始登场。</p>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            + 新人物
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="empty">没有匹配的人物。</p>
      ) : (
        grouped.map((g) => (
          <section key={g.label} className="char-group">
            <h4 className="char-group-title">
              {g.label} <span className="count">{g.list.length}</span>
            </h4>
            <ul className="bare">
              {g.list.map((c) => {
                const appears = appearingMap.get(c.id) ?? []
                return (
                  <li key={c.id} className="card">
                    <div className="char-card">
                      <div className="char-avatar">{avatarOf(c.name)}</div>
                      <div>
                        <div className="char-name-row">
                          <span className="char-name">{c.name}</span>
                          {c.role ? (
                            <span className={`chip ${g.cls}`}>{c.role}</span>
                          ) : null}
                          {(c.tags ?? []).slice(0, 3).map((t) => (
                            <span key={t} className="chip">{t}</span>
                          ))}
                        </div>
                        {(() => {
                          // v4：合并显示 first-class + customFields（不再互斥）
                          const cf = c.customFields ?? c.rawFields
                          return (
                            <>
                              {(c.identity || c.personality || c.abilities) ? (
                                <div className="char-meta">
                                  {c.identity ? (
                                    <span>
                                      <span className="label">身份</span>
                                      <span className="val"> · {c.identity}</span>
                                    </span>
                                  ) : null}
                                  {c.personality ? (
                                    <span>
                                      <span className="label">性格</span>
                                      <span className="val"> · {c.personality}</span>
                                    </span>
                                  ) : null}
                                  {c.abilities ? (
                                    <span>
                                      <span className="label">能力</span>
                                      <span className="val"> · {c.abilities}</span>
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                              {c.synopsis ? <p className="char-body">{c.synopsis}</p> : null}
                              {cf && Object.keys(cf).length > 0 ? (
                                <div className="char-full" style={{ marginTop: 6 }}>
                                  <MarkdownView
                                    sections={[{ title: '', body: rawFieldsToMarkdown(cf) }]}
                                  />
                                </div>
                              ) : null}
                            </>
                          )
                        })()}
                        {appears.length > 0 ? (
                          <div className="outline-tags" style={{ marginTop: 8 }}>
                            <span className="outline-tag">出场</span>
                            {appears.map((n) => (
                              <span
                                key={n}
                                className="outline-tag emotion"
                                style={{
                                  cursor: onOpenChapter ? 'pointer' : 'default'
                                }}
                                onClick={() => onOpenChapter?.(n)}
                              >
                                第 {n} 章
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="char-actions">
                        <button className="btn btn-sm" onClick={() => startEdit(c)}>
                          编辑
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>
                          删除
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))
      )}

      {creating ? (
        <CharacterDialog
          title="新建人物"
          initial={EMPTY}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            await window.api.createCharacter(projectId, trimInput(input))
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
      {editing ? (
        <CharacterDialog
          title="编辑人物"
          initial={editing.input}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await window.api.updateCharacter(projectId, editing.id, trimInput(input))
            setEditing(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function trimInput(input: CreateCharacterInput): CreateCharacterInput {
  return {
    name: input.name.trim(),
    role: input.role?.trim() || undefined,
    identity: input.identity?.trim() || undefined,
    personality: input.personality?.trim() || undefined,
    abilities: input.abilities?.trim() || undefined,
    tags: input.tags?.filter((t) => t.trim()).map((t) => t.trim()),
    synopsis: input.synopsis?.trim() || undefined
  }
}

function CharacterDialog({
  title,
  initial,
  onClose,
  onSubmit
}: {
  title: string
  initial: CreateCharacterInput
  onClose: () => void
  onSubmit: (input: CreateCharacterInput) => Promise<void>
}) {
  const [input, setInput] = useState<CreateCharacterInput>(initial)
  const [tagsRaw, setTagsRaw] = useState((initial.tags ?? []).join('、'))
  const [saving, setSaving] = useState(false)
  const f = (key: keyof CreateCharacterInput) => ({
    value: (input[key] as string) ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setInput({ ...input, [key]: e.target.value })
  })
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>名称 *</label>
            <input className="input" {...f('name')} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>角色</label>
            <input className="input" {...f('role')} placeholder="主角 / 配角 / 反派" />
          </div>
        </div>
        <div className="field">
          <label>身份</label>
          <input className="input" {...f('identity')} />
        </div>
        <div className="field">
          <label>性格</label>
          <input className="input" {...f('personality')} />
        </div>
        <div className="field">
          <label>能力 / 功法 / 武器</label>
          <input className="input" {...f('abilities')} />
        </div>
        <div className="field">
          <label>标签（用「、」分隔）</label>
          <input
            className="input"
            value={tagsRaw}
            onChange={(e) => {
              setTagsRaw(e.target.value)
              setInput({
                ...input,
                tags: e.target.value.split(/[、,，]/).map((t) => t.trim()).filter(Boolean)
              })
            }}
            placeholder="天玄宗、剑修、女主"
          />
        </div>
        <div className="field">
          <label>人物小传</label>
          <textarea
            className="textarea"
            value={input.synopsis ?? ''}
            onChange={(e) => setInput({ ...input, synopsis: e.target.value })}
            rows={5}
            placeholder="出身、动机、与主线的关系…"
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || !input.name.trim()}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit(input)
              } finally {
                setSaving(false)
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
