/** Opt-in live-model integration exercise. Never imported by the unit test suite.
 * Bundle with esbuild --platform=node --external:electron; run using Electron.
 * Reads provider credentials through SecretStore; all novel data is isolated.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import assert from 'node:assert/strict'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import { SettingsRepository } from '../src/main/data/settings-repository'
import { ProjectService } from '../src/main/data/project-service'
import { LibraryRepository } from '../src/main/data/library-repository'
import { WriteService } from '../src/main/data/write-service'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ChapterSummaryRepo } from '../src/main/data/memory/chapter-summary-repo'
import { ProseMemoryIndex, hashProse } from '../src/main/data/memory/prose-memory-index'
import { buildContinuityContext } from '../src/main/data/memory/continuity-context'
import { LongformGuard } from '../src/main/data/longform-guard'
import { markBatchReviewPending, readLongformReviewState } from '../src/main/data/longform-review-state'
import { clearBatchReviewPending } from '../src/main/data/longform-review-state'
import { formatChapterProse } from '../src/shared/format-chapter-prose'
import { parseForeshadowReceipt } from '../src/shared/parsers'
import { createWritingProject } from '../tests/helpers/writing-project'

const root = resolve(process.env.LONGFORM_LIVE_DIR || `scratch/longform-live/run-${Date.now()}`)
const source = process.env.LONGFORM_USER_DATA || join(app.getPath('appData'), 'ai-writer-desktop')
app.setPath('userData', source) // Chromium's existing secure-storage key is needed to decrypt providers.enc.
const results: { name: string; ok: boolean; detail: string; ms: number }[] = []
const calls: { feature: string; chapter?: number; ms: number; chars?: number; error?: string }[] = []
async function scenario(name: string, run: () => Promise<string | void>) {
  console.log(`START ${name}`)
  const at = Date.now()
  try { const detail = await run(); results.push({ name, ok: true, detail: detail || '通过', ms: Date.now() - at }) }
  catch (e) { results.push({ name, ok: false, detail: (e as Error).message, ms: Date.now() - at }) }
  console.log(JSON.stringify(results.at(-1)))
  await fs.writeFile(join(root, 'report.json'), JSON.stringify({ results, calls }, null, 2))
}

async function main() {
  await fs.mkdir(join(root, 'calls'), { recursive: true })
  const secret = new SecretStore(join(source, 'config', 'providers.enc'))
  if (process.env.LONGFORM_LIVE_CHAPTER_PROVIDER === 'active') {
    // Explicit test-only fallback. Never writes the user's feature routing or credentials.
    const stored = await secret.read()
    secret.read = async () => ({ ...stored, featureRouting: { ...stored.featureRouting,
      chapter: { providerId: stored.activeId } } })
  }
  const config = await secret.read()
  await fs.writeFile(join(root, 'models.json'), JSON.stringify({ activeId: config.activeId,
    providers: config.providers.map(({ id, label, model, protocol }) => ({ id, label, model, protocol })),
    featureRouting: config.featureRouting }, null, 2))
  const llm = new LlmService(secret)
  const original = llm.generateStream.bind(llm)
  let interrupt: { feature: string; controller: AbortController } | undefined
  llm.generateStream = async (prompt, opts = {}) => {
    const n = calls.length + 1
    const call = { feature: opts.meta?.feature || 'unknown', chapter: opts.meta?.chapterNumber, ms: 0 } as typeof calls[number]
    calls.push(call)
    const stem = `${String(n).padStart(3, '0')}-${call.feature}`
    await fs.writeFile(join(root, 'calls', `${stem}-input.txt`), `${opts.systemPrompt || ''}\n\n${prompt}`)
    console.log(`MODEL ${n} ${call.feature} chapter=${call.chapter || '-'}`)
    const at = Date.now()
    try {
      const answer = await original(prompt, opts) // Keep the application's feature-specific timeout policy.
      call.chars = answer.length
      await fs.writeFile(join(root, 'calls', `${stem}-output.txt`), answer)
      if (interrupt?.feature === call.feature) { interrupt.controller.abort(); interrupt = undefined }
      return answer
    } catch (e) { call.error = (e as Error).message; throw e }
    finally { call.ms = Date.now() - at; console.log(`MODEL_DONE ${n} ${call.ms}ms ${call.error ? 'ERROR' : call.chars + 'chars'}`) }
  }
  const fixtureRoot = process.env.LONGFORM_LIVE_FIXTURE ? resolve(process.env.LONGFORM_LIVE_FIXTURE) : root
  const settings = new SettingsRepository(join(fixtureRoot, 'settings.json'))
  const projects = new ProjectService(join(fixtureRoot, 'projects'), new LibraryRepository(join(fixtureRoot, 'library.json')), settings)
  const p = process.env.LONGFORM_LIVE_FIXTURE ? (await projects.listProjects())[0] :
    await createWritingProject(projects, { name: '实战长篇隔离测试', genre: '悬疑', targetChapters: 1000, chapterWordCount: 1200 })
  assert(p && p.name === '实战长篇隔离测试' &&
    resolve(p.path).toLowerCase().startsWith((resolve(fixtureRoot, 'projects') + sep).toLowerCase()),
  '只允许操作此脚本在隔离目录内创建的测试项目')
  const dir = p.path, id = p.id
  const makeService = () => new WriteService(projects, llm, undefined, undefined, undefined, settings)
  let service = makeService()
  if (process.env.LONGFORM_LIVE_MEMORY_PRESSURE_ONLY === '1') {
    assert(process.env.LONGFORM_LIVE_FIXTURE, '记忆压力专项必须指定隔离测试项目')
    await scenario('近1400条同角色认知干扰下保留远章关键状态', async () => {
      for (let n = 1; n <= 700; n++) if (n !== 3 && n !== 640) {
        const a = `陆安从货单得知第${n}号粮仓使用${n % 17}号暗记。`
        const b = `陆宁不知道第${n}号粮仓的暗记，还没有看到货单。`
        const prose = `${a}${b}\n${await new ProseRepo(dir).read(n)}`
        await new ProseRepo(dir).write(n, prose)
        await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: n, generatedAt: '',
          sourceHash: hashProse(prose), events: [{ text: `陆安核对第${n}号粮仓暗记。`, evidence: a }], stateChanges: [], openThreads: [], continuity: [
            { kind: 'knowledge', subject: '陆安', object: `第${n}号粮仓暗记`, aspect: '知情程度', value: `已知${n % 17}号暗记，来源货单`, evidence: a },
            { kind: 'knowledge', subject: '陆宁', object: `第${n}号粮仓暗记`, aspect: '知情程度', value: '不知暗记，未看到货单', evidence: b }
          ] })
      }
      const history = (await buildContinuityContext(dir, 701, { text: '陆安陆宁沈禾在北塔找铜钥匙，核对内应身份',
        characters: ['陆安', '陆宁', '沈禾'], aliases: [], props: ['铜钥匙'], includeTrajectory: true })).join('\n')
      await fs.writeFile(join(root, 'history-under-pressure.txt'), history)
      assert.match(history, /陆安 → 内应身份：已知赵伯/)
      assert.match(history, /陆宁 → 内应身份：不知/)
      assert.match(history, /铜钥匙 · 持有者：沈禾/)
      assert.match(history, /超出本次预算/)
      const plan = await fs.readFile(join(dir, '大纲', '大纲.md'), 'utf8')
      await new LongformGuard(llm).check({ chapterNumber: 701, plan, history,
        content: '陆安知道赵伯才是内应，暂时没有告诉陆宁。两人打算先找沈禾取回铜钥匙，再去北塔找账册和母亲线索。' })
      await assert.rejects(new LongformGuard(llm).check({ chapterNumber: 701, plan, history,
        content: '陆宁此前没有收到任何消息，却早已确知赵伯是内应。他没看过密信，仍然准确说出了赵伯的签押细节。' }), /LONGFORM_CONFLICT/)
      return `新增1396条有正文引句的合成干扰认知；上下文${history.length}字符；真实模型对正确稿和泄密稿分别放行、拦截。`
    })
    if (results.some(r => !r.ok)) process.exitCode = 1
    console.log(`REPORT ${root} ${results.filter(r => r.ok).length}/${results.length}`)
    return
  }
  if (process.env.LONGFORM_LIVE_CONTINUATION_ONLY === '1') {
    assert(process.env.LONGFORM_LIVE_FIXTURE, '续写专项必须指定隔离测试项目')
    await scenario('真实模型接续已有半章，保留旧稿且不重复拼接', async () => {
      const generated = (await fs.readdir(join(fixtureRoot, 'calls'))).find(f => /^\d+-chapter-output.txt$/.test(f))
      const body = generated ? formatChapterProse(parseForeshadowReceipt(await fs.readFile(join(fixtureRoot, 'calls', generated), 'utf8')).stripped)
        : await new ProseRepo(dir).read(701)
      assert(body.length > 1200)
      const cut = body.lastIndexOf('\n', Math.floor(body.length * 0.45))
      assert(cut > 400)
      const prefix = body.slice(0, cut)
      await fs.writeFile(join(root, 'original-701.md'), body)
      await fs.writeFile(join(root, 'prefix-701.md'), prefix)
      await new ProseRepo(dir).write(701, prefix)
      const added = await service.generateChapterStream(id, 701, { existingText: prefix, maxTokens: 5000,
        tempContext: '严格从已有正文的最后动作继续，不复述或重写已写内容。陆安知道赵伯是内应，陆宁未获告知，不能突然知情。本轮继续寻找北塔账册和母亲线索，保留原稿所有事件。' })
      const saved = await new ProseRepo(dir).read(701)
      assert(saved.startsWith(prefix), '续写覆盖或改变了只读旧稿')
      assert(added.length > 300, '没有形成实际新增正文')
      assert.equal(saved.split(prefix).length - 1, 1, '旧稿被重复拼接')
      assert(saved.length > prefix.length + 300)
      assert(!(await readLongformReviewState(dir)).pending['701'])
      await fs.writeFile(join(root, 'continued-701.md'), saved)
      return `旧稿${prefix.length}字符保持；新增${added.length}字符，经过真实长篇检查。`
    })
    if (results.some(r => !r.ok)) process.exitCode = 1
    console.log(`REPORT ${root} ${results.filter(r => r.ok).length}/${results.length}`)
    return
  }
  if (process.env.LONGFORM_LIVE_FIXTURE) {
    await scenario('修复后真实重提640章，不能遗漏陆宁不知情', async () => {
      const s = await service.generateChapterSummary(id, 640, await new ProseRepo(dir).read(640), { force: true, requireContinuity: true })
      assert(s.continuity?.some(f => f.kind === 'knowledge' && f.subject === '陆宁' && /不知/.test(f.value)))
      return JSON.stringify(s.continuity)
    })
    const recalled = (await buildContinuityContext(dir, 701, {
      text: '陆安陆宁沈禾内应身份密信铜钥匙', characters: ['陆安', '陆宁'], aliases: [], props: ['铜钥匙']
    })).join('\n')
    const originalPlan = await fs.readFile(join(dir, '大纲', '大纲.md'), 'utf8')
    for (const [name, content, blocked] of [
      ['隐蔽对白泄露未获知秘密须拦截', '陆宁压低声音：“把赵伯亲笔签押的那封密信拿出来，我来对旧账。”陆安怔了一下。陆宁没有解释，径直指出赵伯签押的位置。此前陆宁一直独自在南关，没有收到任何消息。', true],
      ['知情者故意撒谎不误判认知倒退', '陆安明知赵伯才是内应，却不愿让陆宁涉险。他故意撒谎：“船夫就是内应，等我查完再说。”陆宁尚未看到密信，对这番话将信将疑。陆安把签押密信藏好，继续寻找母亲的线索。', false]
    ] as const) await scenario(name, async () => {
      const check = new LongformGuard(llm).check({ chapterNumber: 701, content, plan: originalPlan, history: recalled })
      if (blocked) await assert.rejects(check, /LONGFORM_CONFLICT/)
      else await check
      return '使用修复后的真实提取台账核对，结果符合预期。'
    })
    await scenario('真实检查拒绝冲突稿，旧概要不被覆盖且不发起提取', async () => {
      const repo = new ProseRepo(dir)
      const before = await repo.read(701)
      const previousSummary = await new ChapterSummaryRepo(dir).read(701)
      const bad = '陆宁从来没有收到任何消息，也没有读过密信，却早已确知赵伯才是内应，还准确背出了密信签押的细节。'
      await repo.write(701, bad)
      const count = calls.filter(c => c.feature === 'chapterSummary').length
      try {
        await assert.rejects(service.generateChapterSummary(id, 701, bad, { force: true, requireContinuity: true }), /LONGFORM_CONFLICT/)
        assert.equal(calls.filter(c => c.feature === 'chapterSummary').length, count)
        assert.deepEqual(await new ChapterSummaryRepo(dir).read(701), previousSummary)
        assert((await readLongformReviewState(dir)).pending['701'])
      } finally { await repo.write(701, before) }
      return '真实模型阻断整章；没有进入概要提取，也未覆盖旧概要。'
    })
    const files = await fs.readdir(join(fixtureRoot, 'calls'))
    const generated = files.find(f => /^\d+-chapter-output.txt$/.test(f))
    if (!generated) {
      await scenario('备用真实正文通道生成并在落盘后停止', async () => {
        const stop = new AbortController()
        await assert.rejects(service.generateChapterStream(id, 701, { signal: stop.signal, maxTokens: 5000,
          onProseGenerated: async content => { await new ProseRepo(dir).write(701, content); stop.abort() } }), /ABORT/)
        assert((await new ProseRepo(dir).read(701)).length > 400)
        assert((await readLongformReviewState(dir)).pending['701'])
        return '真实正文已保存，停止后仍被隔离。'
      })
    }
    const body = generated ? formatChapterProse(parseForeshadowReceipt(await fs.readFile(join(fixtureRoot, 'calls', generated), 'utf8')).stripped)
      : await new ProseRepo(dir).read(701)
    assert(body.length > 400, '真实正文未生成，不能用预置短文冒充恢复成功')
    await new ProseRepo(dir).write(701, body)
    await markBatchReviewPending(dir, 701, hashProse(body))
    const stop = new AbortController()
    await scenario('批次恢复在真实记忆提取后中断，保留检查点', async () => {
      interrupt = { feature: 'batchMemory', controller: stop }
      const r = await makeService().resumeChaptersBatch(id, 701, 701, () => {}, null, { signal: stop.signal },
        { fromChapter: 701, total: 1, completed: [701], pendingPostProcessChapter: 701 }, { autoContinue: true })
      assert(stop.signal.aborted, '未到达真实提取阶段，不能算作中断覆盖：' + JSON.stringify(r))
      assert.equal(r.status, 'paused'); assert.equal(r.pendingPostProcessChapter, 701)
      assert((await readLongformReviewState(dir)).batchPending?.['701'])
      assert(!(await new ProseMemoryIndex(dir).readBefore(702)).some(c => c.chapterNumber === 701))
      return JSON.stringify(r)
    })
    await scenario('重启服务后真实补跑批次，正文不重生且检查点完成清除', async () => {
      const before = calls.filter(c => c.feature === 'chapter').length
      const r = await makeService().resumeChaptersBatch(id, 701, 701, () => {}, null, {},
        { fromChapter: 701, total: 1, completed: [701], pendingPostProcessChapter: 701 }, { autoContinue: true })
      assert.equal(r.status, 'completed', JSON.stringify(r))
      assert.equal(calls.filter(c => c.feature === 'chapter').length, before)
      assert.equal(await new ProseRepo(dir).read(701), body)
      assert(!(await readLongformReviewState(dir)).batchPending?.['701'])
      return JSON.stringify(r)
    })
    // Keep unrelated intentionally interrupted chapter 705 quarantined throughout the replay.
    const checkpoint = (await readLongformReviewState(dir)).batchPending?.['705']
    if (checkpoint) await clearBatchReviewPending(dir, 705, checkpoint.token)
    console.log(`REPORT ${root} ${results.filter(r => r.ok).length}/${results.length}`)
    if (results.some(r => !r.ok)) process.exitCode = 1
    return
  }
  const plan = '陆安全书目标是找到失踪母亲并查明内应身份。第900章以前不得救回母亲或完成全书终局。第601至800章寻找北塔账册，不能永久放弃寻母，也不能把经营画铺变为长期主线。'
  await fs.writeFile(join(dir, '大纲', '大纲.md'), `# 实战长篇\n\n## 主线剧情走向\n\n${plan}`)
  const early = '陆安把铜钥匙交给沈禾保管，约好日后到北塔取回。陆安误以为船夫是内应，这只是他自己的错误猜测。陆宁不知道内应是谁，也没有见过任何密信。陆安答应找到母亲，带她回家。'
  const late = '陆安独自拆开赵伯亲笔签押的密信，逐项核对旧账，终于确认赵伯才是内应，先前对船夫的指认是误判。陆宁此时仍在远处的南关，没有收到消息，仍不知道内应是谁。'
  // Generated storage-scale background is explicitly synthetic, not 700 model-written chapters.
  for (let n = 1; n <= 700; n++) {
    const intro = n === 3 ? early : n === 640 ? late : `第${n}日，驿卒在${['南关', '西桥', '河口', '北渡'][n % 4]}核对货单。编号${n}的粮袋按原路入库，修补驿路的人领走工钱。`
    const body = intro + '\n\n' + '驿簿记录沿途的粮价与交班时刻，值守者核完数目，将纸页交回。'.repeat(110).slice(0, 3000 - intro.length - 2)
    await new ProseRepo(dir).write(n, body)
    if (n !== 3 && n !== 640) await new ChapterSummaryRepo(dir).write({ schemaVersion: 1, chapterNumber: n,
      sourceHash: hashProse(body), generatedAt: '', events: [], stateChanges: [], openThreads: [], continuity: [] })
  }
  for (let n = 701; n <= 710; n++) await fs.writeFile(join(dir, '细纲', `细纲_第${n}章_北塔问钥.md`),
    `# 细纲\n\n## 第 ${n} 章：北塔问钥\n\n- **核心事件**：陆安与陆宁在北塔外寻找账册入口，向沈禾询问第3章托管铜钥匙的下落。陆安已经独自确认赵伯身份，陆宁还不知情。本章不揭晓给陆宁，不救回母亲。\n- **字数**：1200字`)
  await scenario('真实模型提取第3章早期状态', async () => {
    const s = await service.generateChapterSummary(id, 3, await new ProseRepo(dir).read(3), { requireContinuity: true })
    assert(s.continuity?.some(f => f.kind === 'knowledge' && f.subject === '陆宁' && /不知/.test(f.value)))
    assert(s.continuity?.some(f => f.kind === 'item' && /沈禾/.test(f.value)))
    return JSON.stringify(s.continuity)
  })
  await scenario('真实模型提取第640章知情反转', async () => {
    const s = await service.generateChapterSummary(id, 640, await new ProseRepo(dir).read(640), { requireContinuity: true })
    assert(s.continuity?.some(f => f.kind === 'knowledge' && f.subject === '陆安' && /赵伯/.test(f.value)))
    assert(s.continuity?.some(f => f.kind === 'knowledge' && f.subject === '陆宁' && /不知/.test(f.value)))
    return JSON.stringify(s.continuity)
  })
  const query = { text: '陆安陆宁在北塔寻找账册，向沈禾询问铜钥匙和内应身份', characters: ['陆安', '陆宁', '沈禾'], aliases: [], props: ['铜钥匙'], includeTrajectory: true }
  const history = (await buildContinuityContext(dir, 701, query)).join('\n')
  await fs.writeFile(join(root, 'history-701.txt'), history)
  await scenario('跨698章召回与旧章回填时间隔离', async () => {
    assert.match(history, /铜钥匙/); assert.match(history, /沈禾/); assert.match(history, /赵伯/)
    const past = (await buildContinuityContext(dir, 500, query)).join('\n')
    assert.match(past, /误|船夫/); assert.doesNotMatch(past, /赵伯/)
    return `第701章上下文${history.length}字符；第500章看不到640章揭晓。`
  })
  const cases = [
    ['人物突然全知必须阻断', '陆宁从未收到消息，也没与任何人谈过内应。可他早已确知赵伯才是内应，直接说出了密信的签押细节。', true],
    ['旧误信不可覆盖最新知情', '陆安心里很清楚赵伯才是内应，先前错怪船夫。他把密信收紧，决定先不让陆宁知道，自己去找沈禾拿铜钥匙。', false],
    ['合理当场告知允许知情变化', '陆安把签押密信递给陆宁，逐字解释旧账。陆宁读完后复述赵伯的签押与账目，终于明白赵伯才是内应。两人商量先拿回沈禾保管的铜钥匙，再进北塔查母亲的线索。', false],
    ['旁白揭晓不可让人物全知', '赵伯正是内应，这是陆宁尚不知晓的真相。陆宁还在猜船夫是否可疑，问陆安能否先去找沈禾取钥匙。陆安暂时没有告诉他密信的内容。', false],
    ['无依据主线替换必须阻断', '陆安毫无缘由地宣布永久放弃寻找母亲，北塔账册也不查了。他今后的唯一长期目标就是经营画铺，此后永不追查内应。', true],
    ['必要休整支线允许通过', '陆安到画铺卖掉一路绘的地图，凑够进北塔的押金。他同陆宁吃了饭，约定天亮就找沈禾取钥匙，母亲的下落仍要追查。', false]
  ] as const
  for (const [name, content, blocked] of cases) await scenario(name, async () => {
    let error = ''
    try { await new LongformGuard(llm).check({ chapterNumber: 701, content, plan, history }) } catch (e) { error = (e as Error).message }
    if (blocked) assert.match(error, /LONGFORM_CONFLICT/)
    else assert.equal(error, '')
    return error || '真实模型完成三项检查并通过'
  })
  // Force a real generation to stop immediately after its raw manuscript has been durably saved.
  const stop = new AbortController()
  await scenario('真实正文生成后中断并持久隔离', async () => {
    let error = ''
    try { await service.generateChapterStream(id, 701, { signal: stop.signal, maxTokens: 5000,
      onProseGenerated: async content => { await new ProseRepo(dir).write(701, content); stop.abort() } }) }
    catch (e) { error = (e as Error).message }
    assert.match(error, /ABORT/)
    assert((await new ProseRepo(dir).read(701)).trim().length > 400)
    assert((await readLongformReviewState(dir)).pending['701'])
    assert(!(await new ProseMemoryIndex(dir).readBefore(702)).some(c => c.chapterNumber === 701))
    return `真实生成${(await new ProseRepo(dir).read(701)).length}字符后停止；正文保存且不能被后章读取。`
  })
  service = makeService() // Drop all WriteService caches to exercise restart behavior.
  await scenario('重建服务仍阻止后章，真实模型补查原稿后解除隔离', async () => {
    await assert.rejects(service.buildChapterPrompt(id, 702), /LONGFORM_HISTORY_PENDING/)
    const before = await new ProseRepo(dir).read(701)
    await service.generateChapterSummary(id, 701, before, { requireContinuity: true })
    assert.equal(await new ProseRepo(dir).read(701), before)
    assert(!(await readLongformReviewState(dir)).pending['701'])
    return '未重新生成正文；真实模型复核及概要提交后恢复可读。此步骤不等于批次全流程完成。'
  })
  await scenario('十章全部完成快捷入口真实核对且不生成正文', async () => {
    const body = '陆安在北塔外核对路线，陆宁站在一旁等候；两人决定继续寻找母亲的线索。'
    for (let n = 701; n <= 710; n++) await new ProseRepo(dir).write(n, body)
    const before = calls.filter(c => c.feature === 'chapter').length
    const r = await makeService().resumeChaptersBatch(id, 701, 710, () => {}, null, {},
      { fromChapter: 701, total: 10, completed: Array.from({ length: 10 }, (_, i) => 701 + i) }, { autoContinue: false })
    assert.equal(r.status, 'completed', JSON.stringify(r))
    assert.equal(calls.filter(c => c.feature === 'chapter').length, before)
    return JSON.stringify(r)
  })
  await scenario('十章恢复不得越过批次未完检查点', async () => {
    await markBatchReviewPending(dir, 705, hashProse(await new ProseRepo(dir).read(705)))
    const r = await makeService().resumeChaptersBatch(id, 701, 710, () => {}, null, {},
      { fromChapter: 701, total: 10, completed: Array.from({ length: 10 }, (_, i) => 701 + i) }, { autoContinue: false })
    assert.equal(r.status, 'paused'); assert.equal(r.pendingPostProcessChapter, 705)
    assert((await readLongformReviewState(dir)).batchPending?.['705'])
    return JSON.stringify(r)
  })
  console.log(`REPORT ${root} ${results.filter(r => r.ok).length}/${results.length}`)
  if (results.some(r => !r.ok)) process.exitCode = 1
}
app.whenReady().then(main).catch(e => { console.error('HARNESS_ERROR', e.message); process.exitCode = 1 })
  .finally(() => { app.exit(Number(process.exitCode) || 0) })
