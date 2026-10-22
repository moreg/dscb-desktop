import { describe, expect, it, vi } from 'vitest'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { repairDeslopScene } from '../src/main/data/deslop/scene-repair'
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

function setup(input:{drafts?:string[];plan?:string;allFactsFail?:boolean;changeAfterCheck?:boolean;formatCandidate?:(text:string)=>string;initialDialogueDraft?:string;unconfirmedFacts?:boolean;unconfirmedScene?:boolean;initialIssues?:string[];factWait?:Promise<void>;expressionWait?:Promise<void>;expressionIssue?:string}={}){
  const requests:{prompt:string;feature:unknown}[]=[]
  let rewrites=0,checks=0
  const llm={generateStream:vi.fn(async(prompt:string,opts:GenerateOptions)=>{
    const feature=opts.meta?.feature;requests.push({prompt,feature})
    if(feature==='deslop:repair-plan')return input.plan??plan
    if(feature==='deslop:scene-repair')return input.drafts?.[rewrites++]??payload(final)
    if(feature==='deslop:verify')await input.factWait
    if(feature==='deslop:verify')return input.unconfirmedFacts?'not JSON':JSON.stringify(prompt.split('【润色稿】').at(-1)!.includes('两把钥匙')||input.allFactsFail
      ? {unchanged:false,issues:['钥匙数量改变，须恢复一把']} : {unchanged:true,issues:[]})
    throw Error('意外调用')
  })} as unknown as LlmService
  const deslop=vi.fn(async(text:string)=>{
    checks++
    if(checks===1)return result(first,false,input.initialIssues??['对话和旁白重复解释证据边界'])
    await input.expressionWait
    if(input.expressionIssue)return result(text,false,[input.expressionIssue])
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
  it('清单漏掉中间原句时补回引文，仍完整独立验收修订稿',async()=>{
    const lines=original.split('\n')
    const x=setup({plan:JSON.stringify({facts:[{quote:[lines[0],lines[2]].join('\n'),keep:'读账的证据限制与并行调查均保留'}],scenePlan:'准确表达边界'})})
    const output=await x.run()
    expect(output.report.status).toBe('applied')
    expect(x.requests.filter(r=>r.feature==='deslop:verify')).toHaveLength(1)
    expect(x.deslop).toHaveBeenCalledTimes(2)
    expect(x.requests.find(r=>r.feature==='deslop:scene-repair')!.prompt).toContain(JSON.stringify(lines.slice(0,3).join('\n')))
    expect(x.requests.some(r=>r.feature==='deslop:repair-plan-quotes')).toBe(false)
  })
  it('大幅超预算的后续轮直接输出完整正文，程序仍逐稿验收',async()=>{
    const long=first.repeat(3),prompts:string[]=[]
    let calls=0
    const llm={generateStream:vi.fn(async(prompt:string,opts:GenerateOptions)=>{
      if(opts.meta?.feature==='deslop:repair-plan')return plan
      prompts.push(prompt);return payload(calls++===0?long:final)
    })} as unknown as LlmService
    const check=vi.fn(async(text:string)=>text===final?{accepted:text,issues:[]}:{issues:['篇幅超限']})
    const out=await repairDeslopScene(original,first,{llm,issues:['接话不自然'],minWords:100,maxWords:200,onAttempt:()=>{},check})
    expect(out.accepted).toBe(final)
    expect(prompts[1]).toContain('禁止输出before/after补丁')
    expect(prompts[1]).toContain('不需要逐字计数')
    expect(check.mock.calls.map(([text])=>text)).toEqual([long,final])
  })
  it('首轮精确补丁只输出改动，完整候选仍经过事实与表达验收',async()=>{
    const response=JSON.stringify({patches:[{before:'绕过院中',after:'走过院中'},{before:'轻轻收好',after:'收好'}],
      coverage:[{id:1,quote:anchor}]})
    const x=setup({drafts:[response]})
    const output=await x.run()
    expect(output.content).toBe(final)
    expect(output.report.status).toBe('applied')
    expect(output.report.repairAttempts).toBe(1)
    expect(x.deslop.mock.calls.map(([text])=>text)).toEqual([original,final])
    expect(x.requests.find(r=>r.feature==='deslop:verify')?.prompt).toContain(`【润色稿】\n\n${final}`)
    expect(response.length).toBeLessThan(payload(final).length)
  })
  it('首轮补丁改坏事实仍保留原稿，不能用输出更短绕过全章核验',async()=>{
    const x=setup({drafts:[patch('一把钥匙','两把钥匙'),patch('绕过院中','走过院中'),
      patch('轻轻收好','慢慢收好'),patch('慢慢收好','认真收好')],allFactsFail:true})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(output.report.issues).toContain('钥匙数量改变，须恢复一把')
  })
  it.each([
    {patches:[{before:'原文没有这段',after:'新增事实'}]},
    {patches:[{before:'林远',after:'另一个人'}]},
    {patches:[{before:'轻轻收好钥匙',after:'收好钥匙'},{before:'收好钥匙',after:'交出钥匙'}]},
    {text:final,patches:[{before:'轻轻收好',after:'收好'}]}
  ])('无效、歧义或重叠的首轮补丁不能送入验收：%j',async body=>{
    const response=JSON.stringify({...body,coverage:[{id:1,quote:anchor}]})
    const x=setup({drafts:Array(4).fill(response)})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(x.requests.filter(r=>r.feature==='deslop:verify')).toHaveLength(0)
    expect(x.deslop).toHaveBeenCalledOnce()
  })
  it('待修订稿与原稿完全相同时只发送一份全文，补丁仍匹配完整原稿',async()=>{
    const prompts:string[]=[]
    const draft=original.replace('缓缓推开','推开')
    const llm={generateStream:vi.fn(async(prompt:string,opts:GenerateOptions)=>{
      prompts.push(prompt)
      return opts.meta?.feature==='deslop:repair-plan'?plan:patch('缓缓推开','推开')
    })} as unknown as LlmService
    const check=vi.fn(async(text:string)=>({accepted:text,issues:[]}))
    const output=await repairDeslopScene(original,original,{llm,issues:['冗词'],minWords:1,maxWords:1000,onAttempt:()=>{},check})
    expect(output.accepted).toBe(draft)
    expect(prompts[1].split(original)).toHaveLength(2)
    expect(check).toHaveBeenCalledWith(draft,expect.stringContaining(anchor))
  })
  it.each(['facts','expression'] as const)('事实与表达同时开始，%s 先完成也不能提前采用',async firstFinished=>{
    let releaseFacts!:()=>void,releaseExpression!:()=>void
    const x=setup({factWait:new Promise<void>(resolve=>{releaseFacts=resolve}),
      expressionWait:new Promise<void>(resolve=>{releaseExpression=resolve})})
    let finished=false
    const running=x.run().then(value=>{finished=true;return value})
    try {
      await vi.waitFor(()=>{
        expect(x.requests.some(r=>r.feature==='deslop:verify')).toBe(true)
        expect(x.deslop).toHaveBeenCalledTimes(2)
      })
      if(firstFinished==='facts')releaseFacts();else releaseExpression()
      await new Promise(resolve=>setTimeout(resolve,0))
      expect(finished).toBe(false)
    } finally {releaseFacts();releaseExpression()}
    expect((await running).content).toBe(final)
    expect(x.requests.filter(r=>r.feature==='deslop:verify')).toHaveLength(1)
  })
  it('同轮汇总事实与表达问题，供下一轮一起修复',async()=>{
    const x=setup({allFactsFail:true,expressionIssue:'重复解释证据边界',drafts:[payload(drift),patch('走过院中','绕过院中')]})
    const output=await x.run()
    const next=x.requests.filter(r=>r.feature==='deslop:scene-repair')[1].prompt
    expect(next).toContain('钥匙数量改变，须恢复一把')
    expect(next).toContain('重复解释证据边界')
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
  })
  it('并行审核中取消，等待收束后不采用候选或继续修订',async()=>{
    let release!:()=>void
    const controller=new AbortController()
    const x=setup({expressionWait:new Promise<void>(resolve=>{release=resolve})})
    const running=x.run(controller.signal)
    const rejected=expect(running).rejects.toThrow('LLM_ABORTED')
    try {await vi.waitFor(()=>expect(x.deslop).toHaveBeenCalledTimes(2));controller.abort()}
    finally {release()}
    await rejected
    expect(x.requests.filter(r=>r.feature==='deslop:scene-repair')).toHaveLength(1)
  })
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
    // 两种审核并行，但事实有变化的稿件仍不能采用；最终同稿事实结论不重复请求。
    expect(x.deslop.mock.calls.map(([text])=>text)).toEqual([original,drift,second,final])
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
    expect(x.deslop).toHaveBeenCalledTimes(5)
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
    const x=setup({drafts:Array(4).fill(payload(first))})
    const output=await x.run()
    expect(output.content).toBe(original)
    expect(output.report.status).toBe('review_required')
    expect(x.deslop).toHaveBeenCalledOnce()
    expect(x.requests.filter(x=>x.feature==='deslop:verify')).toHaveLength(0)
  })
  it('仅增加被排版去掉的空白不能重新审核已拒绝稿',async()=>{
    const x=setup({drafts:Array(4).fill(payload(first+'\n  ')),formatCandidate:text=>text.trim()})
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
    const x=setup({drafts:[invalid,invalid,invalid,invalid]})
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
