/** Real-model paired continuation. Frozen fixture; raw responses are never cleaned or repaired. */
import { app } from 'electron'
import { promises as fs, appendFileSync } from 'fs'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { SecretStore } from '../src/main/data/secret-store'
import { LlmService } from '../src/main/data/llm-service'
import type { ProvidersConfig } from '../src/shared/types'

const root = resolve(process.env.CONTINUATION_AB_DIR!)
const userData = join(app.getPath('appData'), 'ai-writer-desktop')
app.setPath('userData', userData)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const event = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  appendFileSync(join(root, 'events.jsonl'), line + '\n')
  console.log(line)
}

async function main() {
  const store = new SecretStore(join(userData, 'config', 'providers.enc'))
  const stored = await store.read()
  const route = stored.featureRouting?.chapter
  const provider = stored.providers.find(p => p.id === (route?.providerId ?? stored.activeId))
  if (!provider) throw new Error('No chapter model configured')
  const chosen = { ...provider, model: route?.model?.trim() || provider.model }
  const metadata = { providerId: chosen.id, providerLabel: chosen.label, protocol: chosen.protocol || 'openai',
    model: chosen.model, configuredTemperature: chosen.temperature ?? null, configuredReasoningEffort: chosen.reasoningEffort ?? null }
  await fs.writeFile(join(root, 'model.json'), JSON.stringify(metadata, null, 2))
  event({ type: 'model', ...metadata })
  if (process.env.CONTINUATION_AB_INVENTORY === '1') return
  if (!chosen.model || chosen.model === 'default') throw new Error('Explicit model name required for a controlled comparison')
  const frozen: ProvidersConfig = { activeId: chosen.id, providers: [chosen], featureRouting: {} }
  store.read = async () => frozen // no provider/config persistence; no credentials in artifacts.
  const llm = new LlmService(store)
  const previous = `十八点四十分，林遥在旧码头等约好的接头人。五分钟前，她已把唯一的铜钥匙交给顾宁，自己只留着封好的信。\n\n戴斗笠的船夫把船系在第三根木桩上，右手虎口有一道旧疤，像她哥哥小时候留下的伤。林遥只看见疤，没有看清他的脸。\n\n“在这儿等，别上船。”顾宁说完，独自进了岸上的值班室。\n\n值班室里，顾宁打开接头人早先留下的另一封便笺，上面写着：今晚接头取消，蓝布包是有人调换的。他把便笺折好，隔着关着的窗看了一眼码头，没有出去，也没有给林遥传话。\n\n林遥听不见屋里的动静，只向船夫问了船钱。她带的钱够付一趟，接头人仍没来。`
  const existing = `十八点四十五分，林遥还站在第三根木桩旁，信封攥在手里。值班室的门关着，顾宁没有出来。\n\n船夫解下一半缆绳，问她走不走。\n\n“再等一会儿，钱照付。”\n\n船夫把绳结重新系牢，坐回船边。林遥又看见他虎口的疤，想起哥哥从前拿刀刻竹哨的样子。\n\n“那道疤，怎么弄的？”\n\n“小时候伤的。”\n\n“我哥也有一道。”\n\n船夫把斗笠往后推了一点，眉眼仍在阴影里。\n\n“你再看看。”`
  const makeCharacter = (id: string, name: string, identity: string, personality: string) => ({ id, name, identity,
    personality, role: '本章人物', createdAt: '', updatedAt: '' })
  const context = {
    projectName: '旧码头', genre: '现实悬疑', mainSynopsis: '林遥追查哥哥失踪的经过，与顾宁合作。本卷保留船夫的身份疑问。',
    chapterNumber: 12, targetWords: 1000, chapterTargetWords: 1400, writtenWords: existing.replace(/\s/g, '').length,
    continueMode: 'extend', prevTail: previous, prevProse: previous, existingText: existing,
    chapterDetail: { chapterNumber: 12, title: '再等一会儿', charactersAppearing: ['林遥', '顾宁', '船夫'],
      plotSummary: '从船夫请她再看的断点接续：林遥辨认但没有充分证据确认身份，顾宁暂不出值班室。她把信留在自己手中，与船夫商量再等五分钟后再决定是否离开，最后坐在木桩旁等候。',
      hook: '林遥坐在第三根木桩旁，船夫仍在船边，平静等待约定的五分钟结束。',
      writingRequirements: '第三人称，保持林遥的限知视角。信封和铜钥匙的持有人延续前文。人物用符合处境的日常口吻交流，不增加调查发现或接头人出场。',
      proseSections: [{ title: '情节点序列', text: '1. 接着“你再看看”写她辨认眼前人，此时身份仍未确认。\n2. 林遥因不愿错过接头人而请求再等五分钟，船夫与她就等待和船钱做简短商量。\n3. 她自己留着信，在第三根木桩旁坐下，船夫留在船边。顾宁本章不出值班室，不与她交流。' }] },
    nextDetail: { chapterNumber: 13, title: '开门之后', plotSummary: '五分钟后顾宁从值班室出来，才告诉林遥接头取消、蓝布包被调换，船夫的身份继续待查。' },
    characters: [makeCharacter('lin', '林遥', '失踪者林峤的妹妹；尚未看清船夫的脸。', '急于找到哥哥，对顾宁信任但会自己判断，眼下不愿错过接头人。'),
      makeCharacter('gu', '顾宁', '同行调查者，独自在值班室读过便笺。', '谨慎，未说出口的消息不会自动成为他人所知。'),
      makeCharacter('boat', '船夫', '作者底稿中的真实姓名是林峤，是林遥失散的哥哥；这是后续待揭晓真相，当下尚未确认。', '寡言，不主动说明身份；此时愿意等候，但也关心自己的船钱。')],
    foreshadowings: [],
    continuityContext: ['# 已有连续性记录（取自上述正文）',
      '[人物认知] 林遥：只怀疑船夫与哥哥有关，未读便笺；顾宁：知道接头取消及蓝布包调换，未向林遥传达。',
      '[道具] 唯一铜钥匙由顾宁持有；封好的信由林遥持有。',
      '[未解决事项] 船夫身份、接头人未到；取消消息尚未传达，不能把计划当作林遥已经知道。'],
    tempContext: '本次完成上述剩余剧情后自然结束，保留本书克制口吻。作者要求以平静等待收束，不增加突发事件、反转或刻意未说完的台词，不用旁白宣布“身份已确定”。'
  }
  const serialized = JSON.stringify(context, null, 2)
  await fs.writeFile(join(root, 'context.json'), serialized)
  const require = createRequire(__filename)
  const prompts: Record<string, { system: string; user: string }> = {}
  for (const variant of ['before', 'after']) {
    const module = require(join(root, `${variant}-prompts.cjs`))
    prompts[variant] = { system: module.buildSystemPrompt(context.genre, null, {}, null, context.continueMode),
      user: module.renderComparisonUserPrompt(structuredClone(context)) }
    await fs.writeFile(join(root, `${variant}-prompt.json`), JSON.stringify(prompts[variant], null, 2))
  }
  const api = ['openai', 'openai-responses', 'anthropic'].includes(chosen.protocol || 'openai')
  const strengthOverride = api ? { temperature: chosen.temperature ?? 0.4 }
    : ['codex', 'claude'].includes(chosen.protocol || '') ? { reasoningEffort: chosen.reasoningEffort ?? 'medium' } : undefined
  await fs.writeFile(join(root, 'experiment.json'), JSON.stringify({ contextSha256: sha(serialized),
    order: ['before-1', 'after-1', 'after-2', 'before-2'], metadata, maxTokens: 8192,
    strengthOverride: strengthOverride ?? null, seed: null, seedExplanation: 'Existing application transport does not expose seed.',
    effectiveOutputCap: chosen.protocol === 'codex' ? 'Codex CLI does not forward maxTokens; provider-managed output cap, identical route for all calls.' : 'Transport-specific handling of requested maxTokens.',
    scope: 'Actual prompt assembly and real first-pass generation; no model-based extraction, cleanup, repair, or output selection. Context supplied identically to both renderers.' }, null, 2))
  // CLI calls inherit a fresh empty cwd so repository instructions cannot contaminate either arm.
  process.chdir(await fs.mkdtemp(join(tmpdir(), 'dscb-continuation-ab-')))
  for (const name of ['before-1', 'after-1', 'after-2', 'before-2']) {
    const variant = name.split('-')[0]
    const prompt = prompts[variant]
    const started = Date.now()
    event({ type: 'start', name, contextSha256: sha(serialized), systemSha256: sha(prompt.system), userSha256: sha(prompt.user) })
    try {
      const answer = await llm.generateStream(prompt.user, { systemPrompt: prompt.system, maxTokens: 8192,
        meta: { feature: 'chapter' }, strengthOverride,
        onToken: token => appendFileSync(join(root, `${name}-stream.txt`), token),
        onStatus: status => event({ type: 'status', name, status }),
        onDiagnostic: diagnostic => event({ type: 'diagnostic', name, diagnostic }) })
      await fs.writeFile(join(root, `${name}-raw.txt`), answer)
      event({ type: 'completed', name, ms: Date.now() - started, chars: answer.length, outputSha256: sha(answer) })
    } catch (error) {
      event({ type: 'failed', name, ms: Date.now() - started, error: (error as Error).message })
      throw error
    }
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch(async error => {
  event({ type: 'fatal', error: (error as Error).message })
  app.exit(1)
})
