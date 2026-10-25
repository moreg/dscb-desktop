import { describe, expect, it, vi } from 'vitest'
import { LongformGuard, parseLongformGuard, type LongformGuardInput } from '../src/main/data/longform-guard'
import type { LlmService } from '../src/main/data/llm-service'

const cleared = { completed: true, checked: ['mainline', 'knowledge', 'thread', 'item'], findings: [] }
const input: LongformGuardInput = {
  chapterNumber: 800,
  content: '陆宁直接揭穿赵伯就是内应，并宣布永远放弃寻找母亲。',
  plan: '全书主线是寻找失踪的母亲；本卷先寻找密信，第850章才能查明内应身份。',
  history: '[人物认知 · 最近可核实记录] 陆宁 → 内应身份：不知赵伯是内应，未看过密信。（第3章）'
}
const finding = { kind: 'knowledge', message: '陆宁无新信息来源却直接知道内应身份。',
  snippet: '陆宁直接揭穿赵伯就是内应', reference: '不知赵伯是内应，未看过密信。' }
const mock = (response = JSON.stringify(cleared)) => ({ generateStream: vi.fn().mockResolvedValue(response),
  getCacheIdentity: vi.fn().mockResolvedValue('model-v1') })

describe('长篇写作交稿闸门', () => {
  it('逐项核对主线/人物知情/承诺，与可选深审开关无关', async () => {
    const llm = mock()
    await new LongformGuard(llm as unknown as LlmService).check(input)
    expect(llm.generateStream.mock.calls[0][0]).toContain('不能把提及、猜测、谎言、部分进展当作已完成')
    expect(llm.generateStream.mock.calls[0][0]).toContain(input.plan)
    expect(llm.generateStream.mock.calls[0][0]).toContain(input.history)
  })

  it.each(['knowledge', 'thread', 'mainline'] as const)('有双重证据的 %s 冲突会暂停，错误保留原句和依据', async kind => {
    const f = { ...finding, kind, ...(kind === 'mainline' ? { reference: '第850章才能查明内应身份。' } : {}) }
    const llm = mock(JSON.stringify({ ...cleared, findings: [f] }))
    await expect(new LongformGuard(llm as unknown as LlmService).check(input)).rejects.toThrow('LONGFORM_CONFLICT')
    expect(llm.generateStream).toHaveBeenCalledTimes(1)
  })

  it.each(['{}', '{"findings":[]}', '{"completed":false,"checked":["mainline","knowledge","thread"],"findings":[]}'])('无效或未完成结果不能冒充通过', async reply => {
    const llm = mock(reply)
    await expect(new LongformGuard(llm as unknown as LlmService).check(input)).rejects.toThrow('LONGFORM_REVIEW_INCOMPLETE')
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
  })

  it('错误引文、缺失对照依据和只属于旧稿的问题均不接受', () => {
    const parse = (f: object, source = input) => parseLongformGuard(JSON.stringify({ ...cleared, findings: [f] }), source)
    expect(() => parse({ ...finding, snippet: '陆宁通过密信确认了内应。' })).toThrow('依据')
    expect(() => parse({ ...finding, reference: '陆宁已经亲眼看清全部事实。' })).toThrow('依据')
    expect(() => parse(finding, { ...input, continuationStart: input.content.length })).toThrow('依据')
    expect(() => parse(finding, { ...input, continuationStart: 0 })).not.toThrow()
  })

  it('缓存仅复用相同全文、主线、历史和模型的成功结果', async () => {
    const llm = mock()
    const guard = new LongformGuard(llm as unknown as LlmService)
    await guard.check(input)
    await guard.check(input)
    expect(llm.generateStream).toHaveBeenCalledTimes(1)
    await guard.check({ ...input, history: input.history + '\n陆宁后来通过密信知道真相。' })
    await guard.check({ ...input, plan: input.plan + '\n作者调整卷末计划。' })
    llm.getCacheIdentity.mockResolvedValue('model-v2')
    await guard.check(input)
    expect(llm.generateStream).toHaveBeenCalledTimes(4)
  })

  it('不缓存失败或取消；重试可重新检查同稿', async () => {
    const llm = mock('{}')
    const guard = new LongformGuard(llm as unknown as LlmService)
    await expect(guard.check(input)).rejects.toThrow('未完成')
    llm.generateStream.mockResolvedValue(JSON.stringify(cleared))
    await guard.check(input)
    const controller = new AbortController()
    controller.abort()
    await expect(guard.check(input, { signal: controller.signal })).rejects.toThrow('LLM_ABORTED')
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
  })

  it('历史来源指纹或项目改变，即使展示片段相同也重新审核',async()=>{
    const llm=mock()
    const guard=new LongformGuard(llm as unknown as LlmService)
    await guard.check({...input,sources:'history-a'},{meta:{feature:'longformGuard',projectId:'a'}})
    await guard.check({...input,sources:'history-b'},{meta:{feature:'longformGuard',projectId:'a'}})
    await guard.check({...input,sources:'history-b'},{meta:{feature:'longformGuard',projectId:'b'}})
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
  })

  it('缓存身份读取失败仍实际核对，模型取消立即退出且不重试', async () => {
    const llm = mock()
    llm.getCacheIdentity.mockRejectedValue(new Error('无法读取身份'))
    const guard = new LongformGuard(llm as unknown as LlmService)
    await guard.check(input)
    await guard.check(input)
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
    llm.generateStream.mockRejectedValue(new Error('LLM_ABORTED'))
    await expect(guard.check(input)).rejects.toThrow('LLM_ABORTED')
    expect(llm.generateStream).toHaveBeenCalledTimes(3)
  })

  it('没有实际计划和结构化历史时不凭空审查，超长全章不能静默截断', async () => {
    const llm = mock()
    const guard = new LongformGuard(llm as unknown as LlmService)
    await guard.check({ ...input, plan: '', history: '缺少旧章记录，无法判定知情范围。' })
    expect(llm.generateStream).not.toHaveBeenCalled()
    await expect(guard.check({ ...input, content: '甲'.repeat(40001) })).rejects.toThrow('40000')
  })

  it('程序比对提示只进入核对方向说明，改变提示即不命中缓存且不影响通过', async () => {
    const llm = mock()
    const guard = new LongformGuard(llm as unknown as LlmService)
    await guard.check(input)
    await guard.check({ ...input, hints: ['本章出现「木牌」，而已知道具「铜牌」未在本章出现。'] })
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
    expect(llm.generateStream.mock.calls[1][0]).toContain('程序比对可疑点')
    expect(llm.generateStream.mock.calls[1][0]).toContain('木牌')
  })

  it('只有道具历史也必须检查，旧三项检查结果不能绕过新增道具核对', async () => {
    const llm = mock(JSON.stringify({completed:true,checked:['mainline','knowledge','thread'],findings:[]}))
    const source = {...input,plan:'',history:'[道具 · 最近可核实记录] 原信装入绸布封套后由陆安随身保管。'}
    await expect(new LongformGuard(llm as unknown as LlmService).check(source)).rejects.toThrow('LONGFORM_REVIEW_INCOMPLETE')
    expect(llm.generateStream).toHaveBeenCalledTimes(2)
  })

  it('作者修订后的封套不能因旧细纲或历史卡而换回旧名称，道具冲突必须有双重证据', async () => {
    const source = {...input,plan:'',content:'陆安从衣内取出青布封套，将里面的原信递给弟弟。',
      history:'[道具 · 最近可核实记录] 原信连同信封装入绸布封套后随身携带。'}
    const f = {kind:'item',message:'没有更换过程，却将绸布封套写回青布封套。',
      snippet:'陆安从衣内取出青布封套',reference:'原信连同信封装入绸布封套后随身携带。'}
    const llm = mock(JSON.stringify({...cleared,findings:[f]}))
    await expect(new LongformGuard(llm as unknown as LlmService).check(source)).rejects.toThrow('跨章道具')
    expect(llm.generateStream.mock.calls[0][0]).toContain('未来细纲仍写旧名')
    expect(()=>parseLongformGuard(JSON.stringify({...cleared,findings:[{...f,reference:'原信早已装在青布封套内。'}]}),source)).toThrow('依据')
  })
})
