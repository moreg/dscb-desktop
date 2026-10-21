import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { LlmService } from '../src/main/data/llm-service'
import { SecretStore } from '../src/main/data/secret-store'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { assertNovelProse } from '../src/main/data/agent-meta-detect'

const root=process.env.DESLOP_LIVE_DIR!,source=process.env.DESLOP_SOURCE_DIR!
const tag=process.env.DESLOP_JOB_TAG||'live'
app.setPath('userData',join(root,`${tag}-profile`))
app.whenReady().then(async()=>{
  const project=JSON.parse(await fs.readFile(join(source,'project.json'),'utf8'))
  const prose=new ProseRepo(project.path)
  const llm=new LlmService(new SecretStore(process.env.DESLOP_PROVIDER_FILE??join(source,'profile','config','providers.enc')))
  const actual=llm.generateStream.bind(llm)
  const send=globalThis.fetch
  globalThis.fetch=async(...args)=>{
    const res=await send(...args)
    if(res.status===429){
      const body=await res.clone().json().catch(()=>null) as {error?:{code?:unknown;type?:unknown}}|null
      await fs.writeFile(join(root,`${tag}-rate-limit.json`),JSON.stringify({status:429,
        retryAfter:res.headers.get('retry-after'),code:body?.error?.code,type:body?.error?.type,time:new Date().toISOString()}))
    }
    return res
  }
  const pattern=new RegExp('^'+tag+'-(\\d+)-request\\.json$')
  const prior=(await fs.readdir(join(root,'calls'))).map(x=>pattern.exec(x)?.[1]).filter(Boolean).map(Number)
  let sequence=Math.max(0,...prior),chapter=0
  llm.generateStream=async(prompt,opts)=>{
    const id=tag+'-'+String(++sequence).padStart(3,'0')
    await fs.writeFile(join(root,'calls',id+'-request.json'),JSON.stringify({chapter,feature:opts?.meta?.feature,prompt},null,2))
    await fs.writeFile(join(root,`${tag}-status.json`),JSON.stringify({running:true,chapter,id,feature:opts?.meta?.feature,time:new Date().toISOString()}))
    const raw=await actual(prompt,opts)
    await fs.writeFile(join(root,'calls',id+'-response.txt'),raw)
    return raw
  }
  const service=new DeslopService(llm)
  for(chapter of (process.env.DESLOP_LIVE_CHAPTERS||'1,2,3,4,5,6,7,8,9,10').split(',').map(Number)){
    const file=join(root,`chapter-${chapter}-result.json`)
    const original=await prose.read(chapter)
    const sourceHash=createHash('sha256').update(original).digest('hex')
    try{const saved=JSON.parse(await fs.readFile(file,'utf8'));if(saved.sourceHash!==sourceHash)throw Error('源稿已改变');continue}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
    let initialDialogueDraft:string|undefined
    if(process.env.DESLOP_PRIOR_RESULTS_DIR){
      const prior=JSON.parse(await fs.readFile(join(process.env.DESLOP_PRIOR_RESULTS_DIR,`chapter-${chapter}-result.json`),'utf8'))
      if(prior.sourceHash!==sourceHash)throw Error('恢复试稿与原稿指纹不匹配')
      initialDialogueDraft=prior.report.status==='applied'||prior.report.status==='unchanged'
        ?prior.content:prior.report.dialogueQuality?.pendingDraft
    }
    const result=await autoDeslopProse(original,{service,llm,isTail:true,formatCandidate:formatChapterProse,
      initialDialogueDraft,
      dialogueComposition:{mode:'write',context:'只依据原稿润色，原稿是事实基线；不补细纲事件、不增剧情，不要求对白比例。'},
      styleContext:{genre:'悬疑/推理'},meta:{chapterNumber:chapter,projectId:project.id},
      validateCandidate:async text=>{assertNovelProse(text)}})
    if(result.report.status!=='applied'&&result.report.status!=='unchanged'&&result.content!==original)throw Error('拒绝候选覆盖原稿')
    if(createHash('sha256').update(await prose.read(chapter)).digest('hex')!==sourceHash)throw Error('源书被改写')
    await fs.writeFile(file,JSON.stringify({chapter,sourceHash,implementationRevision:process.env.DESLOP_IMPLEMENTATION_REVISION,
      resumedDraft:initialDialogueDraft!==undefined,...result},null,2))
    console.log(JSON.stringify({chapter,status:result.report.status,repairs:result.report.repairAttempts,issues:result.report.issues?.map(x=>x.slice(-160))}))
  }
  await fs.writeFile(join(root,`${tag}-status.json`),JSON.stringify({running:false,completed:true}))
  app.exit(0)
}).catch(async e=>{console.error(e.message);await fs.writeFile(join(root,`${tag}-error.txt`),e.stack||String(e));app.exit(1)})
