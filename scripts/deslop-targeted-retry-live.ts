import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { LlmService } from '../src/main/data/llm-service'
import { SecretStore } from '../src/main/data/secret-store'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { assertNovelProse } from '../src/main/data/agent-meta-detect'
const root=process.env.DESLOP_LIVE_DIR!,source=process.env.DESLOP_SOURCE_DIR!
const tag=process.env.DESLOP_RETRY_TAG||'retry'
app.setPath('userData',join(root,`${tag}-profile`))
app.whenReady().then(async()=>{
  const baseline=JSON.parse(await fs.readFile(join(root,'baseline.json'),'utf8'))
  const llm=new LlmService(new SecretStore(join(source,'profile','config','providers.enc')))
  const actual=llm.generateStream.bind(llm)
  const pattern=new RegExp('^'+tag+'-(\\d+)-request\\.json$')
  const existing=(await fs.readdir(join(root,'calls'))).map(x=>pattern.exec(x)?.[1]).filter(Boolean).map(Number)
  let sequence=Math.max(0,...existing),chapter=0
  llm.generateStream=async(prompt,opts)=>{
    const id=tag+'-'+String(++sequence).padStart(3,'0')
    await fs.writeFile(join(root,'calls',id+'-request.json'),JSON.stringify({chapter,feature:opts?.meta?.feature,prompt},null,2))
    await fs.writeFile(join(root,`${tag}-status.json`),JSON.stringify({running:true,chapter,id,feature:opts?.meta?.feature,time:new Date().toISOString()}))
    const raw=await actual(prompt,opts)
    await fs.writeFile(join(root,'calls',id+'-response.txt'),raw)
    return raw
  }
  for(chapter of (process.env.DESLOP_RETRY_CHAPTERS||'3,5').split(',').map(Number)){
    const input=baseline.find((x:{chapter:number})=>x.chapter===chapter)
    const retryFile=join(root,`retry-chapter-${chapter}-result.json`)
    const first=await fs.readFile(retryFile,'utf8').then(JSON.parse).catch(async e=>{
      if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e
      return JSON.parse(await fs.readFile(join(root,`chapter-${chapter}-result.json`),'utf8'))
    })
    if(first.report.status!=='review_required')continue
    await fs.writeFile(join(root,`retry-input-${chapter}-${Date.now()}.json`),JSON.stringify(first,null,2))
    const result=await autoDeslopProse(input.original,{
      service:new DeslopService(llm),llm,isTail:true,formatCandidate:formatChapterProse,
      initialDialogueDraft:first.report.dialogueQuality?.pendingDraft,
      dialogueComposition:{mode:'edit',allowSceneRewrite:true,
        context:'本次为作者要求的定向复修，原稿始终是事实基线。不得补新剧情或改变已知信息和后续决定。\n上次具体复核问题：'+JSON.stringify(first.report.issues),
        revisionInstruction:'修正这些具体接话问题，保留有效互动；重复的说教可压缩，不为对白占比改稿。'},
      validateCandidate:async text=>{assertNovelProse(text)},meta:{chapterNumber:chapter}
    })
    if(result.report.status==='review_required'&&result.content!==input.original)throw Error('复修拒绝稿覆盖原稿')
    await fs.writeFile(join(root,`retry-chapter-${chapter}-result.json`),JSON.stringify({chapter,sourceHash:input.sourceHash,...result},null,2))
    console.log(JSON.stringify({chapter,status:result.report.status,issues:result.report.issues?.map(x=>x.slice(0,160))}))
  }
  await fs.writeFile(join(root,`${tag}-status.json`),JSON.stringify({running:false,completed:true,time:new Date().toISOString()}))
  app.exit(0)
}).catch(e=>{console.error(e.message);app.exit(1)})
