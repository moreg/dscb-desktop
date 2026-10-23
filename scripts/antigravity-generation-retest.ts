import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { repairDeslopScene } from '../src/main/data/deslop/scene-repair'
import { runAntigravity } from '../src/main/data/antigravity-runner'
import { findJsonObject } from '../src/shared/json-extract'
import { measureDialogue } from '../src/main/data/dialogue-quality'

async function main() {
  const dir=process.env.AGY_GENERATION_RETEST_DIR
  if(!dir)throw new Error('AGY_GENERATION_RETEST_DIR required: opt-in real model request')
  mkdirSync(dir,{recursive:true})
  const base='scratch/continuation-timing/2026-10-22-timeout-fixed'
  const old=JSON.parse(readFileSync(`${base}/call-5-prompt.json`,'utf8')).prompt as string
  const section=(a:string,b?:string)=>old.split(a+'\n\n')[1].split(b?'\n\n'+b:'\u0000')[0]
  const original=section('【原稿】','【上一份待修订稿（不是事实来源）】')
  const candidate=process.env.AGY_RETEST_CANDIDATE?readFileSync(process.env.AGY_RETEST_CANDIDATE,'utf8'):section('【上一份待修订稿（不是事实来源）】')
  const plan=readFileSync(`${base}/call-3-result.txt`,'utf8')
  const context=section('【项目约束】','【原稿】')
  const issues=JSON.parse(section('【历轮未解决问题（必须同时解决）】','【项目约束】'))
  if(process.env.AGY_RETEST_CANDIDATE)issues.push(`最新候选稿有效字数${measureDialogue(candidate).total}，仍超过3546字上限；须压缩至2622—3546字，保持每项原稿事实与独立限制，不能删剧情或放宽字数验收。`)
  let calls=0
  const started=Date.now()
  const log=(event:Record<string,unknown>)=>{const entry={at:new Date().toISOString(),...event};appendFileSync(`${dir}/events.jsonl`,JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry))}
  await repairDeslopScene(original,candidate,{
    llm:{generateStream:async(prompt:string)=>{
      if(++calls===1)return plan
      if(calls>2)throw new Error('Targeted replay ends after one candidate; no adoption')
      writeFileSync(`${dir}/original-prompt.txt`,prompt)
      const result=await runAntigravity(prompt,{model:'Gemini 3.8 Flash (High)',timeoutSec:600,onDiagnostic:log,onToken:token=>appendFileSync(`${dir}/partial.txt`,token)})
      writeFileSync(`${dir}/result.json`,result.full)
      const parsed=findJsonObject(result.full)
      log({completed:true,ms:Date.now()-started,words:typeof parsed?.text==='string'?measureDialogue(parsed.text).total:null,usage:result.usage})
      return result.full
    }} as never,context,issues,minWords:2622,maxWords:3546,startWithPatches:true,onAttempt:attempt=>log({attempt}),
    check:async(draft,constraints)=>{writeFileSync(`${dir}/candidate.txt`,draft);writeFileSync(`${dir}/constraints.json`,constraints);log({coveragePassed:true,words:measureDialogue(draft).total});return {unconfirmed:true,issues:['Targeted transport test: independent semantic reviews not run; no adoption']}}
  })
}
main().catch(error=>{console.error(error);process.exitCode=1})
