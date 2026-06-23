import type { ProjectData, StyleProfile } from '../../../../shared/types'

interface Props {
  profiles: StyleProfile[]
  projectData: ProjectData | null
  selectedId: string | null
  onSelect: (id: string) => void
  onSetDefault: (id: string | null) => Promise<void>
  onStartEdit: (id: string) => void
  onDelete: (profile: StyleProfile) => Promise<void>
}

/**
 * 左侧 320px 卡片列表：标题 + 卡片（含默认徽章 / 设为默认 / 编辑 / 删除）+ 清空默认按钮。
 */
export default function StyleProfileSidebar({
  profiles,
  projectData,
  selectedId,
  onSelect,
  onSetDefault,
  onStartEdit,
  onDelete
}: Props) {
  return (
    <div className="card" style={{ flex: '0 0 320px', minWidth: 280 }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h3 className="sub" style={{ margin: 0 }}>文风卡</h3>
        <span className="meta" style={{ marginLeft: 'auto' }}>
          {profiles.length} 个
        </span>
      </div>
      {profiles.length === 0 ? (
        <div className="placeholder" style={{ padding: 12 }}>
          还没有文风卡。先在右侧粘贴样文做一次提取。
        </div>
      ) : (
        <ul className="bare" style={{ display: 'grid', gap: 10 }}>
          {profiles.map((profile) => {
            const isDefault = projectData?.defaultStyleProfileId === profile.id
            return (
              <li
                key={profile.id}
                className="card card-hover"
                style={{
                  padding: 12,
                  borderColor: selectedId === profile.id ? 'var(--vermilion)' : undefined
                }}
              >
                <button
                  type="button"
                  className="link-btn"
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => onSelect(profile.id)}
                >
                  <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                    <strong>{profile.name}</strong>
                    {isDefault ? <span className="chip chip-success">默认</span> : null}
                  </div>
                  <div className="meta" style={{ marginTop: 6 }}>{profile.identifiedStyle}</div>
                </button>
                <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void onSetDefault(profile.id)}
                    disabled={isDefault}
                  >
                    设为默认
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onStartEdit(profile.id)}
                  >
                    编辑
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => void onDelete(profile)}
                  >
                    删除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {projectData?.defaultStyleProfileId ? (
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => void onSetDefault(null)}
        >
          清空项目默认文风
        </button>
      ) : null}
    </div>
  )
}
