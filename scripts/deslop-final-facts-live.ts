import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { LlmService } from '../src/main/data/llm-service'
import { SecretStore } from '../src/main/data/secret-store'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { assertNovelProse } from '../src/main/data/agent-meta-detect'
import type { DeslopResult } from '../src/shared/types'

const root=process.env.DESLOP_LIVE_DIR!,source=process.env.DESLOP_SOURCE_DIR!
const tag=process.env.DESLOP_FACTS_TAG||'facts'
app.setPath('userData',join(root,`${tag}-profile`))
app.whenReady().then(async()=>{
  const baseline=JSON.parse(await fs.readFile(join(root,'baseline.json'),'utf8'))
  const llm=new LlmService(new SecretStore(join(source,'profile','config','providers.enc')))
  const actual=llm.generateStream.bind(llm)
  const pattern=new RegExp('^'+tag+'-(\\d+)-request\\.json$')
  const priorCalls=(await fs.readdir(join(root,'calls'))).map(x=>pattern.exec(x)?.[1]).filter(Boolean).map(Number)
  let sequence=Math.max(0,...priorCalls),chapter=0
  llm.generateStream=async(prompt,opts)=>{
    const id=tag+'-'+String(++sequence).padStart(3,'0')
    await fs.writeFile(join(root,'calls',id+'-request.json'),JSON.stringify({chapter,feature:opts?.meta?.feature,prompt},null,2))
    await fs.writeFile(join(root,`${tag}-status.json`),JSON.stringify({running:true,chapter,id,feature:opts?.meta?.feature}))
    const raw=await actual(prompt,opts)
    await fs.writeFile(join(root,'calls',id+'-response.txt'),raw)
    return raw
  }
  for(chapter of (process.env.DESLOP_FACTS_CHAPTERS||'1,2,3,4,6,7,8').split(',').map(Number)){
    const input=baseline.find((x:{chapter:number})=>x.chapter===chapter)
    const previous=JSON.parse(await fs.readFile(join(root,`chapter-${chapter}-result.json`),'utf8'))
    if(previous.report.status!=='applied')continue
    await fs.writeFile(join(root,`final-gate-input-${chapter}.json`),JSON.stringify(previous,null,2))
    const service=new DeslopService(llm)
    let first=true
    // 重放此前实际生成、联合审核通过的候选，专测最终采用入口；所有事实审核和修复调用仍走真实模型。
    const replay={deslop:async(...args:Parameters<DeslopService['deslop']>)=>{
      if(!first)return service.deslop(...args)
      first=false
      return {rewritten:previous.content,beforeWords:0,afterWords:0,deleteRatio:0,processedGates:[],
        remainingFindings:[],changeSummary:[],dialogueQuality:previous.report.dialogueQuality} as DeslopResult
    }} as DeslopService
    const result=await autoDeslopProse(input.original,{service:replay,llm,isTail:true,
      formatCandidate:formatChapterProse,dialogueComposition:{mode:'edit',allowSceneRewrite:true},
      validateCandidate:async text=>{assertNovelProse(text)},meta:{chapterNumber:chapter}})
    if(result.report.status!=='applied'&&result.report.status!=='unchanged'&&result.content!==input.original)throw Error('拒绝候选覆盖了原稿')
    await fs.writeFile(join(root,`final-gate-chapter-${chapter}-result.json`),JSON.stringify({chapter,sourceHash:input.sourceHash,...result},null,2))
    console.log(JSON.stringify({chapter,status:result.report.status,issues:result.report.issues}))
  }
  await fs.writeFile(join(root,`${tag}-status.json`),JSON.stringify({running:false,completed:true}))
  app.exit(0)
}).catch(e=>{console.error(e.message);app.exit(1)})
