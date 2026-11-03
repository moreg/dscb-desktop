import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(process.argv[2])
const raw = JSON.parse(await readFile(join(root, 'raw-candidates.json'), 'utf8'))
const meta = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8'))
const labels = {
  title: '书名', titleCandidates: '候选书名', strategy: '策略', genre: '题材', hookLine: '一句话梗', goldenFinger: '金手指',
  fusion: '融梗因果与删除检验', coreConcept: '核心构思', sellingPoint: '卖点', protagonist: '主角', openingHook: '开场',
  marketReasoning: '样本依据与改造', readerFit: '读者偏好', riskNotes: '风险', worldSetting: '世界设定', powerSystem: '能力规则',
  supportingCharacters: '配角与关系', coreConflict: '阶段目标与核心冲突', targetAudience: '回报与读者期待', pacingPlan: '长篇阶段推进',
  openingChapters: '前三章方向', trendBasis: '具体来源梗', bookId: '来源书籍 ID', field: '引用字段', quote: '来源原文', mechanism: '来源机制与本案作用',
  chapter: '章号', openingEvent: '开场事件', protagonistAction: '主角行动', conflict: '冲突阻力', payoff: '当章回报', endHook: '章末钩子', summaryApplication: '汇总机制应用'
}
function render(value, depth = 3) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return String(value)
  if (Array.isArray(value)) {
    if (value.every(item => typeof item === 'string')) return value.join('；')
    return value.map((item, index) => `${'#'.repeat(Math.min(depth, 6))} ${item.chapter ? `第 ${item.chapter} 章` : `第 ${index + 1} 项`}\n\n${render(item, depth + 1)}`).join('\n\n')
  }
  return Object.entries(value).map(([key, item]) => `**${labels[key] || key}：**\n\n${render(item, depth + 1)}`).join('\n\n')
}
let text = `# 桌面版 ${meta.promptVersion} 实测：三条模型原稿全文\n\n模型：${meta.model}；通道：${meta.protocol}；榜单：${meta.chartType}，${meta.chartDate}，${meta.sampleCount} 本。\n\n以下逐项保留模型原始内容，不代表通过验收；数组和对象仅调整展示格式，没有补写情节。\n\n`
raw.ideas.forEach((idea, index) => {
  text += `## ${index + 1}．${idea.title || idea.titleCandidates?.[0] || '未命名'}\n\n${render(idea)}\n\n`
})
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
const missing = strings(raw).filter(value => !text.includes(value))
if (missing.length) throw new Error(`完整性检查失败：${missing.length} 个原始字符串未覆盖。`)
await writeFile(join(root, '三条模型原稿全文.md'), text)
await writeFile(join(root, 'display-completeness.json'), JSON.stringify({ ideas: raw.ideas.length, stringFields: strings(raw).length, missing: 0, characters: text.length }, null, 2))
console.log(JSON.stringify({ ideas: raw.ideas.length, characters: text.length, complete: true }))
