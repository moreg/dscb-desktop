/** 对真实模型录制做逐字请求匹配回放；不把回放算作新增模型调用。 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { autoDeslopProse } from '../src/main/data/auto-deslop'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import type { LlmService } from '../src/main/data/llm-service'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { assertNovelProse } from '../src/main/data/agent-meta-detect'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'

async function main():Promise<void>{
  const root=process.env.DESLOP_RECORDED_DIR!,priorRoot=process.env.DESLOP_PRIOR_RESULTS_DIR!
  const output=join(root,'reconciled')
  await fs.mkdir(output,{recursive:true})
  while(!(await Promise.all(Array.from({length:10},(_,i)=>fs.access(join(root,`chapter-${i+1}-result.json`)).then(()=>true,()=>false)))).every(Boolean)){
    await new Promise(resolve=>setTimeout(resolve,3000))
  }
  const cases=JSON.parse(await fs.readFile(join(root,'baseline.json'),'utf8')) as {chapter:number;original:string;sourceHash:string}[]
  const project=JSON.parse(await fs.readFile(join(process.env.DESLOP_SOURCE_DIR!,'project.json'),'utf8'))
  const prose=new ProseRepo(project.path),proof=[]
  for(const input of cases){
    const n=input.chapter,tag=`confirm${n}-`
    const files=(await fs.readdir(join(root,'calls'))).filter(x=>x.startsWith(tag)&&x.endsWith('-request.json')).sort()
    let cursor=0,mismatch:Error|undefined
    const llm={generateStream:async(prompt:string,opts?:{meta?:{feature?:unknown}})=>{
      const file=files[cursor++]
      if(!file){mismatch=Error(`第${n}章请求超出真实录制`);throw mismatch}
      const request=JSON.parse(await fs.readFile(join(root,'calls',file),'utf8'))
      if(request.prompt!==prompt||request.feature!==opts?.meta?.feature){mismatch=Error(`第${n}章第${cursor}个请求不匹配`);throw mismatch}
      return fs.readFile(join(root,'calls',file.replace('-request.json','-response.txt')),'utf8')
    }} as unknown as LlmService
    const prior=JSON.parse(await fs.readFile(join(priorRoot,`chapter-${n}-result.json`),'utf8'))
    const saved=JSON.parse(await fs.readFile(join(root,`chapter-${n}-result.json`),'utf8'))
    const initialDialogueDraft=prior.report.status==='applied'||prior.report.status==='unchanged'?prior.content:prior.report.dialogueQuality?.pendingDraft
    const result=await autoDeslopProse(input.original,{llm,service:new DeslopService(llm),isTail:true,formatCandidate:formatChapterProse,
      initialDialogueDraft,dialogueComposition:{mode:'write',context:'只依据原稿润色，原稿是事实基线；不补细纲事件、不增剧情，不要求对白比例。'},
      styleContext:{genre:'悬疑/推理'},meta:{chapterNumber:n,projectId:project.id},validateCandidate:async text=>{assertNovelProse(text)}})
    if(mismatch)throw mismatch
    if(result.content!==saved.content&&result.content!==input.original)throw Error(`第${n}章回放产生未验证的新采用稿`)
    if(createHash('sha256').update(await prose.read(n)).digest('hex')!==input.sourceHash)throw Error(`第${n}章原稿被改变`)
    await fs.writeFile(join(output,`chapter-${n}-result.json`),JSON.stringify({chapter:n,sourceHash:input.sourceHash,...result},null,2))
    proof.push({chapter:n,matchedRequests:cursor,recordedRequests:files.length,returnedTextMatchesLive:result.content===saved.content,
      status:result.report.status,currentIssues:result.report.issues??[]})
  }
  await fs.writeFile(join(output,'proof.json'),JSON.stringify({completed:true,usesRecordedRealResponses:true,newModelCalls:0,chapters:proof},null,2))
  console.log('RECORDED_REAL_MODEL_REPLAY_PASSED')
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
