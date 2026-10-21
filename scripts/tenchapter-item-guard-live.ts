import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { LongformGuard } from '../src/main/data/longform-guard'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'

const root = process.env.TENCHAPTER_LIVE_DIR!
const phase = process.env.TENCHAPTER_ITEM_GUARD_PHASE || 'after'
app.setPath('userData', join(root, 'item-guard-profile'))
app.whenReady().then(async () => {
  const project = JSON.parse(await fs.readFile(join(root, 'project.json'), 'utf8'))
  const source = join(root, 'item-guard-original.json')
  let input
  try { input = JSON.parse(await fs.readFile(source, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const request = JSON.parse(await fs.readFile(join(root,'calls','19268-0044-request.json'),'utf8'))
    const user = request.body.messages.find((m: {role:string})=>m.role==='user').content as string
    input = {chapterNumber:7, content:await new ProseRepo(project.path).read(7),
      plan:await fs.readFile(join(project.path,'大纲','大纲.md'),'utf8'),
      history:user.slice(user.indexOf('# 较早已写章节概要'),user.indexOf('# 【写前/写后自检清单】'))}
    if (!input.content.includes('青布封套') || !input.history.includes('绸布封套')) throw new Error('缺少真实旧名回流原稿或历史对照')
    await fs.writeFile(source,JSON.stringify(input,null,2))
  }
  const llm = new LlmService(new SecretStore(join(root,'profile','config','providers.enc')))
  const actual = llm.generateStream.bind(llm)
  llm.generateStream = async (prompt, opts) => {
    await fs.writeFile(join(root,`item-guard-${phase}-prompt.txt`),prompt)
    const raw = await actual(prompt,opts)
    await fs.writeFile(join(root,`item-guard-${phase}-output.txt`),raw)
    return raw
  }
  let error = ''
  try { await new LongformGuard(llm).check(input) } catch (e) { error=(e as Error).message }
  const blocked = error.startsWith('LONGFORM_CONFLICT:')
  const result = {phase,time:new Date().toISOString(),blocked,error,expected:phase==='before'?!error:blocked}
  await fs.writeFile(join(root,`item-guard-${phase}-result.json`),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result))
  app.exit(result.expected?0:1)
}).catch(e=>{console.error(e.message);app.exit(1)})
