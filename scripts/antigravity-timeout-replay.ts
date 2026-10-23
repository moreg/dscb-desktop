import { readFileSync, appendFileSync, writeFileSync } from 'fs'
import { runAntigravity } from '../src/main/data/antigravity-runner'
// Opt-in: replay a captured local request against the real CLI.
const dir=process.env.AGY_TIMEOUT_REPLAY_DIR
if (!dir) throw new Error('AGY_TIMEOUT_REPLAY_DIR required (real model call; expects original-prompt.txt)')
const started=Date.now()
const log=(event:Record<string,unknown>)=>{appendFileSync(`${dir}/events.jsonl`,JSON.stringify({at:new Date().toISOString(),...event})+'\n');console.log(JSON.stringify(event))}
runAntigravity(readFileSync(`${dir}/original-prompt.txt`,'utf8'),{model:'Gemini 3.8 Flash (High)',timeoutSec:600,onDiagnostic:log,onStatus:status=>log({status}),onToken:token=>appendFileSync(`${dir}/partial.txt`,token)}).then(result=>{writeFileSync(`${dir}/result.json`,result.full);log({completed:true,ms:Date.now()-started,chars:result.full.length})}).catch(error=>{log({completed:false,ms:Date.now()-started,error:error.message});process.exitCode=1})
