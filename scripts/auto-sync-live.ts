import { app } from 'electron'
import { join, resolve } from 'path'
import { promises as fs } from 'fs'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { UsageRepository } from '../src/main/data/usage-repository'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { ChapterService } from '../src/main/data/chapter-service'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { parseMemoryExtractionJson, parseOutlineDiffJson } from '../src/shared/parsers'
const root=resolve('scratch/auto-sync-live')
app.setPath('userData',join(root,'profile'))
app.whenReady().then(async()=>{
 const lib=JSON.parse(await fs.readFile(join(root,'library.json'),'utf8'));const id=lib.projects[0].id;const dir=lib.projects[0].path
 const secret=new SecretStore(join(root,'profile','config','providers.enc'))
 const settings=new SettingsRepository(join(root,'profile','config','settings.json'))
 const projects=new ProjectService(join(root,'unused'),new LibraryRepository(join(root,'library.json')),settings)
 const llm=new LlmService(secret,new UsageRepository(join(root,'usage')))
 const old=llm.generateStream.bind(llm)
 llm.generateStream=async(p,o={})=>{console.log('MODEL_START',o.meta?.feature);try{return await old(p,o)}finally{console.log('MODEL_END',o.meta?.feature)}}
 const svc=new WriteService(projects,llm,undefined,undefined,new ChapterService(projects),settings)
 const chapter=4;const prose=await new ProseRepo(dir).read(chapter)
 if(!prose.trim()) throw Error('No prose')
 if (process.env.OUTLINE_ONLY === '1') {
   const prior=JSON.parse(await fs.readFile(join(root,'result.json'),'utf8'))
   const resolved=await svc.autoResolveOutlineDiffs(id,chapter,prose,prior.outline)
   console.log('OUTLINE_RECHECK',JSON.stringify({resolved,remaining:prior.outline.diffs.length-resolved.length, diffs:prior.outline.diffs}))
   return
 }
 const outline=parseOutlineDiffJson(await svc.checkOutlineStream(id,chapter,'',prose),chapter)
 console.log('OUTLINE',JSON.stringify({checked:outline.checked,diffs:outline.diffs.length}))
 const extracted=parseMemoryExtractionJson(await svc.extractMemoryStream(id,chapter,{},prose),chapter)
 if(extracted.parseError) throw Error(extracted.parseError)
 console.log('EXTRACTION',JSON.stringify({plot:extracted.newPlotPoints.length,characters:extracted.newCharacters.length}))
 const resolved=await svc.autoResolveOutlineDiffs(id,chapter,prose,outline)
 console.log('OUTLINE_DECISION',JSON.stringify({resolved,remaining:outline.diffs.length-resolved.length}))
 const memory=await svc.autoApplyExtractedMemory(id,chapter,prose,extracted)
 console.log('MEMORY_RESULT',JSON.stringify(memory))
 await fs.writeFile(join(root,'result.json'),JSON.stringify({outline,resolved,extraction:extracted,memory},null,2))
}).then(()=>app.exit(0)).catch(e=>{console.error('FAILED',e);app.exit(1)})
