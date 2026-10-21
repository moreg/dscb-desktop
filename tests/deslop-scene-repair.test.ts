import { describe, expect, it, vi } from 'vitest'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import type { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { GenerateOptions, LlmService } from '../src/main/data/llm-service'
import type { DeslopResult } from '../src/shared/types'

const original=[
  '林远缓缓推开院门，把账册放在门边，守门人从抽屉取出旧账核对，两个红印对得上。',
  '守门人递给他一把钥匙，让他自己开东屋的门，林远轻轻收好钥匙，绕过院中的柴堆。',
  '旧账只能证明此前有人领取，不能据此认定次数和日期，两人仍要另查渡船登记。',
  '林远走到东屋门前，先听屋里的动静，没有推门，也没有把这条路当成失踪者的去向。'
].join('\n')
const anchor=original.split('\n')[2]
const first=original.replace('缓缓推开','推开')
const second=first.replace('绕过院中','走过院中')
const drift=second.replace('一把钥匙','两把钥匙')
const final=second.replace('轻轻收好','收好')
const plan=JSON.stringify({facts:[{quote:anchor,keep:'只能证明此前有人领取，不能推出次数日期，仍查渡船'}],scenePlan:'边界在读账处讲清一次，不反复总结'})
const payload=(text:string)=>JSON.stringify({text,coverage:[{id:1,quote:anchor}]})
const patch=(before:string,after:string)=>JSON.stringify({patches:[{before,after}],coverage:[{id:1,quote:anchor}]})
const result=(text:string,passed:boolean,issues:string[]=[]):DeslopResult=>({rewritten:text,
  beforeWords:150,afterWords:150,deleteRatio:0,processedGates:[],remainingFindings:[],changeSummary:[],
  dialogueQuality:{passed,beforeRatio:0,afterRatio:0,attempts:0,issues,...(!passed?{pendingDraft:text}:{})}})

function setup(input:{drafts?:string[];plan?:string;allFactsFail?:boolean;changeAfterCheck?:boolean;formatCandidate?:(text:string)=>string;initialDialogueDraft?:string;unconfirmedFacts?:boolean;unconfirmedScene?:boolean;initialIssues?:string[]}={}){
  const requests:{prompt:string;feature:unknown}[]=[]
  let rewrites=0,checks=0
  const llm={generateStream:vi.fn(async(prompt:string,opts:GenerateOptions)=>{
    const feature=opts.meta?.feature;requests.push({prompt,feature})
    if(feature==='deslop:repair-plan')return input.plan??plan
    if(feature==='deslop:scene-repair')return input.drafts?.[rewrites++]??payload(final)
    if(feature==='deslop:verify')return input.unconfirmedFacts?'not JSON':JSON.stringify(prompt.split('【润色稿】').at(-1)!.includes('两把钥匙')||input.allFactsFail
      ? {unchanged:false,issues:['钥匙数量改变，须恢复一把']} : {unchanged:true,issues:[]})
    throw Error('意外调用')
  })} as unknown as LlmService
  const deslop=vi.fn(async(text:string)=>{
    checks++
    if(checks===1)return result(first,false,input.initialIssues??['对话和旁白重复解释证据边界'])
    if(input.unconfirmedScene)return result(text,false,['整场对白复核缺少有效的连续回合证据或结论，保留待复核。'])
    if(text===second)return result(text,false,['结尾仍反复总结同一证据'])
    return result(input.changeAfterCheck?drift:text,true)
  })
  const run=(signal?:AbortSignal,onProgress?:(s:string)=>void,existingText?:string)=>autoDeslopProse(original,{
    llm,service:{deslop} as unknown as DeslopService,validateCandidate:async()=>{},
    formatCandidate:input.formatCandidate,
    initialDialogueDraft:input.initialDialogueDraft,
    dialogueComposition:{mode:'write',existingText},signal,onProgress
  })
  return {run,llm,requests,deslop}
}

describe('自动去 AI 味协同整场修订',()=>{
  it('事实丢失与重复讲解均须修复，历轮约束累积且最终再验收',async()=>{
    const x=setup({drafts:[payload(drift),patch('两把钥匙','一把钥匙'),patch('轻轻收好','收好')]})
    const output=await x.run()
    expect(output.content).toBe(final)
    expect(output.report).toMatchObject({status:'applied',repairAttempts:3,verificationAttempts:3})
    const revisions=x.requests.filter(x=>x.feature==='deslop:scene-repair')
    expect(revisions).toHaveLength(3)
    expect(revisions[2].prompt).toContain('钥匙数量改变，须恢复一把')
    expect(revisions[2].prompt).toContain('结尾仍反复总结同一证据')
    expect(revisions[1].prompt).toContain('唯一匹配的局部替换')
    for(const p of revisions)expect(p.prompt).toContain(`【原稿】\n\n${original}`)
    // 有事实变化的第一份不得进入表达复核；同字节的最终独立事实结论无需重复请求。
    expect(x.deslop.mock.calls.map(([text])=>text)).toEqual([original,second,final])
    expect(output.report.dialogueQuality?.passed).toBe(true)
    expect(output.report.dialogueQuality?.attempts).toBe(3)
    expect(output.report.dialogueQuality?.afterRatio).toBe(0)
  })
  it('有界修订仍未保持事实则保留原稿，不能用清单自报覆盖代替事实审核',async()=>{
    const x=setup({drafts:[payload(drift),patch('走过院中','绕过院中'),patch('绕过院中','走到院中'),patch('走到院中','绕到院中')],allFactsFail:true})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(output.report.repairAttempts).toBe(4)
    expect(x.deslop).toHaveBeenCalledOnce()
    expect(output.report.issues).toContain('钥匙数量改变，须恢复一把')
    expect(output.report.dialogueQuality?.pendingDraft).toBe(drift.replace('走过院中','绕到院中'))
  })
  it('清单引用不在原稿中时不盲目重写',async()=>{
    const x=setup({plan:JSON.stringify({facts:[{quote:'原文没有这句话',keep:'凭空新增'}],scenePlan:'重写'})})
    const output=await x.run()
    expect(output.report.status).toBe('review_required')
    expect(x.requests.map(x=>x.feature)).toEqual(['deslop:repair-plan'])
  })
  it('覆盖表重复id时保留整场草稿，修正表格后仍须独立事实和表达验收',async()=>{
    const x=setup({drafts:[JSON.stringify({text:final,coverage:[{id:1,quote:anchor},{id:1,quote:anchor}]}),
      JSON.stringify({patches:[],coverage:[{id:1,quote:anchor}]})]})
    const output=await x.run()
    expect(output.report.status).toBe('applied')
    expect(output.content).toBe(final)
    expect(output.report.repairAttempts).toBe(2)
    expect(x.requests.filter(x=>x.feature==='deslop:verify')).toHaveLength(1)
    expect(x.requests.filter(x=>x.feature==='deslop:scene-repair')[1].prompt).toContain(final)
    expect(x.deslop.mock.calls.map(([text])=>text)).toEqual([original,final])
  })
  it('同一问题下原样返回候选不能靠反复审核碰运气通过',async()=>{
    const x=setup({drafts:[payload(first),payload(first),payload(first)]})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(x.deslop).toHaveBeenCalledOnce()
    expect(x.requests.filter(x=>x.feature==='deslop:verify')).toHaveLength(0)
  })
  it('仅增加被排版去掉的空白不能重新审核已拒绝稿',async()=>{
    const x=setup({drafts:[payload(first+'\n  ')],formatCandidate:text=>text.trim()})
    const output=await x.run()
    expect(output.report.status).toBe('review_required')
    expect(output.content).toBe(original)
    expect(x.deslop).toHaveBeenCalledOnce()
    expect(x.requests.filter(x=>x.feature==='deslop:verify')).toHaveLength(0)
    expect(x.requests.filter(x=>x.feature==='deslop:scene-repair')[1].prompt)
      .toContain('当前稿排版后与此前未通过的稿件逐字相同，不能重新审核碰运气。')
  })
  it('恢复已有试稿时从局部修订继续，仍以原稿独立核对事实',async()=>{
    const x=setup({initialDialogueDraft:first,drafts:[patch('轻轻收好','收好')]})
    const output=await x.run()
    expect(output.content).toBe(first.replace('轻轻收好','收好'))
    expect(output.report).toMatchObject({status:'applied',repairAttempts:1,verificationAttempts:1})
    const revision=x.requests.find(x=>x.feature==='deslop:scene-repair')!
    expect(revision.prompt).toContain('唯一匹配的局部替换')
    const facts=x.requests.find(x=>x.feature==='deslop:verify')!
    expect(facts.prompt).toContain(`【原稿】\n\n${original}`)
  })
  it.each([{unconfirmedFacts:true},{unconfirmedScene:true}])('审核未确认不能当成正文事实差异继续盲改：%j',async input=>{
    const x=setup(input)
    const output=await x.run()
    expect(output.report.status).toBe('review_required')
    expect(output.content).toBe(original)
    expect(output.report.repairAttempts).toBe(1)
    expect(output.report.dialogueQuality?.pendingDraft).toBe(final)
    expect(x.requests.filter(x=>x.feature==='deslop:scene-repair')).toHaveLength(1)
  })
  it('有依据的事实差异包含“尚未完成”时仍继续修复，不误当审核格式错误',async()=>{
    const x=setup({initialIssues:['原稿尚未完成核查，润色稿却提前认定了物品归属。']})
    const output=await x.run()
    expect(output.report.status).toBe('applied')
    expect(x.requests.filter(x=>x.feature==='deslop:scene-repair')).toHaveLength(1)
  })
  it('最终只报告当前未通过的问题，不把已修好的历史事实差异说成仍然存在',async()=>{
    const x=setup({drafts:[payload(drift),patch('两把钥匙','一把钥匙'),patch('轻轻收好','轻轻收好'),patch('轻轻收好','轻轻收好')]})
    const output=await x.run()
    expect(output.report.status).toBe('review_required')
    expect(output.report.issues).not.toContain('钥匙数量改变，须恢复一把')
    expect(output.report.issues).toContain('结尾仍反复总结同一证据')
  })
  it('续写的只读前部供清单和重写理解，但不混入返回正文或事实基线',async()=>{
    const prefix='“我先在门口等你。”\n林远让同伴留在院外。'
    const x=setup()
    const output=await x.run(undefined,undefined,prefix)
    expect(output.content).toBe(final)
    for(const request of x.requests.filter(x=>['deslop:repair-plan','deslop:scene-repair'].includes(String(x.feature)))){
      expect(request.prompt).toContain(`【只读前部：只供理解，不得改写或输出】\n${prefix}`)
      expect(request.prompt).toContain(`【原稿】\n\n${original}`)
    }
  })
  it.each([
    JSON.stringify({text:final,coverage:[]}),
    JSON.stringify({text:final,coverage:[{id:1,quote:'稿中没有这句话'}]}),
    JSON.stringify({text:final,coverage:[{id:2,quote:anchor}]})
  ])('修订清单落点无效不能进入采用检查：%s',async invalid=>{
    const x=setup({drafts:[invalid,invalid,invalid]})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(x.requests.filter(x=>x.feature==='deslop:verify')).toHaveLength(0)
  })
  it('表达检查改变了候选时重新独立验事实，不能复用检查前字节的结论',async()=>{
    const x=setup({changeAfterCheck:true})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(x.requests.filter(x=>x.feature==='deslop:verify')).toHaveLength(2)
  })
  it('协同修订进度触发停止后不再调用模型或采用候选',async()=>{
    const x=setup(),controller=new AbortController()
    await expect(x.run(controller.signal,s=>{if(s.includes('整场保真修订'))controller.abort()})).rejects.toThrow('LLM_ABORTED')
    expect(x.requests.map(x=>x.feature)).toEqual(['deslop:repair-plan'])
  })
})
