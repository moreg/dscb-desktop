import type { StyleAnalysisResult, StyleProfile } from '../../../../shared/types'
import StyleSection from './StyleSection'
import StyleProfileConstraintsBlock from './StyleProfileConstraintsBlock'

interface Props {
  preview: StyleAnalysisResult
  selected: StyleProfile | null
  hasAnalysis: boolean
}

export default function StyleProfilePreview({ preview, selected, hasAnalysis }: Props) {
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h3 className="sub" style={{ margin: 0 }}>
          {hasAnalysis ? '提取结果预览' : selected ? '文风卡详情' : '提取结果预览'}
        </h3>
        {selected && !hasAnalysis ? (
          <span className="meta" style={{ marginLeft: 'auto' }}>
            创建于 {selected.createdAt.slice(0, 10)}
          </span>
        ) : null}
      </div>
      <StyleSection title="是什么文风" items={[preview.identifiedStyle].filter(Boolean)} />
      <StyleSection title="句式特征" items={preview.sentencePatterns} />
      <StyleSection title="词汇偏好" items={preview.vocabularyPreferences} />
      <StyleSection title="标点与节奏" items={preview.punctuationAndRhythm} />
      <StyleSection
        title="叙事视角与语气"
        items={[...preview.narrativePerspective, ...preview.tone]}
      />
      <StyleSection title="基础叙事模板" items={preview.narrativeTemplates} />
      {hasAnalysis ? (
        <StyleSection title="文风约束" items={preview.styleConstraints} />
      ) : (
        <StyleProfileConstraintsBlock
          styleItems={preview.styleConstraints}
          characterItems={preview.characterConstraints}
          plotItems={preview.plotConstraints}
        />
      )}
      <section style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>写作提示词摘要</strong>
        <pre
          className="body"
          style={{
            whiteSpace: 'pre-wrap',
            marginTop: 8,
            maxHeight: 260,
            overflow: 'auto'
          }}
        >
          {preview.stylePrompt || '暂无'}
        </pre>
      </section>
    </div>
  )
}
