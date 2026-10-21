import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { LlmService } from '../src/main/data/llm-service'
import { SecretStore } from '../src/main/data/secret-store'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { DetailedOutlineMdRepo } from '../src/main/data/skill-format/detailed-outline-md-repo'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { assertNovelProse } from '../src/main/data/agent-meta-detect'
import { findJsonObject } from '../src/shared/json-extract'
import type { AutoDeslopResult } from '../src/shared/types'

const root=process.env.DESLOP_LIVE_DIR!
const sourceRoot=process.env.DESLOP_SOURCE_DIR!
app.setPath('userData',join(root,'profile'))
app.whenReady().then(async()=>{
  const project=JSON.parse(await fs.readFile(join(sourceRoot,'project.json'),'utf8'))
  const llm=new LlmService(new SecretStore(process.env.DESLOP_PROVIDER_FILE??join(sourceRoot,'profile','config','providers.enc')))
  const actual=llm.generateStream.bind(llm)
  const previousCalls=(await fs.readdir(join(root,'calls'))).map(x=>/^(\d+)-request\.json$/.exec(x)?.[1]).filter(Boolean).map(Number)
  let sequence=Math.max(0,...previousCalls),chapter=0
  llm.generateStream=async(prompt,opts)=>{
    const id=String(++sequence).padStart(4,'0')
    await fs.writeFile(join(root,'calls',id+'-request.json'),JSON.stringify({chapter,feature:opts?.meta?.feature,prompt},null,2))
    await fs.writeFile(join(root,'status.json'),JSON.stringify({chapter,id,feature:opts?.meta?.feature,time:new Date().toISOString(),running:true}))
    const raw=await actual(prompt,opts)
    await fs.writeFile(join(root,'calls',id+'-response.txt'),raw)
    return raw
  }
  const service=new DeslopService(llm),prose=new ProseRepo(project.path)
  const cases=[]
  for(let n=1;n<=10;n++){
    const original=await prose.read(n)
    const old=JSON.parse(await fs.readFile(join(sourceRoot,`chapter-${n}-result.json`),'utf8')).autoDeslop
    cases.push({chapter:n,original,oldCandidate:old.dialogueQuality?.pendingDraft??null,oldIssues:old.issues??[],sourceHash:createHash('sha256').update(original).digest('hex')})
  }
  await fs.writeFile(join(root,'baseline.json'),JSON.stringify(cases,null,2))
  const results: {chapter:number;sourceHash:string;content:string;report:AutoDeslopResult}[]=[]
  for(const input of cases){
    chapter=input.chapter
    const file=join(root,`chapter-${chapter}-result.json`)
    try{
      const saved=JSON.parse(await fs.readFile(file,'utf8'))
      if(saved.sourceHash!==input.sourceHash)throw Error('实测恢复文件与当前原稿不匹配')
      results.push(saved);continue
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
    const detail=await new DetailedOutlineMdRepo(project.path).readChapter(chapter)
    const result=await autoDeslopProse(input.original,{
      service,llm,isTail:true,formatCandidate:formatChapterProse,
      styleContext:{genre:'悬疑/推理'},
      dialogueComposition:{mode:'write',context:'细纲仅作计划背景，原稿是本次润色的事实基线；不补尚未发生的情节，不为旧计划的篇幅或对白要求改动原稿。\n'+JSON.stringify(detail)},
      meta:{chapterNumber:chapter,projectId:project.id},
      validateCandidate:async candidate=>{assertNovelProse(candidate)}
    })
    if((result.report.status==='review_required'||result.report.status==='failed')&&result.content!==input.original)throw Error('拒绝稿覆盖了原稿')
    const record={chapter,sourceHash:input.sourceHash,...result}
    await fs.writeFile(file,JSON.stringify(record,null,2));results.push(record)
    console.log(JSON.stringify({chapter,status:result.report.status,attempts:result.report.dialogueQuality?.attempts,ratio:result.report.dialogueQuality?.afterRatio,issues:result.report.issues?.map(x=>x.slice(0,120))}))
  }
  chapter=0
  const auditInput=cases.map((x,i)=>({chapter:x.chapter,original:x.original,oldRejectedCandidate:x.oldCandidate,
    status:results[i].report.status,returned:results[i].content,newRejectedCandidate:results[i].report.dialogueQuality?.pendingDraft??null}))
  const raw=await llm.generateStream([
    '独立核对十章自动润色的事实保真，不评价文风或对白占比，不相信流程自称通过。',
    '逐章对照original与returned：人物知情、物品归属、事件因果、否定与猜测、并行调查线索和结尾决定是否保持。表达精简与有原有依据的台词重组允许；多条仍有效的核查方向被压成唯一一条属于事实变化。',
    '单纯姿势与反复确认可以压缩：若同一保管状态、规则或态度已经保留，删去无新增结果的再看、点头、再摸一下或同义叮嘱不算事实变化。首次发现、物品实际接触或交接、人物认知变化、新责任与条件、唯一关键警告不能这样省略；结合全文核对，不能只逐句数原稿动作或发言。',
    '另检查oldRejectedCandidate和newRejectedCandidate，指出有原句双重依据的事实变化；这些是未采用的候选，不能把其变化当作已保存稿被污染。没有候选则填空数组。',
    '严格JSON：{"completed":true,"chapters":[{"chapter":1,"returnedFactsUnchanged":true,"returnedIssues":[],"oldCandidateIssues":[{"originalQuote":"原稿连续引句","candidateQuote":"候选连续引句","reason":"差异"}],"newCandidateIssues":[]}]}，必须逐章覆盖1至10，returnedIssues同样使用双引句对象，无明确变化填[]。',
    JSON.stringify(auditInput)
  ].join('\n\n'),{maxTokens:12000,meta:{feature:'review'}})
  const audit=findJsonObject(raw)
  await fs.writeFile(join(root,'independent-audit.json'),JSON.stringify(audit,null,2))
  if(audit?.completed!==true||!Array.isArray(audit.chapters)||audit.chapters.length!==10)throw Error('独立审核未完整覆盖十章')
  const ids=audit.chapters.map((x:{chapter:number})=>x.chapter).sort((a:number,b:number)=>a-b)
  if(JSON.stringify(ids)!==JSON.stringify([1,2,3,4,5,6,7,8,9,10]))throw Error('独立审核章号不完整')
  for(const x of audit.chapters){
    if(x.returnedFactsUnchanged!==true||!Array.isArray(x.returnedIssues)||x.returnedIssues.length)throw Error(`第${x.chapter}章返回稿事实未通过独立复核`)
    const source=cases[x.chapter-1],returned=results[x.chapter-1].content
    for(const [issues,candidate]of [[x.oldCandidateIssues,source.oldCandidate],[x.newCandidateIssues,results[x.chapter-1].report.dialogueQuality?.pendingDraft]] as const){
      if(!Array.isArray(issues))throw Error('候选审计格式不完整')
      for(const issue of issues){if(typeof candidate!=='string'||!source.original.includes(issue.originalQuote)||!candidate.includes(issue.candidateQuote))throw Error('候选审计引句不可定位')}
    }
    if(createHash('sha256').update(await prose.read(x.chapter)).digest('hex')!==source.sourceHash)throw Error('原验收书被修改')
    if(!returned.trim())throw Error('返回空稿')
  }
  const summary={completed:true,time:new Date().toISOString(),results:results.map(x=>({chapter:x.chapter,status:x.report.status,ratio:x.report.dialogueQuality?.afterRatio,attempts:x.report.dialogueQuality?.attempts})),audit}
  await fs.writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2))
  await fs.writeFile(join(root,'status.json'),JSON.stringify({running:false,completed:true,time:new Date().toISOString()}))
  console.log('REAL_DESLOP_AUDIT_PASSED')
  app.exit(0)
}).catch(async e=>{console.error(e.message);await fs.writeFile(join(root,'error.txt'),e.stack||String(e));app.exit(1)})
