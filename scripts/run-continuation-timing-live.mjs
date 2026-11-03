import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

if (!process.env.CONTINUATION_TIMING_PROJECT) throw new Error('CONTINUATION_TIMING_PROJECT required (real model calls)')
const root=resolve(process.env.CONTINUATION_TIMING_DIR||`scratch/continuation-timing/run-${Date.now()}`)
await mkdir(root,{recursive:true})
const entry=join(root,'harness.cjs')
await build({entryPoints:['scripts/continuation-timing-live.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron']})
const env={...process.env,CONTINUATION_TIMING_DIR:root}
delete env.ELECTRON_RUN_AS_NODE
console.log(`Isolated real-model timing: ${root}`)
const child=spawn(createRequire(import.meta.url)('electron'),[entry],{env,stdio:'inherit',windowsHide:true})
child.on('error',error=>{console.error(error);process.exitCode=1})
child.on('exit',code=>{process.exitCode=code||0})
