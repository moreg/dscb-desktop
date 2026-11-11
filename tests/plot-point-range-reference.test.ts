import { describe, it, expect } from 'vitest'
import { buildPlotPointReferences } from '../src/main/data/skill-format/plot-point-references'
describe('多节点引用不丢摘要事实',()=>{
 const refs=()=>buildPlotPointReferences([{title:'情节点序列',text:'1. 药车退到高地。\n2. 工兵清沟。\n3. 水流改道。'}])
 it('只转换完整存在的纯引用',()=>{expect(refs().renderSummary('见情节点1—3')).toBe('参见下方情节点 1—3。')})
 it('带事实的摘要原样保留',()=>{const s='旧图对上地势，工兵选真实废石（3—5）。';expect(refs().renderSummary(s)).toBe(s)})
 it('缺失编号保留引用并提示',()=>{const r=refs();expect(r.renderSummary('见情节点2—4')).toBe('见情节点2—4');expect(r.unresolved.has(4)).toBe(true)})
 it('反向与异常范围保持原样',()=>{expect(refs().renderSummary('见情节点3—1')).toBe('见情节点3—1')})
})
