import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import assert from 'node:assert/strict'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { WriteFlowService, parseOutlineDiffJson } from '../src/main/data/write-flow-service'
const root = process.env.TENCHAPTER_LIVE_DIR!
app.setPath('userData',join(root,'constraint-profile'))
app.whenReady().then(async()=>{
  let original: {file:string;outline:string;prose:string}|undefined
  for (const file of (await fs.readdir(join(root,'calls'))).filter(f=>f.endsWith('-request.json')).sort()) {
    const r=JSON.parse(await fs.readFile(join(root,'calls',file),'utf8'))
    if(r.chapter!==3) continue
    const prompt=r.body.messages.map((m:{content:string})=>m.content).join('\n')
    const m=/------ 本章细纲 ------\n([\s\S]*?)\n------ 本章正文 ------\n([\s\S]*)/.exec(prompt)
    if(m&&!m[2].includes('赵伯')) {original={file,outline:m[1],prose:m[2]};break}
  }
  assert(original,'没有找到未点名赵伯的原始第三章真实检查请求')
  await fs.writeFile(join(root,'constraint-live-original.json'),JSON.stringify(original,null,2))
  const llm=new LlmService(new SecretStore(join(root,'profile','config','providers.enc')))
  const raw=await new WriteFlowService(llm).checkOutlineStream(original.outline,original.prose,3,{maxTokens:8192})
  await fs.writeFile(join(root,'constraint-live-output.txt'),raw)
  const report=parseOutlineDiffJson(raw,3)
  assert(report.checked!==false,report.error)
  const invalid=report.diffs.filter(d=>d.type===1&&/赵伯/.test(d.actual+' '+d.suggestion)&&
    /未提及|未提到|没有提及|没有提到|尚不能确认|不足以认定/.test(d.actual+' '+d.suggestion))
  const result={time:new Date().toISOString(),sourceRequest:original.file,originalHasZhao:false,passed:invalid.length===0,diffs:report.diffs}
  await fs.writeFile(join(root,'constraint-live-result.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result))
  app.exit(result.passed?0:1)
}).catch(e=>{console.error(e.message);app.exit(1)})
