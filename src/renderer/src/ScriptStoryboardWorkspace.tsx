import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { GateIssue, PaceTier, QualityReport, ScriptProject, ShotField, StoryboardUnit } from '../../shared/script-studio'
import { PACE_LABELS, paceExecution } from '../../shared/script-studio-planning'

interface StoryboardWorkspaceProps {
  project: ScriptProject | null
  units: StoryboardUnit[]
  quality: QualityReport | null
  hardIssues: GateIssue[]
  fields: readonly ShotField[]
  labels: Record<ShotField, string>
  dirty: boolean
  saveBlocked: boolean
  busy: boolean
  stale: boolean
  onFieldChange: (unitId: string, shotIndex: number, field: ShotField, value: string) => void
  onUnitChange: (unitId: string, patch: Partial<StoryboardUnit>) => void
  onRegenerate: (unitId: string) => void
  onGenerateAll: () => void
  onSave: () => void
}

export default function ScriptStoryboardWorkspace({ project, units, quality, hardIssues, fields, labels, dirty,
  saveBlocked, busy, stale, onFieldChange, onUnitChange, onRegenerate, onGenerateAll, onSave }: StoryboardWorkspaceProps): ReactElement {
  const [selectedId, setSelectedId] = useState('')
  const [selectedShot, setSelectedShot] = useState(0)
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null)
  const unit = units.find(item => item.id === selectedId) ?? units[0]
  const shotIndex = unit ? Math.min(selectedShot, Math.max(0, unit.shots.length - 1)) : 0
  const shot = unit?.shots[shotIndex]
  const total = units.reduce((sum, item) => sum + item.durationSec, 0)
  const issues = [...hardIssues, ...(quality?.warnings ?? [])]
  const blockedReason = busy ? '正在处理，请等待完成。' : !units.length ? '请先生成分镜。'
    : saveBlocked ? '分镜生成依据缺失或已过期，请重新生成全部分镜。' : hardIssues.length ? `还有 ${hardIssues.length} 项阻断问题，修复后可保存。` : ''

  useEffect(() => {
    if (focusTarget && typeof document !== 'undefined') document.getElementById(focusTarget.id)?.focus()
  }, [focusTarget, unit?.id, shotIndex])

  const chooseUnit = (id: string): void => { setSelectedId(id); setSelectedShot(0); setFocusTarget(null) }
  const locate = (issue: GateIssue): void => {
    const target = units.find(item => item.id === issue.unitId) ?? unit
    if (!target) return
    const index = Math.min(Math.max(0, target.shots.length - 1), Math.max(0, Number(issue.message.match(/镜头\s*(\d+)/)?.[1] ?? 1) - 1))
    setSelectedId(target.id); setSelectedShot(index)
    setFocusTarget({ id: issue.field ? `ss-shot-${target.id}-${index}-${issue.field}` : `ss-unit-${target.id}-duration` })
  }

  return (
    <div className="ss-stack">
      <div className="ss-workbar" role="region" aria-label="分镜操作栏">
        <div>
          <h2>视频分镜</h2>
          <p className="ss-muted">{units.length} 个单元 · {units.reduce((sum, item) => sum + item.shots.length, 0)} 镜 · {total} 秒
            {project ? ` / 目标 ${project.settings.targetDurationSec} 秒` : ''}</p>
        </div>
        <span className={`ss-save-state ${dirty ? 'ss-save-state-dirty' : ''}`} role="status">
          {dirty ? '有未保存修改' : units.length ? '与已保存分镜一致' : '等待生成'}
        </span>
        <div className="ss-actions">
          <button type="button" className="btn btn-sm" disabled={busy || !project?.activeVersionId} onClick={onGenerateAll}>生成 / 重新生成分镜</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!blockedReason} title={blockedReason || '保存全部分镜修改'} aria-describedby="ss-save-hint" onClick={onSave}>保存分镜</button>
        </div>
        <p id="ss-save-hint" className={blockedReason ? 'ss-inline-warning' : 'ss-muted'}>
          {blockedReason || '保存全部单元；保存时将再次核对正式稿台词。'}
        </p>
      </div>

      {!unit ? <div className="ss-empty"><h3>从正式稿开始拆分镜头</h3><p>生成分镜后，在目录中选择单元，逐镜调整动作、台词和摄影机执行。</p></div> : (
        <div className="ss-workspace">
          <nav className="ss-unit-nav ss-card" aria-label="分镜单元目录">
            <div className="ss-panel-heading"><h3>单元目录</h3><span>{units.length} 段</span></div>
            <div className="ss-unit-nav-list">
              {units.map(item => {
                const errors = hardIssues.filter(issue => issue.unitId === item.id).length
                return <button key={item.id} type="button" className={`ss-unit-link ${unit.id === item.id ? 'ss-unit-link-active' : ''}`}
                  aria-current={unit.id === item.id ? 'true' : undefined} onClick={() => chooseUnit(item.id)}>
                  <span className="ss-unit-link-top"><strong>第 {item.index} 段</strong><span>{item.durationSec} 秒</span></span>
                  <span className="ss-unit-link-action">{item.dramaticAction || '待补充戏剧动作'}</span>
                  <span className="ss-unit-link-bottom">{item.shots.length} 镜 · {errors ? `${errors} 项阻断` : PACE_LABELS[item.paceTier]}</span>
                </button>
              })}
            </div>
          </nav>

          <section className="ss-card ss-unit-editor" aria-label="当前单元编辑">
            <div className="ss-card-head">
              <div><p className="ss-eyebrow">第 {unit.index} 段 / 共 {units.length} 段</p><h3>{unit.dramaticAction || '当前单元'}</h3></div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy || saveBlocked} title={saveBlocked ? blockedReason : '重生成当前单元，保留其余单元'} onClick={() => onRegenerate(unit.id)}>按段重生成</button>
            </div>
            <div className="ss-unit-controls">
              <label>单元时长（秒）<input id={`ss-unit-${unit.id}-duration`} aria-label={`${unit.id} 时长`} className="input" type="number" min={4} max={15} step={0.5}
                value={unit.durationSec} disabled={busy} onChange={event => onUnitChange(unit.id, { durationSec: Number(event.target.value) })} /></label>
              <label>本段节奏档位<select aria-label={`${unit.id} 节奏档位`} className="select" value={unit.paceTier} disabled={busy}
                onChange={event => onUnitChange(unit.id, { paceTier: event.target.value as PaceTier })}>
                {Object.entries(PACE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
            </div>
            <details className="ss-details">
              <summary>节奏执行与慢镜头功能</summary>
              <div className="ss-detail-content">
                <label className="ss-field">节奏执行<textarea aria-label={`${unit.id} 节奏执行`} className="textarea" rows={3} value={unit.paceExecution ?? ''}
                  placeholder={paceExecution(unit)} disabled={busy} onChange={event => onUnitChange(unit.id, { paceExecution: event.target.value })} /></label>
                <label className="ss-field">慢镜头功能与白名单理由<textarea aria-label={`${unit.id} 慢镜头功能`} className="textarea" rows={2} value={unit.slowMotionPurpose ?? ''}
                  disabled={busy} onChange={event => onUnitChange(unit.id, { slowMotionPurpose: event.target.value })} /></label>
                <p className="ss-muted">档位理由：{unit.paceReason || '待补充'}；建议 {unit.suggestedShotCount} 镜。</p>
              </div>
            </details>
            <div className="ss-shot-tabs" role="group" aria-label="当前单元镜头">
              {unit.shots.map((item, index) => <button key={index} type="button" className={`ss-shot-tab ${shotIndex === index ? 'ss-shot-tab-active' : ''}`}
                aria-pressed={shotIndex === index} onClick={() => { setSelectedShot(index); setFocusTarget(null) }}>镜头 {index + 1}{item.functionLabel ? ` · ${item.functionLabel}` : ''}</button>)}
            </div>
            {shot ? <div className="ss-shot-editor" aria-label={`第 ${unit.index} 段镜头 ${shotIndex + 1}`}>
              <div className="ss-shot-grid">
                {fields.map(field => {
                  const invalid = !(shot[field] ?? '').trim()
                  return <label key={field} className={`ss-shot-field ${field === 'subjectActionExpression' || field === 'dialogueAndTone' ? 'ss-shot-field-wide' : ''}`}>
                    <span>{labels[field]}{invalid ? <em>待填写</em> : null}</span>
                    <textarea id={`ss-shot-${unit.id}-${shotIndex}-${field}`} aria-label={`${unit.id} 镜头 ${shotIndex + 1} ${labels[field]}`}
                      aria-invalid={invalid} className="textarea" rows={field === 'dialogueAndTone' ? 4 : 3} value={shot[field] ?? ''} disabled={busy}
                      onChange={event => onFieldChange(unit.id, shotIndex, field, event.target.value)} />
                  </label>
                })}
              </div>
            </div> : <p className="ss-inline-warning">当前单元没有镜头，请重新生成。</p>}
            <div className="ss-editor-pagination">
              <button type="button" className="btn btn-ghost btn-sm" disabled={units.indexOf(unit) === 0} onClick={() => chooseUnit(units[units.indexOf(unit) - 1].id)}>上一单元</button>
              <span>{unit.index} / {units.length}</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={units.indexOf(unit) === units.length - 1} onClick={() => chooseUnit(units[units.indexOf(unit) + 1].id)}>下一单元</button>
            </div>
          </section>

          <aside className="ss-inspector" aria-label="质量与衔接">
            <section className="ss-card">
              <div className="ss-panel-heading"><h3>质量检查</h3><span className={hardIssues.length ? 'ss-inline-warning' : 'ss-save-state'}>{hardIssues.length} 项阻断</span></div>
              {!issues.length ? <p className="ss-muted">结构检查通过；保存时复核完整台词与原稿的一致性。</p> : (
                <ul className="ss-issues ss-locatable-issues">{issues.map((issue, index) => <li key={index}>
                  <button type="button" className={`ss-issue-target ss-issue-${issue.severity}`} onClick={() => locate(issue)}>
                    <strong>{issue.severity === 'error' ? '阻断' : '提醒'}{issue.unitId ? ` · ${issue.unitId}` : ''}</strong><span>{issue.message}</span>
                    <small>定位到单元{issue.field ? ` · ${labels[issue.field as ShotField] ?? issue.field}` : ''}</small>
                  </button>
                </li>)}</ul>
              )}
            </section>
            <section className="ss-card">
              <h3>画面与衔接</h3>
              <dl className="ss-continuity">
                <dt>首帧</dt><dd>{unit.firstFrame || '待补充'}</dd>
                <dt>末帧</dt><dd>{unit.lastFrame || '待补充'}</dd>
                <dt>人物位置</dt><dd>{unit.characterPositions || '待补充'}</dd>
                <dt>连续性</dt><dd>{unit.continuity || '待补充'}</dd>
                <dt>相邻段边界</dt><dd>{unit.boundaryPlan || unit.continuity || '待确认'}</dd>
                <dt>情绪</dt><dd>{unit.emotion || '待补充'}</dd>
              </dl>
              <details className="ss-details"><summary>增强建议与生成依据</summary><div className="ss-detail-content">
                <p>{unit.enhancementAdvice?.join('；') || '暂无增强建议，当前按文字描述生成。'}</p>
                <p>资产引用：{unit.assetRefs.join('、') || '无参考素材。'}</p>
                {project?.storyboard ? <p>正式稿 v{project.storyboard.basedOn.versionNumber} · 分镜指纹 <code>{project.storyboard.storyboardFingerprint.slice(0, 8)}</code></p> : null}
                {stale ? <p className="ss-inline-warning">已保存分镜基于旧版本；新生成的草稿确认后可保存。</p> : null}
              </div></details>
            </section>
          </aside>
        </div>
      )}
    </div>
  )
}
