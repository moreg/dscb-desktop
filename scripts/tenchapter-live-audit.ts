import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import assert from 'node:assert/strict'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { hashProse, ProseMemoryIndex } from '../src/main/data/memory/prose-memory-index'
import { readLongformReviewState, blockedLongformChapters } from '../src/main/data/longform-review-state'
import { parseContinuityFacts } from '../src/main/data/memory/continuity-context'
import { findJsonObject } from '../src/shared/json-extract'
import { sanitizeForFileName } from '../src/main/data/memory/entity-helpers'
import { CharacterRepo } from '../src/main/data/memory/character-repo'
const root = process.env.TENCHAPTER_LIVE_DIR!
assert(root)
app.setPath('userData', join(root, 'profile'))
app.whenReady().then(async () => {
  const p = JSON.parse(await fs.readFile(join(root, 'project.json'), 'utf8'))
  const config = await fs.readFile(join(root, 'run-config.json'), 'utf8').then(JSON.parse).catch(() => ({}))
  const entityScenario = config.scenario === 'entity-write'
  const events = (await fs.readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  const processes: { event: string; pid: number; time: string }[] = JSON.parse(await fs.readFile(join(root, 'processes.json'), 'utf8'))
  const requests = await Promise.all((await fs.readdir(join(root, 'calls'))).filter(f => f.endsWith('-request.json'))
    .map(async f => ({ file: f, ...JSON.parse(await fs.readFile(join(root, 'calls', f), 'utf8')) })))
  const evidence: Record<string, unknown> = { root, processes, chapterGenerationCounts: {} }
  const checks: { name: string; passed: boolean; detail: string }[] = []
  const check = async (name: string, task: () => Promise<string | void>) => {
    try { checks.push({ name, passed: true, detail: await task() || '通过' }) }
    catch (e) { checks.push({ name, passed: false, detail: (e as Error).message }) }
  }
  await check('实际批次完成且十章均留下检查结果与正文绑定的记忆候选', async () => {
    const batch = JSON.parse(await fs.readFile(join(root, 'batch-result.json'), 'utf8'))
    assert.equal(batch.progress?.status, 'completed')
    for (let n = 1; n <= 10; n++) {
      const result = JSON.parse(await fs.readFile(join(root, `chapter-${n}-result.json`), 'utf8'))
      assert.equal(result.chapterNumber, n)
      assert.equal(result.outlineDiff?.checked, true, `第${n}章未完成细纲对照`)
      assert.equal(result.outlineDiff?.passed, true, `第${n}章细纲偏离未处理`)
      assert(result.selfCheck && result.chapterSummary, `第${n}章缺少自检或概要`)
      assert.equal(result.memoryApply?.entitiesReviewed, true, `第${n}章实体记忆未审核`)
      const candidate = JSON.parse(await fs.readFile(join(p.path, '.cache', 'memory-candidates', `chapter-${n}.json`), 'utf8'))
      assert.equal(candidate.sourceHash, hashProse(await new ProseRepo(p.path).read(n)))
      assert(['applied', 'partial'].includes(candidate.status), `第${n}章记忆未完成处理`)
      assert(requests.some(r => r.kind === 'longform' && r.chapter === n), `第${n}章没有真实长篇一致性检查请求`)
    }
  })
  await check('真正结束并启动不同应用进程', async () => {
    const killed = processes.find(e => e.event === 'force-kill')
    assert(killed)
    assert(processes.some(e => e.event === 'exit' && e.pid === killed.pid))
    assert.equal(JSON.parse(await fs.readFile(join(root, entityScenario ? 'kill-result-entity.json' : 'kill-result.json'), 'utf8')).status, 0)
    assert(new Set(processes.filter(e => e.event === 'start').map(e => e.pid)).size >= 2)
    const resumed = events.find(e => e.event === 'resume-ui-click' && /第 4 章检查/.test(e.button))
    assert(resumed && resumed.pid !== killed.pid)
    const request = events.find(e => e.event === 'batch-request' && e.pid === resumed.pid)
    assert.equal(request?.channel, 'write:resumeBatch')
    assert.equal(request?.input?.batchState?.pendingPostProcessChapter, 4)
    assert.equal(request?.input?.toChapter, 10)
  })
  await check('十章正文各生成一次，无缺章、无重复生成', async () => {
    const counts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1,
      requests.filter(r => r.kind === 'chapter' && r.chapter === i + 1).length]))
    evidence.chapterGenerationCounts = counts
    assert.deepEqual(Object.values(counts), Array(10).fill(1))
    assert.equal(requests.filter(r => r.kind === 'chapter').length, 10, '恢复后意外扩展了批次范围')
    assert.deepEqual(await new ProseRepo(p.path).listChapterNumbers(), Array.from({ length: 10 }, (_, i) => i + 1))
    for (let n = 1; n <= 10; n++) assert((await new ProseRepo(p.path).read(n)).length > 500, `第${n}章为空或非完整正文`)
  })
  await check('关闭时第四章已落盘，但未检查稿没有进入历史或概要', async () => {
    const snapshot = join(root, entityScenario ? 'before-force-kill-entity' : 'before-force-kill')
    const body = await new ProseRepo(snapshot).read(4)
    assert(body.length > 500)
    if (entityScenario) {
      const edits = JSON.parse(await fs.readFile(join(root, 'author-edits.json'), 'utf8'))
      assert.equal(hashProse(body), hashProse(edits.oldProse))
      const final = await new ProseRepo(p.path).read(4)
      assert(final.includes('桐木信匣') && final.includes('棉布封套'))
      assert(!final.includes('松木信匣') && !final.includes('青布封套'), '恢复使用了作者修改前的旧正文')
    } else assert.equal(hashProse(await new ProseRepo(p.path).read(4)), hashProse(body), '第4章恢复后覆盖了原保存正文')
    assert((await readLongformReviewState(snapshot)).batchPending?.['4'])
    assert(!(await new ProseMemoryIndex(snapshot).readBefore(5)).some(c => c.chapterNumber === 4))
    assert.equal(await new ChapterSummaryRepo(snapshot).readCurrent(4, body), null)
  })
  await check('完成检查后才进入下一章，关闭后第4章检查确实重跑', async () => {
    const resumed = events.find(e => e.event === 'resume-ui-click' && /第 4 章检查/.test(e.button))
    assert(resumed)
    const restartedPid = resumed.pid
    assert(requests.some(r => r.kind === 'memory' && r.chapter === 4 && r.pid === restartedPid))
    assert(requests.some(r => r.kind === 'longform' && r.chapter === 4 && r.pid === restartedPid))
    for (let n = 2; n <= 10; n++) {
      const generated = events.findIndex(e => e.event === 'model-start' && e.kind === 'chapter' && e.chapter === n)
      const completed = events.findIndex(e => e.event === 'chapter-complete' && e.number === n - 1)
      assert(completed >= 0 && generated > completed, `第${n}章生成早于前章完成检查`)
    }
  })
  if (!entityScenario) await check('第7章记忆已提交后的真实关闭恢复不重复追加历史', async () => {
    const snapshot = join(root, 'before-force-kill-seven')
    assert.equal(hashProse(await new ProseRepo(p.path).read(7)), hashProse(await new ProseRepo(snapshot).read(7)), '第7章恢复后覆盖了原保存正文')
    assert((await readLongformReviewState(snapshot)).batchPending?.['7'])
    assert(!(await new ProseMemoryIndex(snapshot).readBefore(8)).some(c => c.chapterNumber === 7))
    const before = JSON.parse(await fs.readFile(join(snapshot, '.cache', 'memory-candidates', 'chapter-7.json'), 'utf8'))
    assert(['applied', 'partial'].includes(before.status), '关闭点尚未完成任何记忆提交')
    const resumed = events.find(e => e.event === 'resume-ui-click' && /第 7 章检查/.test(e.button))
    assert(resumed)
    const killed = JSON.parse(await fs.readFile(join(root, 'kill-result-7.json'), 'utf8'))
    assert.equal(killed.status, 0)
    assert.notEqual(resumed.pid, killed.pid)
    assert(requests.some(r => r.pid === resumed.pid && r.kind === 'memory' && r.chapter === 7))
    const candidates = JSON.parse(await fs.readFile(join(p.path, '.cache', 'memory-candidates', 'chapter-7.json'), 'utf8'))
    const points = (await fs.readdir(join(p.path, '记忆', '剧情点'))).filter(f => /^第007章 /.test(f))
    const allowed = new Set(candidates.extraction.newPlotPoints.map((point: { title: string }) => `第007章 ${sanitizeForFileName(point.title)}.md`))
    assert(points.every(file => allowed.has(file)), '恢复后留下旧标题的重复剧情点')
    assert(points.length <= allowed.size)
    for (const file of ['时间线.md', '上下文.md']) {
      const text = await fs.readFile(join(p.path, '追踪', file), 'utf8')
      assert(text.split('\n').filter(line => /^\| 第 7 章 \|/.test(line)).length <= 1, `${file}重复追加第7章`)
    }
    const states = await fs.readFile(join(p.path, '追踪', '角色状态.md'), 'utf8')
    assert((states.match(/## 自动历史快照（第 7 章）/g) || []).length <= 1)
  })
  if (entityScenario) {
    await check('确实在新增实体文件提交后、写入函数返回前关闭，归属记录先于卡片存在', async () => {
      const flag = JSON.parse(await fs.readFile(join(root, 'crash-ready-entity.json'), 'utf8'))
      assert.equal(flag.phase, 'entity committed, writer not returned')
      const snapshot = join(root, 'before-force-kill-entity')
      const ledger = JSON.parse(await fs.readFile(join(snapshot, '追踪', '.automatic-entity-ledger.json'), 'utf8'))
      for (const name of ['松木信匣', '青布封套']) {
        const receipt = ledger.chapters['4'].find((r: {name:string}) => r.name === name)
        assert(receipt, `${name}没有提前写入归属记录`)
        assert.equal(hashProse(await fs.readFile(join(snapshot, receipt.path), 'utf8')), receipt.hash)
      }
      assert(!events.some(e => e.event === 'chapter-complete' && e.number === 4 && e.pid === flag.pid))
      evidence.appBuilds = await Promise.all(processes.filter(e => e.event === 'start').map(e =>
        fs.readFile(join(root, `app-build-${e.pid}.json`), 'utf8').then(JSON.parse)))
    })
    await check('作者修订后旧自动实体清理，手改卡片保留，新实体使用当前正文', async () => {
      const edits = JSON.parse(await fs.readFile(join(root, 'author-edits.json'), 'utf8'))
      assert(events.some(e => e.event === 'author-edits-through-app-ipc'))
      assert.equal(await fs.access(join(p.path,'记忆','道具','松木信匣.md')).then(()=>true,()=>false),false)
      const protectedCard = await fs.readFile(join(p.path,'记忆','道具','青布封套.md'),'utf8')
      assert(protectedCard.includes(edits.protectedNotes), '作者手改卡片被覆盖或删除')
      assert.equal(hashProse(protectedCard),edits.protectedFileHash,'作者手改卡片文件在恢复后被改变')
      for (const name of ['桐木信匣', '棉布封套']) {
        const text = await fs.readFile(join(p.path,'记忆','道具',`${name}.md`),'utf8')
        assert(text.includes('第4章观察快照'), `${name}缺少当前提取来源`)
      }
      const original = JSON.parse(await fs.readFile(join(root,'before-force-kill-entity','追踪','.automatic-entity-ledger.json'),'utf8'))
      const currentProse = await new ProseRepo(p.path).read(4)
      for (const receipt of original.chapters['4']) {
        if (currentProse.includes(receipt.name)) await fs.access(join(p.path,receipt.path))
      }
      const candidate = JSON.parse(await fs.readFile(join(p.path,'.cache','memory-candidates','chapter-4.json'),'utf8'))
      assert(!candidate.extraction.newItems.some((e:{name:string})=>['松木信匣','青布封套'].includes(e.name)))
    })
    await check('人物手改字段保留，模型确实尝试更新该字段，标准状态不被旧副本覆盖', async () => {
      const edits = JSON.parse(await fs.readFile(join(root,'author-edits.json'),'utf8'))
      const chars = await new CharacterRepo(p.path).list()
      assert.equal(chars.find(c=>c.id===edits.characterId)?.customFields?.['位置'],edits.protectedPosition)
      let attempted = false
      for (let n=4;n<=10;n++) {
        const c = JSON.parse(await fs.readFile(join(p.path,'.cache','memory-candidates',`chapter-${n}.json`),'utf8'))
        if (c.extraction.characterStateChanges.some((s:{name:string;field:string})=>s.name==='陆安'&&s.field==='位置')) attempted=true
      }
      assert(attempted, '真实模型未尝试更新手改字段，保护场景未覆盖')
      const ledger = JSON.parse(await fs.readFile(join(p.path,'追踪','.automatic-state-ledger.json'),'utf8'))
      const states = Object.values(ledger.fields).filter((r: any)=>r.field==='当前状态') as {characterId:string;lastApplied:string}[]
      assert(states.length>0, '真实人物状态更新未覆盖')
      for (const state of states) assert.equal(chars.find(c=>c.id===state.characterId)?.synopsis,state.lastApplied)
    })
  }
  await check('所有概要绑定当前正文且台账证据可定位，隔离状态清除', async () => {
    const blocked = blockedLongformChapters(await readLongformReviewState(p.path))
    const summaries = []
    for (let n = 1; n <= 10; n++) {
      assert(!blocked[n], `第${n}章仍被隔离`)
      const content = await new ProseRepo(p.path).read(n)
      const summary = await new ChapterSummaryRepo(p.path).readCurrent(n, content)
      assert(summary, `第${n}章概要缺失、失效或被隔离`)
      assert.equal(summary.sourceHash, hashProse(content))
      parseContinuityFacts(summary.continuity, content)
      summaries.push(summary)
    }
    evidence.summaries = summaries
    assert.equal((await new ProseMemoryIndex(p.path).readBefore(11)).length, 10)
    for (const file of await fs.readdir(join(p.path, '记忆', '剧情点'))) {
      const chapter = /^第(\d+)章 /.exec(file)
      if (!chapter) continue
      const text = await fs.readFile(join(p.path, '记忆', '剧情点', file), 'utf8')
      const source = /\*\*正文哈希\*\*：[ \t]*([a-f0-9]{64})/.exec(text)
      assert(source, `${file}缺少正文版本绑定`)
      assert.equal(source[1], hashProse(await new ProseRepo(p.path).read(Number(chapter[1]))), `${file}仍绑定旧正文`)
    }
  })
  const chapters = await Promise.all(Array.from({ length: 10 }, async (_, i) => ({ number: i + 1,
    prose: await new ProseRepo(p.path).read(i + 1), summary: await new ChapterSummaryRepo(p.path).read(i + 1) })))
  const memoryFiles: { path: string; text: string }[] = []
  async function collectMemory(relative: string) {
    for (const entry of await fs.readdir(join(p.path, relative), { withFileTypes: true })) {
      if (entry.name === '章节概要') continue
      const file = join(relative, entry.name)
      if (entry.isDirectory()) await collectMemory(file)
      else if (/\.(?:md|json)$/.test(entry.name)) memoryFiles.push({ path: file, text: await fs.readFile(join(p.path, file), 'utf8') })
    }
  }
  await collectMemory('记忆')
  evidence.memoryFiles = memoryFiles
  const authorRevisions = entityScenario ? JSON.parse(await fs.readFile(join(root,'author-edits.json'),'utf8')) : undefined
  await check('独立真实模型审核正文与记忆，不把计划、传闻或他人知识污染为事实', async () => {
    const llm = new LlmService(new SecretStore(join(root, 'profile', 'config', 'providers.enc')))
    const prompt = ['独立审计真实生成的十章小说及其概要。不是作者，也不相信流程自称通过。',
      '逐章核对：1. 陆安第4章独自读信后才确认赵伯内应身份；陆宁第7章当面读信获告知后才确认，沈禾未获告知不能继承兄弟知识。',
      '2. 铜钥匙第1章托管给沈禾、第5章归还陆安，第8章开柜；不能重复获得、凭空换主或把托管当赠送。',
      '3. 十章末仅获得继续寻母线索，未救回母亲、未抓赵伯，不能抢写终局。4. 概要及连续性台账必须来自对应正文，保持猜测、误信、谎言、计划和未知性质；不得把后章事实灌入前章。5. 记忆目录中实际持久化的人物、道具、关系、剧情点等也要对照原文，不能只审核概要而遗漏已采纳实体。引用正文说话人的推测不得写成客观事实。',
      '只报有明确正文依据的矛盾、重复事件、错误记忆，不为字数文风给建议。允许合理的新信息获取、误信转变和有过程的场景变化。',
      '重复事件仅指已完成的取回、首次揭晓等被重置再发生，或恢复导致相同事实被重复追加为多次发生；一般问答重复、叙述冗余和表达润色问题不属于本次污染判定。',
      '严格JSON：{"completed":true,"chaptersChecked":[1,2,3,4,5,6,7,8,9,10],"findings":[{"chapter":数字,"kind":"knowledge|item|mainline|memory|duplicate","quote":"对应章正文或概要的逐字引句","reason":"明确问题及对照章节"}]}。无问题findings=[]。',
      '若提供authorRevisions，它是本轮作者实际保存的草稿修订记录。明确标为草稿历史留档、非当前事实的手工卡片可保留，但不得影响当前正文状态判断；检查其内容是否确有对应旧稿依据，不能仅凭“历史”标签豁免无依据的故事事实。',
      JSON.stringify({ chapters, persistedMemoryFiles: memoryFiles, authorRevisions })].join('\n\n')
    await fs.writeFile(join(root, 'independent-audit-input.txt'), prompt)
    const raw = await llm.generateStream(prompt, { maxTokens: 8192, meta: { feature: 'review' } })
    await fs.writeFile(join(root, 'independent-audit-output.txt'), raw)
    const report = findJsonObject(raw)
    assert(report?.completed === true && Array.isArray(report.chaptersChecked))
    assert.deepEqual([...report.chaptersChecked].sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i + 1))
    assert(Array.isArray(report.findings))
    evidence.independentReview = report
    assert.equal(report.findings.length, 0, JSON.stringify(report.findings))
  })
  await fs.writeFile(join(root, 'audit-report.json'), JSON.stringify({ checks, evidence }, null, 2))
  console.log(JSON.stringify(checks, null, 2))
  app.exit(checks.every(c => c.passed) ? 0 : 1)
}).catch(e => { console.error(e.message); app.exit(1) })
