/** Opt-in real-model timing. Novel writes are restricted to fresh isolated copies. */
import { app } from 'electron'
import { promises as fs, appendFileSync } from 'fs'
import { join, resolve, relative, sep } from 'path'
import { createHash } from 'crypto'
import { performance } from 'perf_hooks'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService, featureCategoryOf } from '../src/main/data/llm-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ProjectService } from '../src/main/data/project-service'
import { WriteService } from '../src/main/data/write-service'
import { DeslopService } from '../src/main/data/deslop/deslop-service'
import { BenchmarkResolver } from '../src/main/data/teardown/benchmark-resolver'
import { TeardownRepository } from '../src/main/data/teardown/teardown-repository'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterService } from '../src/main/data/chapter-service'
import { contentRevision } from '../src/main/data/chapter-revision'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { findJsonObject } from '../src/shared/json-extract'
import { reviewSceneDialogue } from '../src/main/data/scene-dialogue-review'
import { measureDialogue } from '../src/main/data/dialogue-quality'

const root=resolve(process.env.CONTINUATION_TIMING_DIR!)
const source=resolve(process.env.CONTINUATION_TIMING_PROJECT!)
const userData=join(app.getPath('appData'),'ai-writer-desktop')
app.setPath('userData',userData)
const started=performance.now()
let phase='setup'
const calls:Record<string,unknown>[]=[]
const scenarios:Record<string,unknown>[]=[]
const ms=()=>Math.round(performance.now()-started)
const event=(type:string,data:Record<string,unknown>={})=>{
  const entry={at:new Date().toISOString(),elapsedMs:ms(),phase,type,...data}
  appendFileSync(join(root,'events.jsonl'),JSON.stringify(entry)+'\n')
  console.log(JSON.stringify(entry))
}
const included=new Set(['大纲','细纲','正文','记忆','设定','追踪','对标','.cache','chapters','characters','outlines','styles'])
async function snapshot(dir:string):Promise<Record<string,string>> {
  const files:Record<string,string>={}
  async function walk(folder:string) {
    for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
      if(entry.isSymbolicLink())throw new Error('Symlink refused: '+entry.name)
      const path=join(folder,entry.name),rel=relative(dir,path)
      if(entry.isDirectory()){if(folder!==dir||included.has(entry.name))await walk(path)}
      else files[rel]=createHash('sha256').update(await fs.readFile(path)).digest('hex')
    }
  }
  await walk(dir);return files
}
async function main() {
  await fs.mkdir(root,{recursive:true})
  if(root===source||root.startsWith(source+sep))throw new Error('Isolation directory must be outside original project')
  const before=await snapshot(source)
  await fs.writeFile(join(root,'source-before.json'),JSON.stringify(before,null,2))
  const secret=new SecretStore(join(userData,'config','providers.enc'))
  const config=await secret.read()
  // Freeze the initial routing in memory, never persist or log credentials.
  secret.read=async()=>config
  const llm=new LlmService(secret)
  const generate=llm.generateStream.bind(llm)
  llm.generateStream=async(prompt,opts={})=>{
    const feature=opts.meta?.feature??'unknown'
    const routing=config.featureRouting?.[featureCategoryOf(feature)!]
    const provider=config.providers.find(p=>p.id===(routing?.providerId??config.activeId))
    const call:Record<string,unknown>={id:calls.length+1,phase,feature,startMs:ms(),
      model:routing?.model||provider?.model,protocol:provider?.protocol??'openai',
      promptChars:prompt.length,systemChars:opts.systemPrompt?.length??0,maxTokens:opts.maxTokens}
    calls.push(call);event('request_start',call)
    await fs.writeFile(join(root,`call-${call.id}-prompt.json`),JSON.stringify({prompt,systemPrompt:opts.systemPrompt}))
    const start=performance.now();let first:number|undefined,streamChars=0
    try {
      const answer=await generate(prompt,{...opts,onDiagnostic:({elapsedMs:cliElapsedMs,...detail})=>event('cli_diagnostic',{id:call.id,feature,cliElapsedMs,...detail}),onToken:token=>{
        if(first===undefined&&token.length){first=performance.now();call.firstTokenMs=Math.round(first-start);event('first_token',{id:call.id,feature,firstTokenMs:call.firstTokenMs})}
        streamChars+=token.length;call.lastTokenMs=Math.round(performance.now()-start);appendFileSync(join(root,`call-${call.id}-partial.txt`),token);opts.onToken?.(token)
      },onStatus:status=>{event('model_status',{id:call.id,feature,status});opts.onStatus?.(status)}})
      await fs.writeFile(join(root,`call-${call.id}-result.txt`),answer)
      call.outputChars=answer.length
      if(feature==='deslop:scene-repair') {
        try { const result=JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g,''));call.outputMode=Array.isArray(result.patches)?'patches':'text';call.patchCount=result.patches?.length } catch { call.outputMode='unparsed' }
      }
      return answer
    } catch(error) {call.error=(error as Error).message;throw error}
    finally {call.ms=Math.round(performance.now()-start);call.endMs=ms();call.streamChars=streamChars;event('request_end',call)}
  }
  const library=JSON.parse(await fs.readFile(join(userData,'library.json'),'utf8'))
  const meta=library.projects.find((p:{path:string})=>resolve(p.path)===source)
  if(!meta)throw new Error('Source project is not registered')
  const chapter=Number(process.env.CONTINUATION_TIMING_CHAPTER||66)
  for(const scenario of (process.env.CONTINUATION_TIMING_BASELINE_REVIEW ? ['baseline-review'] : process.env.CONTINUATION_TIMING_REPAIR_AND_FULL ? ['saved-draft-repair','full-flow'] : process.env.CONTINUATION_TIMING_POST_REVIEW ? ['post-review'] : process.env.CONTINUATION_TIMING_FULL_ONLY ? ['full-flow'] : process.env.CONTINUATION_TIMING_FULL ? ['candidate-review','full-flow'] : process.env.CONTINUATION_TIMING_ONLY_REPAIR ? ['saved-draft-repair'] : ['continuation','saved-draft-repair'])) {
    if(scenario==='saved-draft-repair'&&calls.some(c=>c.feature==='deslop:scene-repair'))break
    phase=scenario
    const base=join(root,scenario),dir=join(base,'projects','novel')
    await fs.mkdir(dir,{recursive:true})
    for(const entry of await fs.readdir(source,{withFileTypes:true})) {
      if(entry.isSymbolicLink())continue
      if(!entry.isDirectory()||included.has(entry.name))
        await fs.cp(join(source,entry.name),join(dir,entry.name),{recursive:true})
    }
    const settingsJson=JSON.parse(await fs.readFile(join(userData,'config','settings.json'),'utf8'))
    settingsJson.projectsRoot=join(base,'projects')
    await fs.writeFile(join(base,'settings.json'),JSON.stringify(settingsJson))
    await fs.writeFile(join(base,'library.json'),JSON.stringify({schemaVersion:1,projects:[{...meta,path:dir}]}))
    const settings=new SettingsRepository(join(base,'settings.json'))
    const projects=new ProjectService(join(base,'projects'),new LibraryRepository(join(base,'library.json')),settings)
    if(resolve(await projects.resolveDir(meta.id))!==dir)throw new Error('Resolved path escaped isolation')
    const writer=new WriteService(projects,llm,undefined,undefined,undefined,settings,
      new BenchmarkResolver(new TeardownRepository(join(userData,'teardown-library'))),new DeslopService(llm))
    const isolatedBefore=await snapshot(dir)
    await fs.writeFile(join(base,'before.json'),JSON.stringify(isolatedBefore,null,2))
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90*60_000)
    const at=ms();event('scenario_start',{chapter,isolatedDir:dir})
    try {
      let content:string
      const onGenerationStage=(stage:string)=>event('stage',{stage})
      const onAutoDeslopResult=(report:unknown)=>{event('deslop_result',{report})}
      if(scenario==='baseline-review'){
        const priorRoot=resolve(process.env.CONTINUATION_TIMING_BASELINE_REVIEW!)
        const original=await fs.readFile(join(priorRoot,'call-3-result.txt'),'utf8')
        content=await fs.readFile(process.env.CONTINUATION_TIMING_DRAFT||join(priorRoot,'full-flow','result.txt'),'utf8')
        const initial=JSON.parse(await fs.readFile(join(priorRoot,`call-${process.env.CONTINUATION_TIMING_BASELINE_SCENE_CALL||5}-result.txt`),'utf8'))
        const prior=JSON.parse(await fs.readFile(join(priorRoot,`call-${process.env.CONTINUATION_TIMING_CONTEXT_CALL||19}-prompt.json`),'utf8')).prompt as string
        const context=prior.split('【背景约束】\n\n')[1].split('\n\n【只读前部】')[0]
        const result=await reviewSceneDialogue(content,llm,{context,previousText:original,
          repairBaseline:{text:original,issues:initial.findings.map((x:{excerpt:string;reason:string})=>`${x.excerpt}：${x.reason}`)},
          signal:controller.signal,meta:{projectId:meta.id,chapterNumber:chapter}})
        await fs.writeFile(join(base,'review.json'),JSON.stringify(result,null,2))
        event('baseline_review_done',{result})
      }
      else if(scenario==='post-review'){
        content=await fs.readFile(process.env.CONTINUATION_TIMING_DRAFT!,'utf8')
        const review=await writer.runDeepReview(meta.id,content,chapter,{signal:controller.signal,meta:{feature:'batchDeepReview',projectId:meta.id,chapterNumber:chapter}})
        await fs.writeFile(join(base,'deep-review.json'),JSON.stringify(review,null,2))
        event('supplementary_review_done',{review})
      }
      else if(scenario==='candidate-review'){
        const original=await fs.readFile('scratch/continuation-timing/2026-10-22-measured/continuation/result.txt','utf8')
        const candidate=formatChapterProse(await fs.readFile('scratch/antigravity-budget-retest/candidate.txt','utf8'))
        const old=JSON.parse(await fs.readFile('scratch/continuation-timing/2026-10-22-timeout-fixed/call-5-prompt.json','utf8')).prompt as string
        const context=old.split('【项目约束】\n\n')[1].split('\n\n【原稿】')[0]
        const constraints=await fs.readFile('scratch/antigravity-budget-retest/constraints.json','utf8')
        const issues=JSON.parse(old.split('【历轮未解决问题（必须同时解决）】\n\n')[1].split('\n\n【项目约束】')[0])
        const beforeCalls=calls.length
        // Reuse the exact production fact-review prompt expression, with no weaker review instructions.
        const code=await fs.readFile('src/main/data/auto-deslop.ts','utf8')
        const start=code.indexOf('const raw = await llm.generateStream([',code.indexOf('const verifyFacts ='))
        const expression=code.slice(start+'const raw = await llm.generateStream('.length,code.indexOf(".join('\\n\\n')",start))+".join('\\n\\n')"
        const buildFactPrompt=new Function('original','candidate','options','attempt','formatIssue',`return ${expression}`)
        const factReview=async()=>{
          let verdict:Record<string,unknown>|undefined
          for(let attempt=0;attempt<2;attempt++){
            const raw=await llm.generateStream(buildFactPrompt(original,candidate,{dialogueComposition:{}},attempt,'核验格式不完整'),{
              signal:controller.signal,systemPrompt:'你是小说编辑，核对润色前后的事实一致性。依据原稿判断，无法确定时不通过。',
              maxTokens:2048,meta:{feature:'deslop:verify',projectId:meta.id,chapterNumber:chapter}})
            verdict=findJsonObject(raw)
            if(typeof verdict?.unchanged==='boolean'&&Array.isArray(verdict.issues)&&verdict.issues.every(x=>typeof x==='string')&&
              (verdict.unchanged===true?verdict.issues.length===0:verdict.issues.length>0))return {valid:true,...verdict}
          }
          return {valid:false,verdict}
        }
        const rules=await (writer as any).resolveDeslopRules()
        const whitelist=await (writer as any).resolveDeslopWhitelist(meta.id)
        const settled=await Promise.allSettled([
          factReview(),new DeslopService(llm).deslop(candidate,{...rules,whitelist,factBaseline:original,dialogueRepairLimit:0,
            levelOverride:'mild',polishDialogue:true,polishNarrative:true,isTail:true,signal:controller.signal,
            meta:{projectId:meta.id,chapterNumber:chapter},onProgress:message=>event('review_progress',{message}),
            dialogueComposition:{mode:'write',context:[context,constraints,...issues].join('\n')}})
        ])
        let scene:unknown
        if(!calls.slice(beforeCalls).some(c=>c.feature==='deslop:scene-dialogue-review')){
          scene=await reviewSceneDialogue(candidate,llm,{context,previousText:original,priorFindings:issues,signal:controller.signal,meta:{projectId:meta.id,chapterNumber:chapter}})
        }
        let guard:unknown={passed:true}
        try{await (writer as any).validateGeneratedProse(meta.id,chapter,candidate)}catch(error){guard={passed:false,error:(error as Error).message}}
        const results=settled.map(r=>r.status==='fulfilled'?{status:r.status,value:r.value}:{status:r.status,error:String(r.reason)})
        await fs.writeFile(join(base,'reviews.json'),JSON.stringify({originalRevision:contentRevision(original),candidateRevision:contentRevision(candidate),words:measureDialogue(candidate).total,results,scene,guard},null,2))
        event('candidate_review_done',{results,scene,guard})
        content=candidate
      }
      else if(scenario==='full-flow'){
        const chapters=new ChapterService(projects)
        let savedRevision=contentRevision(await new ProseRepo(dir).read(chapter))
        const persist=async(text:string)=>{await chapters.updateContent(meta.id,chapter,text,savedRevision,{source:'ai',note:'隔离完整流程实测'});savedRevision=contentRevision(text);event('prose_saved',{revision:savedRevision,chars:text.length})}
        const result=await writer.runFullFlowForChapter(meta.id,chapter,(stage,detail)=>event('stage',{stage,detail}),{
          signal:controller.signal,onAutoDeslopResult,onProseGenerated:persist,onFinalProseReady:persist,onContentGenerated:persist})
        await fs.writeFile(join(base,'flow-result.json'),JSON.stringify(result,null,2))
        content=result.content
        event('full_flow_result',{autoDeslop:result.autoDeslop,outlineDiff:result.outlineDiff,memoryApply:result.memoryApply,settingsApply:result.settingsApply,selfCheck:result.selfCheck,deepReview:result.deepReview})
      }
      else if(scenario==='continuation')content=await writer.generateChapterStream(meta.id,chapter,{signal:controller.signal,onGenerationStage,onAutoDeslopResult})
      else {
        const versions=JSON.parse(await fs.readFile(join(dir,'正文','.versions',`${String(chapter).padStart(3,'0')}.versions.json`),'utf8'))
        const raw=process.env.CONTINUATION_TIMING_DRAFT ? await fs.readFile(process.env.CONTINUATION_TIMING_DRAFT,'utf8') : versions.versions.find((v:{source:string})=>v.source==='ai')?.content??await new ProseRepo(dir).read(chapter)
        // Invoke the production post-generation stage on an isolated saved AI draft.
        content=await (writer as unknown as {autoDeslopGeneratedProse:(id:string,n:number,prose:string,style:null,opts:object)=>Promise<string>})
          .autoDeslopGeneratedProse(meta.id,chapter,raw,null,{signal:controller.signal,isTail:true,onGenerationStage,onAutoDeslopResult})
      }
      await fs.writeFile(join(base,'result.txt'),content)
      scenarios.push({scenario,ms:ms()-at,completed:true,outputChars:content.length})
    } catch(error){scenarios.push({scenario,ms:ms()-at,completed:false,error:(error as Error).message})}
    finally{
      clearTimeout(timer)
      const isolatedAfter=await snapshot(dir)
      const changes=[...new Set([...Object.keys(isolatedBefore),...Object.keys(isolatedAfter)])].filter(k=>isolatedBefore[k]!==isolatedAfter[k])
      await fs.writeFile(join(base,'after.json'),JSON.stringify(isolatedAfter,null,2))
      await fs.writeFile(join(base,'changed-files.json'),JSON.stringify(changes,null,2))
      event('scenario_end',{...scenarios.at(-1)!,changedFiles:changes})
    }
  }
  phase='verification'
  const after=await snapshot(source)
  const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>before[k]!==after[k])
  await fs.writeFile(join(root,'report.json'),JSON.stringify({source,chapter,scenarios,calls,sourceChangedFiles:changed,totalMs:ms()},null,2))
  event('finished',{sourceChangedFiles:changed,report:join(root,'report.json')})
}
app.whenReady().then(main).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
