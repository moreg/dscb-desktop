import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import assert from 'node:assert/strict'
import { LlmService } from '../src/main/data/llm-service'
import { SecretStore } from '../src/main/data/secret-store'
import { ensureDialogueQuality } from '../src/main/data/dialogue-quality'
const root=process.env.DESLOP_LIVE_DIR!,source=process.env.DESLOP_SOURCE_DIR!
app.setPath('userData',join(root,'negative-profile'))
app.whenReady().then(async()=>{
  const baseline=JSON.parse(await fs.readFile(join(root,'baseline.json'),'utf8')).find((x:{chapter:number})=>x.chapter===10)
  assert(typeof baseline.oldCandidate==='string')
  const llm=new LlmService(new SecretStore(process.env.DESLOP_PROVIDER_FILE??join(source,'profile','config','providers.enc')))
  const actual=llm.generateStream.bind(llm)
  llm.generateStream=async(prompt,opts)=>{
    await fs.writeFile(join(root,'negative-fact-prompt.txt'),prompt)
    const raw=await actual(prompt,opts)
    await fs.writeFile(join(root,'negative-fact-output.txt'),raw)
    return raw
  }
  const result=await ensureDialogueQuality(baseline.original,baseline.oldCandidate,llm,{mode:'write',maxRepairs:0})
  const passed=result.report.passed===false && result.text===baseline.original &&
    result.report.issues.some(x=>/六号船|调查方向|核查线|两条|线索|追查/.test(x))
  await fs.writeFile(join(root,'negative-fact-result.json'),JSON.stringify({passed,report:result.report,returnedOriginal:result.text===baseline.original},null,2))
  console.log(JSON.stringify({passed,issues:result.report.issues}))
  app.exit(passed?0:1)
}).catch(e=>{console.error(e.message);app.exit(1)})
